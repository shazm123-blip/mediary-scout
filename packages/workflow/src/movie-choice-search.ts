import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { MediaTitle, ResourceCandidate, ResourceSnapshot } from "./domain.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import { rankMovieCandidates, type RankedMovieCandidate } from "./movie-quality-policy.js";
import { JevPrefilterProvider } from "./jev-prefilter-provider.js";
import type { JevJudge } from "./jev-judge.js";
import { getSearchRecipe } from "./acquisition-v2/search-profile.js";
import type { AgentMemoryStore } from "./agent-memory.js";
import { isBrandStorageAuthError } from "./storage-auth-error.js";

/** Search-only AI turn. Its toolset has no StorageExecutor, so it cannot create
 * directories, transfer files, or otherwise mutate a cloud drive. */
export async function findMovieChoices(input: {
  title: MediaTitle;
  provider: ResourceProvider;
  model: LanguageModel;
  workflowRunId: string;
  jevJudge?: JevJudge;
  preferredLanguage?: string;
  memory?: { store: AgentMemoryStore; accountId: string; drive?: string };
  requestContext?: string[];
}): Promise<{ resourceSnapshots: ResourceSnapshot[]; candidates: RankedMovieCandidate[] }> {
  const snapshots: ResourceSnapshot[] = [];
  const seen = new Map<string, ResourceCandidate>();
  const selected = new Set<string>();
  let didSubmit = false;
  let searchFailed = false;
  const provider = input.jevJudge
    ? new JevPrefilterProvider({ inner: input.provider, target: { kind: "movie", title: input.title.title, aliases: input.title.aliases, year: input.title.year }, judge: input.jevJudge })
    : input.provider;
  const search = async (keyword: string) => {
    let snapshot: ResourceSnapshot | undefined;
    // Keep the existing movie recipe's same-keyword retries for PanSou's flaky 0.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      snapshot = await provider.search({ keyword, workflowRunId: input.workflowRunId }).catch((error: unknown) => {
        searchFailed = true;
        throw error;
      });
      if (snapshots.some((stored) => stored.id === snapshot!.id)) {
        const id = `${snapshot.id}_choice_${snapshots.length}`;
        snapshot = { ...snapshot, id, candidates: snapshot.candidates.map((candidate) => ({ ...candidate, snapshotId: id })) };
      }
      snapshots.push(snapshot);
      if (snapshot.candidates.length > 0) break;
    }
    if (!snapshot) return [];
    for (const candidate of snapshot.candidates) seen.set(candidate.id, candidate);
    return rankMovieCandidates(snapshot.candidates).map(({ id, title, tier, qualityLabel, dolbyVision, atmos }) =>
      ({ id, title, tier, qualityLabel, dolbyVision, atmos }));
  };
  // The raw Chinese name is the established best-recall search. Failed first
  // searches still leave the AI able to try a known alias via its search tool.
  let initial: Awaited<ReturnType<typeof search>> = [];
  try { initial = await search(input.title.title); } catch { /* AI may retry with an alias. */ }
  const memories = input.memory ? (await Promise.all([
    input.memory.store.listAgentMemories({ accountId: input.memory.accountId, scope: "title", titleKey: input.title.id }),
    input.memory.store.listAgentMemories({ accountId: input.memory.accountId, scope: "global" }),
  ])).flat().filter((item) => !item.provider || item.provider === input.memory!.drive)
    .slice(0, 16).map((item) => `${item.kind}: ${item.description} — ${item.body.slice(0, 300)}`) : [];
  await generateText({
    model: input.model,
    system: "你负责为用户寻找同一部电影的候选资源，只能调用只读搜索工具。核对片名、年份、续集、翻拍；误匹配不可提交。保留六档候选：1 BD ISO 4K、2 BD REMUX 4K、3 普通 4K、4 BD ISO 1080P、5 BD REMUX 1080P、6 普通 1080P；画质不明但属于本片的候选也保留，标待确认并排六档后。同档杜比视界+Atmos优先。排除 BDMV。不得转存、建目录或捏造候选。已预搜裸片名；结果不足时可搜别名、原名、年份消歧，但不要把画质词放进搜索词。最后调用 submitCandidates，提交所有确认是本片的候选 ID，供用户自己选择；空列表表示明确不收录。\n" + getSearchRecipe("movie"),
    prompt: JSON.stringify({ title: input.title.title, originalTitle: input.title.originalTitle, year: input.title.year,
      aliases: input.title.aliases, preferredLanguage: input.preferredLanguage, priorExperience: memories,
      userReplacementRequest: input.requestContext, initialCandidates: initial }),
    tools: {
      searchResources: tool({
        description: "用一个片名或别名重新搜索，返回已分档和画质待确认的候选。只读。",
        inputSchema: z.object({ keyword: z.string().min(1).max(120) }),
        execute: async ({ keyword }) => search(keyword),
      }),
      submitCandidates: tool({
        description: "提交确认属于目标电影的所有候选 ID；用户稍后亲自选一个。",
        inputSchema: z.object({ candidateIds: z.array(z.string()).max(5000) }),
        execute: async ({ candidateIds }) => {
          didSubmit = true;
          selected.clear();
          for (const id of candidateIds) if (seen.has(id)) selected.add(id);
          return { accepted: selected.size };
        },
      }),
    },
    stopWhen: stepCountIs(8),
  });
  const fallback = !didSubmit ? [...seen.values()].filter((candidate) => matchesMovieIdentityForFallback(input.title, candidate)) : [];
  const ranked = rankMovieCandidates(didSubmit
    ? [...seen.values()].filter((candidate) => selected.has(candidate.id)) : fallback)
    .map((candidate) => didSubmit ? candidate : { ...candidate, identityPending: true,
      recommendation: `${candidate.recommendation}；AI 未提交确认，片名和年份线索相符，请人工核对` });
  if (ranked.length === 0 &&
      (searchFailed || snapshots.length === 0 || snapshots.some((snapshot) =>
        snapshot.sourceHealth && snapshot.sourceHealth.status !== "healthy"))) {
    throw new Error("MOVIE_SEARCH_SOURCE_INCOMPLETE");
  }
  return { resourceSnapshots: snapshots, candidates: ranked };
}

/** Recovery only when the model never submits: exact title prefix then the TMDB
 * year, with no intervening sequel/subtitle. Ambiguous releases stay out. */
export function matchesMovieIdentityForFallback(title: MediaTitle, candidate: ResourceCandidate): boolean {
  const published = candidate.title.normalize("NFKC").replace(/^(?:\s*\[[^\]]{1,30}\])+\s*/, "");
  const normalized = normalizeMovieIdentity(published);
  const years = normalized.match(/(?:^| )(?:19|20)\d{2}(?= |$)/g)?.map((year) => year.trim()) ?? [];
  if (years.length !== 1 || years[0] !== String(title.year)) return false;
  return [title.title, title.originalTitle, ...title.aliases].some((name) => {
    const alias = normalizeMovieIdentity(name);
    if (alias.length < 2 || !normalized.startsWith(`${alias} `)) return false;
    return normalized.slice(alias.length).trimStart().startsWith(`${title.year} `) ||
      normalized.slice(alias.length).trimStart() === String(title.year);
  });
}

function normalizeMovieIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Exposes exactly the persisted approved candidate to the ordinary AI acquisition
 * loop, regardless of what keywords it asks for. The full payload stays server-side. */
export function chosenMovieProvider(snapshots: readonly ResourceSnapshot[], chosenId: string): ResourceProvider {
  const original = snapshots.find((snapshot) => snapshot.candidates.some((candidate) => candidate.id === chosenId));
  const candidate = original?.candidates.find((item) => item.id === chosenId);
  if (!original || !candidate) throw new Error("CHOSEN_MOVIE_CANDIDATE_MISSING");
  return {
    search: async () => ({ ...original, candidates: [candidate] }),
  };
}

/** ISO is a movie asset only in a user-chosen run. Existing executors classify
 * video by extension; this wrapper gives the same verified-file shape for ISO
 * without changing TV/anime or automatic movie behavior. */
export function storageForChosenIso(executor: StorageExecutor): StorageExecutor {
  const isoFiles = async (directoryId: string) => (await executor.listTree({ directoryId }))
    .filter((file) => /\.iso$/i.test(file.path) && !/(?:^|\/)BDMV(?:\/|$)/i.test(file.path));
  return {
    ...executor,
    createDirectory: (input) => executor.createDirectory(input),
    listVideoFiles: async (directoryId) => {
      const regular = await executor.listVideoFiles(directoryId);
      const iso = await isoFiles(directoryId);
      return [...regular, ...iso.map((file) => ({
        id: file.providerFileId,
        providerFileId: file.providerFileId,
        name: file.path.split("/").at(-1)!,
        storageDirectoryId: directoryId,
        sizeBytes: file.sizeBytes,
        episodeCode: null,
      }))];
    },
    transfer: async (input) => {
      const before = new Set((await isoFiles(input.directoryId)).map((file) => file.providerFileId));
      const attempt = await executor.transfer(input);
      if (attempt.status !== "no_target_change") return attempt;
      const landed = (await isoFiles(input.directoryId)).filter((file) => !before.has(file.providerFileId));
      return landed.length > 0
        ? { ...attempt, status: "succeeded", materializedFileIds: landed.map((file) => file.providerFileId) }
        : attempt;
    },
    listUnparsedVideoFiles: (id) => executor.listUnparsedVideoFiles(id),
    renameFile: (input) => executor.renameFile(input),
    flattenDirectory: (id) => executor.flattenDirectory(id),
    deleteFiles: (input) => executor.deleteFiles(input),
    removeDirectory: (id) => executor.removeDirectory(id),
    listTree: (input) => executor.listTree(input),
    listSubdirectories: (input) => executor.listSubdirectories(input),
    listChildDirectories: (id) => executor.listChildDirectories(id),
    moveFiles: (input) => executor.moveFiles(input),
    ...(executor.apiCallCount ? { apiCallCount: () => executor.apiCallCount!() } : {}),
    ...(executor.apiCallBudget ? { apiCallBudget: () => executor.apiCallBudget!() } : {}),
    ...(executor.withCleanupBudget ? { withCleanupBudget: <T>(fn: () => Promise<T>) => executor.withCleanupBudget!(fn) } : {}),
    ...(executor.transferSubtitleUrl ? { transferSubtitleUrl: (input: Parameters<NonNullable<StorageExecutor["transferSubtitleUrl"]>>[0]) => executor.transferSubtitleUrl!(input) } : {}),
    ...(executor.transferSubtitleUrls ? { transferSubtitleUrls: (input: Parameters<NonNullable<StorageExecutor["transferSubtitleUrls"]>>[0]) => executor.transferSubtitleUrls!(input) } : {}),
  };
}

/** The AI SDK can turn a tool exception into model-visible tool evidence.
 * Capture a netdisk auth exception before that conversion so the worker still
 * freezes the drive, rather than misreporting a dead share. */
export function captureMovieStorageAuth(executor: StorageExecutor): { storage: StorageExecutor; authError: () => unknown; bdmvDetected: () => boolean } {
  let captured: unknown;
  let bdmv = false;
  let baseline: Set<string> | null = null;
  const storage = new Proxy(executor, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (bdmv && (property === "moveFiles" || property === "flattenDirectory")) {
          throw new Error("CHOSEN_MOVIE_BDMV: refusing to flatten a BDMV package");
        }
        try {
          const result: unknown = member.apply(target, args);
          return result instanceof Promise ? result.then((value: unknown) => {
            if (property === "listTree" && Array.isArray(value)) {
              if (!baseline) baseline = new Set(value.map((file) => file.providerFileId));
              else if (value.some((file) => !baseline!.has(file.providerFileId) && /(?:^|\/)BDMV(?:\/|$)/i.test(file.path))) bdmv = true;
            }
            return value;
          }).catch((error: unknown) => {
            if (isBrandStorageAuthError(error)) captured = error;
            throw error;
          }) : result;
        } catch (error) {
          if (isBrandStorageAuthError(error)) captured = error;
          throw error;
        }
      };
    },
  });
  return { storage, authError: () => captured, bdmvDetected: () => bdmv };
}
