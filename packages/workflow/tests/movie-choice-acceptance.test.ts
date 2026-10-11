import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import pg from "pg";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { createSqliteWorkflowRepository } from "../src/sqlite.js";
import { createPostgresWorkflowRepositorySync } from "../src/postgres.js";
import { findMovieChoices, chosenMovieProvider } from "../src/movie-choice-search.js";
import { compareMovieUpgrade, rankMovieCandidates } from "../src/movie-quality-policy.js";
import { queueMovieUpgrade } from "../src/commands.js";
import { mediaLibraryFolderName } from "../src/media-library-folder.js";
import { legacyMediaLibraryFolderName } from "../src/media-library-folder.js";
import { Pan115AuthError } from "../src/pan115-cookie-client.js";
import { Pan115CookieClient } from "../src/pan115-cookie-client.js";
import { inspectShareTree, preflightChosenMovieSource } from "../src/movie-share-preflight.js";
import { queueReplaceRequest, runQueuedReplaceRequest } from "../src/replace-request.js";
import { runQueuedMovieAcquisition, runScheduledType3Monitoring } from "../src/worker.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { isStaleActiveWorkflowRun } from "../src/repository.js";
import type { MediaTitle, ResourceCandidate, ResourceSnapshot } from "../src/domain.js";
import type { WorkflowRepository } from "../src/repository.js";
import type { StorageExecutor } from "../src/ports.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";

const NOW = "2026-10-11T00:00:00.000Z";
const scope = { accountId: "acct_choice", connectedStorageId: "drive_115" };
const title: MediaTitle = { id: "tmdb_movie_900001", tmdbId: 900001, type: "movie", title: "测试电影", originalTitle: "Test Film", year: 2025, aliases: ["Test Film"] };
const usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};
function toolCall(name: string, input: unknown, id: string) {
  return { content: [{ type: "tool-call" as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage, warnings: [] };
}
function finalText() {
  return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage, warnings: [] };
}
function candidate(id: string, release: string): ResourceCandidate {
  return { id, snapshotId: "snap_1", index: 0, title: `测试电影 2025 ${release}`, type: "115", source: "PanSou", providerPayload: { shareUrl: `offline://${id}` } };
}
const rows = [
  candidate("ordinary1080", "1080p WEB"),
  candidate("remux1080", "1080p BD REMUX"),
  candidate("iso1080", "1080p BD ISO"),
  candidate("ordinary4k", "2160p WEB"),
  candidate("remux4k", "2160p BD REMUX"),
  candidate("iso4k", "2160p BD ISO"),
  candidate("dv_atmos", "2160p BD REMUX DoVi Atmos"),
  candidate("bdmv", "2160p BD ISO BDMV"),
];
const snapshot: ResourceSnapshot = { id: "snap_1", provider: "offline", keyword: title.title, candidates: rows, createdAt: NOW };

function runningFixture() {
  const base = workflowPersistenceFixture();
  return {
    ...base,
    accountId: scope.accountId,
    connectedStorageId: scope.connectedStorageId,
    title,
    season: { ...base.season, id: "movie_season", mediaTitleId: title.id, seasonNumber: 0, totalEpisodes: 1, latestAiredEpisode: 1, storageDirectoryId: "" },
    workflowRun: { ...base.workflowRun, id: "movie_run", kind: "movie_init" as const, status: "running" as const, trackedSeasonId: "movie_season", startedAt: NOW, finishedAt: null },
    episodes: [], resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [],
  };
}

async function assertAwaitingMessageSurvivesOrphanSweep(repo: WorkflowRepository) {
  const base = runningFixture();
  const runId = "waiting_replace_run";
  const seasonId = "waiting_replace_season";
  await repo.saveWorkflowRunSnapshot({ ...base,
    season: { ...base.season, id: seasonId },
    workflowRun: { ...base.workflowRun, id: runId, kind: "replace_request", status: "awaiting_choice", trackedSeasonId: seasonId, startedAt: NOW },
  });
  const work = { accountId: scope.accountId, drive: scope.connectedStorageId, titleKey: title.id };
  const orphan = { ...work, titleKey: "tmdb_movie_orphan" };
  await repo.createUserMessage({ ...work, body: "待选电影留言", episodeTags: [], now: NOW });
  await repo.createUserMessage({ ...orphan, body: "孤儿对照", episodeTags: [], now: NOW });
  expect((await repo.claimUserMessages({ ...work, runId, now: NOW })).map((item) => item.status)).toEqual(["processing"]);
  expect((await repo.claimUserMessages({ ...orphan, runId: "missing_run", now: NOW })).map((item) => item.status)).toEqual(["processing"]);
  expect(await repo.releaseOrphanedUserMessages({ now: "2026-10-11T00:11:00.000Z", finishedBefore: "2026-10-11T00:01:00.000Z" })).toBe(1);
  expect((await repo.listUserMessages(work))[0]).toMatchObject({ status: "processing", runId, body: "待选电影留言" });
  expect((await repo.listUserMessages(orphan))[0]).toMatchObject({ status: "pending", runId: null });
}

async function assertRestartMovieChoiceSearchCAS(repo: WorkflowRepository) {
  const workflowRunId = "movie_restart_run";
  const base = runningFixture();
  await repo.saveWorkflowRunSnapshot({ ...base, workflowRun: { ...base.workflowRun, id: workflowRunId } });
  expect(await repo.publishMovieChoices({ workflowRunId, scope, resourceSnapshots: [snapshot], candidates: rankMovieCandidates(rows) })).toBe(true);
  expect(await repo.restartMovieChoiceSearch({ workflowRunId, scope: { ...scope, accountId: "other" } })).toBe(false);
  const results = await Promise.all([
    repo.restartMovieChoiceSearch({ workflowRunId, scope }),
    repo.restartMovieChoiceSearch({ workflowRunId, scope }),
  ]);
  expect(results.sort()).toEqual([false, true]);
  const queued = await repo.getWorkflowRunSnapshot(workflowRunId, scope);
  expect(queued?.workflowRun.status).toBe("queued");
  expect(queued?.workflowRun.movieChoices).toBeUndefined();
  expect(queued?.resourceSnapshots).toEqual([]);
  expect(await repo.chooseMovieCandidate({ workflowRunId, candidateId: "iso4k", scope })).toBe("unavailable");
  expect(await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW })).toMatchObject({ workflowRun: { id: workflowRunId, status: "running" } });
}

async function runRejectedChosenPreflight(input: {
  inspect?: StorageExecutor["inspectCandidateShare"];
  candidateId?: string;
  repository?: WorkflowRepository;
}) {
  const repo = input.repository ?? new InMemoryWorkflowRepository();
  const chosenId = input.candidateId ?? "iso4k";
  const selected = chosenId === "magnet_iso" ? { ...candidate("magnet_iso", "2160p BD ISO"), type: "magnet" as const,
    providerPayload: { url: "magnet:?xt=urn:btih:offline" } } : rows.find((row) => row.id === chosenId)!;
  const source: ResourceSnapshot = { ...snapshot, candidates: [selected] };
  const base = runningFixture();
  await repo.saveWorkflowRunSnapshot({ ...base, workflowRun: { ...base.workflowRun, status: "queued", movieChoiceMode: "blu-ray-iso" } });
  await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW });
  const ranked = rankMovieCandidates([selected]);
  expect(await repo.publishMovieChoices({ workflowRunId: "movie_run", scope, resourceSnapshots: [source], candidates: ranked })).toBe(true);
  expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: chosenId, scope })).toBe("chosen");
  class GuardedStorage extends FakeStorageExecutor {
    readonly writes: string[] = [];
    override async createDirectory(value: Parameters<FakeStorageExecutor["createDirectory"]>[0]) {
      this.writes.push("createDirectory");
      return super.createDirectory(value);
    }
    override async transfer(value: Parameters<FakeStorageExecutor["transfer"]>[0]) {
      this.writes.push("transfer");
      return super.transfer(value);
    }
  }
  const storage = new GuardedStorage();
  if (input.inspect) Object.assign(storage, { inspectCandidateShare: input.inspect });
  const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("AI should not run before rejected share-tree preflight"); } });
  const result = await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => { throw new Error("provider should not run"); } }, storage, model, moviesParentDirectoryId: "movies", now: () => NOW });
  return { repo, storage, result, saved: await repo.getWorkflowRunSnapshot("movie_run", scope), chosenId };
}

async function seededUpgrade(verifiedFileIds: string[] = ["old_video"],
  transferOutcomes: NonNullable<ConstructorParameters<typeof FakeStorageExecutor>[0]>["transferOutcomes"] = {}, failDelete = false,
  legacyFirst = false, queueUpgrade = true) {
  const repo = new InMemoryWorkflowRepository();
  class UpgradeStorage extends FakeStorageExecutor {
    readonly deletions: string[][] = [];
    readonly oldPresentImmediatelyAfterTransfer: boolean[] = [];
    async inspectCandidateShare() { return { files: ["fixture-independent-verified-remux.mkv"], directories: [] }; }
    override async transfer(input: Parameters<FakeStorageExecutor["transfer"]>[0]) {
      const result = await super.transfer(input);
      const ids = new Set((await this.listTree({ directoryId: input.directoryId })).map((file) => file.providerFileId));
      this.oldPresentImmediatelyAfterTransfer.push(ids.has("old_video") && ids.has("old_sub"));
      return result;
    }
    override async deleteFiles(input: Parameters<FakeStorageExecutor["deleteFiles"]>[0]) {
      this.deletions.push(input.fileIds);
      if (failDelete) throw new Error("offline fixture: delete failed");
      return super.deleteFiles(input);
    }
  }
  const storage = new UpgradeStorage({ transferOutcomes });
  if (legacyFirst) await storage.createDirectory({ name: legacyMediaLibraryFolderName(title), parentId: "movies" });
  const movieDir = await storage.createDirectory({ name: mediaLibraryFolderName(title), parentId: "movies" });
  const names = [
    ["old_video", "测试电影.2025.1080p.WEB.mkv"],
    ["old_sub", "测试电影.2025.1080p.WEB.zh.srt"],
    ["other_sub", "测试电影.2025.1080p.WEB2.zh.srt"],
    ["other_file", "unrelated.srt"],
  ] as const;
  storage.seedDirectoryFiles(movieDir, names.map(([id, name]) => ({
    id, providerFileId: id, storageDirectoryId: movieDir, name, sizeBytes: id === "old_video" ? 8_000_000_000 : 4_000_000, episodeCode: null,
  })));
  const base = runningFixture();
  const seasonId = `${title.id}_movie`;
  await repo.saveWorkflowRunSnapshot({ ...base,
    season: { ...base.season, id: seasonId, storageDirectoryId: movieDir },
    workflowRun: { ...base.workflowRun, id: "prior_run", trackedSeasonId: seasonId, status: "succeeded", finishedAt: NOW },
    episodes: [{ trackedSeasonId: seasonId, episodeCode: "S01E01", airDate: null, title: title.title, airStatus: "aired", obtained: true, metadataStatus: "confirmed", verifiedFileIds }],
  });
  if (queueUpgrade) {
    const state = await repo.getTrackedSeasonState(seasonId, scope);
    expect(state).not.toBeNull();
    expect(await queueMovieUpgrade({ state: state!, repository: repo, createWorkflowRunId: () => "upgrade_run", now: () => NOW })).toMatchObject({ status: "queued", workflowRunId: "upgrade_run" });
  }
  return { repo, storage, movieDir };
}

async function collectUpgradeChoices(repo: InMemoryWorkflowRepository, storage: FakeStorageExecutor) {
  let turn = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => ++turn === 1
    ? toolCall("submitCandidates", { candidateIds: rows.map((r) => r.id) }, "submit") : finalText() });
  return runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => snapshot }, storage, model, moviesParentDirectoryId: "movies", now: () => NOW });
}

function selectedTransferModel() {
  const steps = [
    ["searchResources", { keyword: title.title }],
    ["transferCandidate", { snapshotId: "s1", candidateId: "s1-1" }],
    ["inspectTargetDir", {}],
    ["markObtained", { codes: ["MOVIE"] }],
    ["finish", {}],
  ] as const;
  let turn = 0;
  return new MockLanguageModelV3({ doGenerate: async () => {
    const step = steps[turn++];
    return step ? toolCall(step[0], step[1], `step_${turn}`) : finalText();
  } });
}

async function executeSelectedUpgrade(repo: InMemoryWorkflowRepository, storage: FakeStorageExecutor, candidateId = "remux4k",
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>) {
  expect(await collectUpgradeChoices(repo, storage)).toMatchObject({ workflowStatus: "awaiting_choice" });
  expect(await repo.chooseMovieCandidate({ workflowRunId: "upgrade_run", candidateId, scope })).toBe("chosen");
  return runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => { throw new Error("must use chosen source"); } }, storage, model: selectedTransferModel(), moviesParentDirectoryId: "movies", now: () => NOW,
    ...(onAuthErrorFreeze ? { onAuthErrorFreeze } : {}) });
}

describe("movie choice independent acceptance", () => {
  it("AC20: 115 paginated share tree exposes deep BDMV and rejects the mixed ISO package", async () => {
    const pages: Record<string, Array<Record<string, unknown>>> = {
      "": [{ fc: 1, fid: "iso", n: "Film.iso" }, { fc: 1, fid: "readme", n: "README.txt" }, { fc: 0, cid: "extras", n: "Extras" }],
      extras: [{ fc: 0, cid: "nested", n: "More" }],
      nested: [{ fc: 0, cid: "bdmv", n: "BDMV" }],
      bdmv: [{ fc: 1, fid: "index", n: "index.bdmv" }],
    };
    const visited: string[] = [];
    const client = new Pan115CookieClient({ cookie: "offline-fixture", listLimit: 2, listPageDelayMs: 0,
      fetchJson: async (url) => {
        const parsed = new URL(url);
        const cid = parsed.searchParams.get("cid") ?? "";
        const offset = Number(parsed.searchParams.get("offset"));
        visited.push(`${cid}:${offset}`);
        return { state: true, data: { count: pages[cid]?.length ?? 0, list: (pages[cid] ?? []).slice(offset, offset + 2) } };
      },
    });
    const tree = await inspectShareTree((directoryId) => client.listShareFiles({ shareCode: "fixture", receiveCode: "", directoryId }), "");
    expect(visited).toContain(":2");
    expect(tree.files).toContain("Film.iso");
    expect(tree.directories).toContain("Extras/More/BDMV");
    await expect(preflightChosenMovieSource({ storage: { inspectCandidateShare: async () => tree } as unknown as StorageExecutor,
      candidate: candidate("iso4k", "2160p BD ISO"), expectIso: true })).rejects.toThrow("MOVIE_SHARE_PREFLIGHT_BDMV");
  });

  it("AC20: 115 share count mismatch fails closed instead of accepting a partial tree", async () => {
    const client = new Pan115CookieClient({ cookie: "offline-fixture", listLimit: 2, listPageDelayMs: 0,
      fetchJson: async (url) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        return { state: true, data: { count: 3, list: offset === 0
          ? [{ fc: 1, fid: "iso", n: "Film.iso" }, { fc: 1, fid: "readme", n: "README.txt" }] : [] } };
      },
    });
    await expect(client.listShareFiles({ shareCode: "fixture", receiveCode: "", directoryId: "" })).rejects.toThrow("PAN115_SHARE_PREFLIGHT_INCOMPLETE");
  });

  for (const [label, inspect, reason] of [
    ["BDMV directory", async () => ({ files: ["Disc.iso", "BDMV/STREAM/00001.m2ts"], directories: ["BDMV", "BDMV/STREAM"] }), /BDMV/],
    ["mixed ISO and BDMV package", async () => ({ files: ["Disc.iso", "Extra/BDMV/index.bdmv"], directories: ["Extra", "Extra/BDMV"] }), /BDMV/],
    ["incomplete deep tree", async () => { throw new Error("MOVIE_SHARE_PREFLIGHT_INCOMPLETE"); }, /无法完整核验/],
  ] as const) {
    it(`AC21: ${label} is blocked before directory creation and transfer`, async () => {
      const { storage, result, saved, chosenId } = await runRejectedChosenPreflight({ inspect });
      expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
      expect(storage.writes).toEqual([]);
      expect(saved?.workflowRun.movieChoices?.chosenId).toBeUndefined();
      expect(saved?.workflowRun.movieChoices?.lastFailure).toMatchObject({ candidateId: chosenId, reason: expect.stringMatching(reason) });
    });
  }

  it("AC21: unsupported or magnet source fails closed before any cloud write", async () => {
    const unsupported = await runRejectedChosenPreflight({});
    expect(unsupported.result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(unsupported.storage.writes).toEqual([]);
    expect(unsupported.saved?.workflowRun.movieChoices?.lastFailure).toMatchObject({ candidateId: "iso4k", reason: expect.stringMatching(/不支持/) });
    const magnet = await runRejectedChosenPreflight({ candidateId: "magnet_iso", inspect: async () => { throw new Error("MOVIE_SHARE_PREFLIGHT_UNSUPPORTED"); } });
    expect(magnet.result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(magnet.storage.writes).toEqual([]);
    expect(magnet.saved?.workflowRun.movieChoices?.lastFailure).toMatchObject({ candidateId: "magnet_iso", reason: expect.stringMatching(/不支持/) });
  });

  it("AC21: rejected share-tree reason remains visible after SQLite restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "movie-choice-preflight-"));
    const path = join(dir, "workflow.sqlite");
    try {
      const first = createSqliteWorkflowRepository({ path });
      const rejected = await runRejectedChosenPreflight({ repository: first,
        inspect: async () => ({ files: ["Film.iso", "BDMV/index.bdmv"], directories: ["BDMV"] }) });
      expect(rejected.storage.writes).toEqual([]);
      first.close();
      const reopened = createSqliteWorkflowRepository({ path });
      try {
        const saved = await reopened.getWorkflowRunSnapshot("movie_run", scope);
        expect(saved?.workflowRun.status).toBe("awaiting_choice");
        expect(saved?.workflowRun.movieChoices?.lastFailure).toMatchObject({ candidateId: "iso4k", reason: expect.stringMatching(/BDMV/) });
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("AC10: upgrade comparisons keep unknown incomparable and single DV/Atmos equal", () => {
    const current = [{ tier: 3 as const, dolbyVision: true, atmos: false }];
    expect(compareMovieUpgrade({ tier: 3, dolbyVision: false, atmos: true }, current)).toBe("not_better");
    expect(compareMovieUpgrade({ tier: 3, dolbyVision: true, atmos: true }, current)).toBe("better");
    expect(compareMovieUpgrade({ tier: 2, dolbyVision: false, atmos: false }, current)).toBe("better");
    expect(compareMovieUpgrade({ tier: 4, dolbyVision: true, atmos: true }, current)).toBe("not_better");
    expect(compareMovieUpgrade({ tier: 1, dolbyVision: true, atmos: true }, [{ tier: null, dolbyVision: false, atmos: false }])).toBe("incomparable");
    expect(rankMovieCandidates([
      candidate("atmos_only", "2160p WEB Atmos"),
      candidate("dv_only", "2160p WEB DoVi"),
    ]).map((r) => r.id)).toEqual(["atmos_only", "dv_only"]);
  });

  it("AC11: upgrade search preserves old assets and locks only exact old video/subtitle IDs", async () => {
    const { repo, storage, movieDir } = await seededUpgrade();
    const result = await collectUpgradeChoices(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    const waiting = await repo.getWorkflowRunSnapshot("upgrade_run", scope);
    expect(waiting?.workflowRun.movieUpgrade?.oldFiles?.map((file) => file.id)).toEqual(["old_video", "old_sub"]);
    expect(waiting?.workflowRun.movieUpgrade?.currentAssets).toMatchObject([{ tier: 6 }]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toEqual(["old_video", "old_sub", "other_sub", "other_file"]);
    expect(waiting?.episodes[0]?.verifiedFileIds).toEqual(["old_video"]);
  });

  it("AC11: canonical folder wins when canonical and legacy movie folders coexist", async () => {
    const { repo, storage, movieDir } = await seededUpgrade(["old_video"], {}, false, true);
    expect(await collectUpgradeChoices(repo, storage)).toMatchObject({ workflowStatus: "awaiting_choice" });
    const waiting = await repo.getWorkflowRunSnapshot("upgrade_run", scope);
    expect(waiting?.workflowRun.movieUpgrade?.directoryId).toBe(movieDir);
    expect(waiting?.workflowRun.movieUpgrade?.oldFiles?.map((file) => file.id)).toEqual(["old_video", "old_sub"]);
  });

  it("AC16: search/model exception preserves old cloud assets and tracked obtained state", async () => {
    const { repo, storage, movieDir } = await seededUpgrade();
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("offline fixture: model unavailable"); } });
    const result = await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => snapshot }, storage, model, moviesParentDirectoryId: "movies", now: () => NOW });
    expect(result.status).toBe("failed");
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toContain("old_video");
    const tracked = await repo.getTrackedSeasonState(`${title.id}_movie`, scope);
    expect(tracked?.episodes[0]).toMatchObject({ obtained: true, verifiedFileIds: ["old_video"] });
  });

  it("AC16: selected expired-source exception returns to choices while preserving old tracking", async () => {
    const { repo, storage, movieDir } = await seededUpgrade();
    storage.transfer = async () => { throw new Error("expired link"); };
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toContain("old_video");
    expect((await repo.getTrackedSeasonState(`${title.id}_movie`, scope))?.episodes[0]).toMatchObject({ obtained: true, verifiedFileIds: ["old_video"] });
    expect((await repo.getWorkflowRunSnapshot("upgrade_run", scope))?.workflowRun.movieChoices?.chosenId).toBeUndefined();
  });

  it("AC16: selected drive authentication exception freezes the drive and preserves old tracking", async () => {
    const { repo, storage, movieDir } = await seededUpgrade();
    storage.transfer = async () => { throw new Pan115AuthError("PAN115_AUTH_FAILED: offline fixture"); };
    const freezes: string[] = [];
    const result = await executeSelectedUpgrade(repo, storage, "remux4k", async (id) => { freezes.push(id); });
    expect(result.status, JSON.stringify({ result, freezes, run: (await repo.getWorkflowRunSnapshot("upgrade_run", scope))?.workflowRun.status })).toBe("failed");
    expect(freezes).toEqual([scope.connectedStorageId]);
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toContain("old_video");
    expect((await repo.getTrackedSeasonState(`${title.id}_movie`, scope))?.episodes[0]).toMatchObject({ obtained: true, verifiedFileIds: ["old_video"] });
    expect((await repo.getWorkflowRunSnapshot("upgrade_run", scope))?.workflowRun.status).toBe("failed");
    expect(await repo.chooseMovieCandidate({ workflowRunId: "upgrade_run", candidateId: "iso4k", scope })).toBe("unavailable");
    expect(await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW })).toBeNull();
  });

  it("AC17: movie feedback enters choice mode with zero cloud writes and keeps its message processing", async () => {
    const { repo, storage: realStorage } = await seededUpgrade(["old_video"], {}, false, false, false);
    const work = { accountId: scope.accountId, drive: scope.connectedStorageId, titleKey: title.id };
    await repo.createUserMessage({ ...work, body: "旧版字幕不同步，请找更好的版本", episodeTags: [], now: NOW });
    expect(await queueReplaceRequest({ repository: repo, work, createWorkflowRunId: () => "replace_run", now: () => NOW })).toMatchObject({ status: "queued" });
    const calls: string[] = [];
    const storage = new Proxy({} as StorageExecutor, { get: (_target, property) => {
      calls.push(String(property));
      throw new Error(`cloud access before choice: ${String(property)}`);
    } });
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => ++turn === 1
      ? toolCall("submitCandidates", { candidateIds: ["remux4k"] }, "submit") : finalText() });
    const result = await runQueuedReplaceRequest({ repository: repo, resourceProvider: { search: async () => snapshot }, storage, model,
      storageParentDirectoryId: "tv", moviesParentDirectoryId: "movies", movieQualityPreference: "blu-ray-iso", now: () => NOW });
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(calls).toEqual([]);
    const waiting = await repo.getWorkflowRunSnapshot("replace_run", scope);
    expect(waiting?.workflowRun).toMatchObject({ kind: "replace_request", status: "awaiting_choice" });
    expect(waiting?.workflowRun.movieChoices?.candidates.map((candidate) => candidate.id)).toEqual(["remux4k"]);
    expect((await repo.listUserMessages(work))[0]).toMatchObject({ status: "processing", runId: "replace_run", body: "旧版字幕不同步，请找更好的版本" });
    expect(await repo.chooseMovieCandidate({ workflowRunId: "replace_run", candidateId: "remux4k", scope })).toBe("chosen");
    expect((await repo.listUserMessages(work))[0]).toMatchObject({ status: "processing", runId: "replace_run" });
    const prompts: string[] = [];
    const selectedModel = new MockLanguageModelV3({ doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      throw new Error("offline fixture: stop after observing selected context");
    } });
    const selectedRun = await runQueuedReplaceRequest({ repository: repo, resourceProvider: { search: async () => { throw new Error("must use chosen source"); } }, storage: realStorage, model: selectedModel,
      storageParentDirectoryId: "tv", moviesParentDirectoryId: "movies", movieQualityPreference: "blu-ray-iso", now: () => NOW });
    expect(selectedRun.status).toBe("failed");
    expect(prompts.join(" ")).toContain("旧版字幕不同步，请找更好的版本");
    expect((await repo.listUserMessages(work))[0]).toMatchObject({ status: "pending", body: "旧版字幕不同步，请找更好的版本" });
  });

  it("AC22: movie feedback chosen BDMV share is blocked before writes and keeps the message processing", async () => {
    const { repo, storage } = await seededUpgrade(["old_video"], {}, false, false, false);
    const work = { accountId: scope.accountId, drive: scope.connectedStorageId, titleKey: title.id };
    await repo.createUserMessage({ ...work, body: "请换蓝光 ISO", episodeTags: [], now: NOW });
    expect(await queueReplaceRequest({ repository: repo, work, createWorkflowRunId: () => "replace_run", now: () => NOW })).toMatchObject({ status: "queued" });
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => ++turn === 1
      ? toolCall("submitCandidates", { candidateIds: ["iso4k"] }, "submit") : finalText() });
    expect(await runQueuedReplaceRequest({ repository: repo, resourceProvider: { search: async () => snapshot }, storage, model,
      storageParentDirectoryId: "tv", moviesParentDirectoryId: "movies", movieQualityPreference: "blu-ray-iso", now: () => NOW })).toMatchObject({ workflowStatus: "awaiting_choice" });
    expect(await repo.chooseMovieCandidate({ workflowRunId: "replace_run", candidateId: "iso4k", scope })).toBe("chosen");
    Object.assign(storage, { inspectCandidateShare: async () => ({ files: ["Film.iso", "BDMV/index.bdmv"], directories: ["BDMV"] }) });
    const writes: string[] = [];
    const guarded = new Proxy(storage, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "createDirectory" || property === "transfer" || property === "deleteFiles") {
        return async (...args: unknown[]) => { writes.push(String(property)); return (value as (...args: unknown[]) => unknown).apply(target, args); };
      }
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const noModel = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("AI should not run before rejected share-tree preflight"); } });
    expect(await runQueuedReplaceRequest({ repository: repo, resourceProvider: { search: async () => { throw new Error("provider should not run"); } }, storage: guarded, model: noModel,
      storageParentDirectoryId: "tv", moviesParentDirectoryId: "movies", movieQualityPreference: "blu-ray-iso", now: () => NOW })).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(writes).toEqual([]);
    const waiting = await repo.getWorkflowRunSnapshot("replace_run", scope);
    expect(waiting?.workflowRun.movieChoices?.lastFailure).toMatchObject({ candidateId: "iso4k", reason: expect.stringMatching(/BDMV/) });
    expect((await repo.listUserMessages(work))[0]).toMatchObject({ status: "processing", runId: "replace_run" });
  });

  it("AC12: a verified better file replaces only the exact old video and paired subtitle IDs", async () => {
    const { repo, storage, movieDir } = await seededUpgrade(["old_video"], { remux4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "new_video", providerFileId: "new_video", storageDirectoryId: "", name: "测试电影.2025.2160p.BD.REMUX.mkv", sizeBytes: 60_000_000_000, episodeCode: null }],
    } });
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    expect(storage.oldPresentImmediatelyAfterTransfer).toEqual([true]);
    expect(storage.deletions).toEqual([["old_video", "old_sub"]]);
    const files = (await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId);
    expect(files).toEqual(["other_sub", "other_file", "new_video"]);
    expect((await storage.listTree({ directoryId: movieDir })).find((file) => file.providerFileId === "new_video")?.path)
      .toBe("测试电影 (2025) {tmdb-900001} [4K REMUX].mkv");
    const saved = await repo.getWorkflowRunSnapshot("upgrade_run", scope);
    expect(saved?.episodes.flatMap((episode) => episode.verifiedFileIds)).toContain("new_video");
    expect(saved?.workflowRun.movieUpgrade?.cleanupStatus).toBe("removed");
  });

  it("retains the old version if the better new movie cannot be renamed and verified", async () => {
    const { repo, storage, movieDir } = await seededUpgrade(["old_video"], { remux4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "new_video", providerFileId: "new_video", storageDirectoryId: "", name: "测试电影.2025.2160p.REMUX.mkv", sizeBytes: 60_000_000_000, episodeCode: null }],
    } });
    storage.renameFile = async () => { /* Provider false success, read-back must catch it. */ };
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ workflowStatus: "succeeded" });
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toContain("old_video");
    const saved = await repo.getWorkflowRunSnapshot("upgrade_run", scope);
    expect(saved?.workflowRun.movieUpgrade?.cleanupStatus).toBe("retained");
    expect(saved?.workflowRun.auditEvents).toContainEqual(expect.objectContaining({ type: "movie_file_rename_incomplete" }));
    expect(saved?.notifications.some((notification) => notification.body.includes("命名未全部完成"))).toBe(true);
  });

  it("does not mark a renamed movie obtained when its original file ID disappears", async () => {
    const { repo, storage } = await seededUpgrade(["old_video"], { remux4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "new_video", providerFileId: "new_video", storageDirectoryId: "", name: "测试电影.2025.2160p.REMUX.mkv", sizeBytes: 60_000_000_000, episodeCode: null }],
    } });
    const listTree = storage.listTree.bind(storage);
    const renameFile = storage.renameFile.bind(storage);
    let renamed = false;
    storage.renameFile = async (input) => { await renameFile(input); renamed = true; };
    storage.listTree = async (input) => (await listTree(input)).map((file) => renamed && file.providerFileId === "new_video"
      ? { ...file, providerFileId: "changed_id" } : file);
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ workflowStatus: "awaiting_choice" });
    expect(storage.deletions).toEqual([]);
    expect((await repo.getTrackedSeasonState(`${title.id}_movie`, scope))?.episodes[0]?.verifiedFileIds).toEqual(["old_video"]);
  });

  it("unknown candidate quality preserves old files even when the landed filename indicates an upgrade", async () => {
    const unknown = candidate("unknown", "蓝光原盘");
    const { repo, storage } = await seededUpgrade(["old_video"], { unknown: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "new_video", providerFileId: "new_video", storageDirectoryId: "", name: "测试电影.2025.2160p.REMUX.mkv", sizeBytes: 60_000_000_000, episodeCode: null }],
    } });
    const model = new MockLanguageModelV3({ doGenerate: async () => toolCall("submitCandidates", { candidateIds: ["unknown"] }, "submit") });
    expect(await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => ({ ...snapshot, candidates: [unknown] }) },
      storage, model, moviesParentDirectoryId: "movies", now: () => NOW })).toMatchObject({ workflowStatus: "awaiting_choice" });
    expect(await repo.chooseMovieCandidate({ workflowRunId: "upgrade_run", candidateId: "unknown", scope })).toBe("chosen");
    const result = await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => snapshot }, storage,
      model: selectedTransferModel(), moviesParentDirectoryId: "movies", now: () => NOW });
    expect(result).toMatchObject({ workflowStatus: "succeeded" });
    expect(storage.deletions).toEqual([]);
    expect((await repo.getWorkflowRunSnapshot("upgrade_run", scope))?.workflowRun.movieUpgrade?.cleanupStatus).toBe("retained");
  });

  it.each(["high", "medium"] as const)("movie any does not inherit series %s guidance", async (qualityPreference) => {
    const repo = new InMemoryWorkflowRepository();
    const base = runningFixture();
    await repo.saveWorkflowRunSnapshot({ ...base, workflowRun: { ...base.workflowRun, status: "queued" } });
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({ doGenerate: async (options) => { prompts.push(JSON.stringify(options.prompt)); return finalText(); } });
    await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => ({ ...snapshot, candidates: [] }) },
      storage: new FakeStorageExecutor(), model, qualityPreference, moviesParentDirectoryId: "movies", now: () => NOW });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.join("\n")).not.toContain("画质偏好:高");
    expect(prompts.join("\n")).not.toContain("画质偏好:中");
  });

  it("AC13: a false-success transfer without a new landed file preserves the old version", async () => {
    const { repo, storage, movieDir } = await seededUpgrade(["old_video"], { remux4k: {
      status: "succeeded", providerMessage: "offline fixture: claimed success but no file", files: [],
    } });
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toEqual(["old_video", "old_sub", "other_sub", "other_file"]);
  });

  it("AC13: failed new transfer leaves every old file and subtitle untouched", async () => {
    const { repo, storage, movieDir } = await seededUpgrade(["old_video"], { remux4k: {
      status: "failed", providerMessage: "offline fixture: expired", files: [],
    } });
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toEqual(["old_video", "old_sub", "other_sub", "other_file"]);
    expect((await repo.getTrackedSeasonState(`${title.id}_movie`, scope))?.episodes[0]?.verifiedFileIds).toContain("old_video");
  });

  it("AC14: an unverified old version is incomparable and must never be deleted", async () => {
    const { repo, storage, movieDir } = await seededUpgrade([], { remux4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "new_video", providerFileId: "new_video", storageDirectoryId: "", name: "测试电影.2025.2160p.BD.REMUX.mkv", sizeBytes: 60_000_000_000, episodeCode: null }],
    } });
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toContain("old_video");
    expect((await repo.getWorkflowRunSnapshot("upgrade_run", scope))?.workflowRun.movieUpgrade?.currentAssets).toEqual([]);
    expect((await repo.getWorkflowRunSnapshot("upgrade_run", scope))?.workflowRun.movieUpgrade?.cleanupStatus).toBe("retained");
  });

  it("AC14: an actual landed file worse than its release title never triggers old-file cleanup", async () => {
    const { repo, storage, movieDir } = await seededUpgrade(["old_video"], { remux4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "new_video", providerFileId: "new_video", storageDirectoryId: "", name: "测试电影.2025.1080p.WEB.mkv", sizeBytes: 9_000_000_000, episodeCode: null }],
    } });
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    expect(storage.deletions).toEqual([]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toContain("old_video");
    expect((await repo.getWorkflowRunSnapshot("upgrade_run", scope))?.workflowRun.movieUpgrade?.cleanupStatus).toBe("retained");
  });

  it("AC15: cleanup failure keeps both versions and persists a visible error event", async () => {
    const { repo, storage, movieDir } = await seededUpgrade(["old_video"], { remux4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "new_video", providerFileId: "new_video", storageDirectoryId: "", name: "测试电影.2025.2160p.BD.REMUX.mkv", sizeBytes: 60_000_000_000, episodeCode: null }],
    } }, true);
    const result = await executeSelectedUpgrade(repo, storage);
    expect(result).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    expect(storage.deletions).toEqual([["old_video", "old_sub"]]);
    expect((await storage.listTree({ directoryId: movieDir })).map((file) => file.providerFileId)).toEqual(["old_video", "old_sub", "other_sub", "other_file", "new_video"]);
    const saved = await repo.getWorkflowRunSnapshot("upgrade_run", scope);
    expect(saved?.workflowRun.auditEvents).toContainEqual({ type: "movie_upgrade_failed", message: "新版已验证，旧版清理失败，请手动检查" });
    expect(saved?.workflowRun.movieUpgrade?.cleanupStatus).toBe("failed");
    expect(saved?.notifications.some((notification) => notification.body.includes("旧版清理失败"))).toBe(true);
  });

  it("AC2: the queued search turn makes zero cloud calls, including directory creation", async () => {
    const repo = new InMemoryWorkflowRepository();
    const queued = runningFixture();
    await repo.saveWorkflowRunSnapshot({ ...queued, workflowRun: { ...queued.workflowRun, status: "queued", movieChoiceMode: "blu-ray-iso" } });
    const calls: string[] = [];
    const storage = new Proxy({} as StorageExecutor, { get: (_target, property) => {
      calls.push(String(property));
      throw new Error(`cloud access before choice: ${String(property)}`);
    } });
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      turn += 1;
      return turn === 1 ? toolCall("submitCandidates", { candidateIds: rows.map((r) => r.id) }, "submit") : finalText();
    } });
    const result = await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => snapshot }, storage, model, moviesParentDirectoryId: "movies", now: () => NOW });
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(calls).toEqual([]);
    expect((await repo.getWorkflowRunSnapshot("movie_run", scope))?.workflowRun.status).toBe("awaiting_choice");
  });

  it("AC2: patrol of a tracked unobtained movie also waits without cloud writes", async () => {
    const repo = new InMemoryWorkflowRepository();
    const base = runningFixture();
    await repo.saveWorkflowRunSnapshot({ ...base,
      workflowRun: { ...base.workflowRun, status: "no_coverage", finishedAt: NOW },
      episodes: [{ trackedSeasonId: base.season.id, episodeCode: "S01E01", airDate: null, title: title.title, airStatus: "aired", obtained: false, metadataStatus: "confirmed", verifiedFileIds: [] }],
    });
    const calls: string[] = [];
    const storage = new Proxy({} as StorageExecutor, { get: (_target, property) => {
      calls.push(String(property));
      throw new Error(`cloud access before choice: ${String(property)}`);
    } });
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => ++turn === 1
      ? toolCall("submitCandidates", { candidateIds: ["iso4k"] }, "submit") : finalText() });
    const outcomes = await runScheduledType3Monitoring({ repository: repo, resourceProvider: { search: async () => snapshot }, storage, model, movieQualityPreference: "blu-ray-iso", storageParentDirectoryId: "tv", moviesParentDirectoryId: "movies", createWorkflowRunId: () => "movie_patrol_run", now: () => NOW });
    expect(outcomes).toMatchObject([{ status: "ran", workflowStatus: "awaiting_choice" }]);
    expect(calls).toEqual([]);
    expect((await repo.getWorkflowRunSnapshot("movie_patrol_run", scope))?.workflowRun.status).toBe("awaiting_choice");
  });

  it("AC5/AC6: transfer failure after choosing never transfers a higher-ranked alternative", async () => {
    const repo = new InMemoryWorkflowRepository();
    const queued = runningFixture();
    await repo.saveWorkflowRunSnapshot({ ...queued, workflowRun: { ...queued.workflowRun, status: "queued", movieChoiceMode: "blu-ray-iso" } });
    const ranked = (await import("../src/movie-quality-policy.js")).rankMovieCandidates(rows);
    class RecordingStorage extends FakeStorageExecutor {
      readonly transfers: string[] = [];
      async inspectCandidateShare() { return { files: ["fixture-independent-verified-remux.mkv"], directories: [] }; }
      override async transfer(input: Parameters<FakeStorageExecutor["transfer"]>[0]) {
        this.transfers.push(input.candidate.id);
        return super.transfer(input);
      }
    }
    const storage = new RecordingStorage({ transferOutcomes: {
      remux1080: { status: "failed", providerMessage: "offline fixture: share expired", files: [] },
      iso4k: { status: "succeeded", providerMessage: "should never be used", files: [] },
    } });
    expect(await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW })).toMatchObject({ workflowRun: { status: "running" } });
    expect(await repo.publishMovieChoices({ workflowRunId: "movie_run", scope, resourceSnapshots: [snapshot], candidates: ranked })).toBe(true);
    expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "remux1080", scope })).toBe("chosen");
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      turn += 1;
      if (turn === 1) return toolCall("searchResources", { keyword: title.title }, "search");
      if (turn === 2) return toolCall("transferCandidate", { snapshotId: "s1", candidateId: "s1-1" }, "transfer");
      if (turn === 3) return toolCall("reportNoCoverage", { reason: "已选分享失效" }, "report");
      return finalText();
    } });
    const result = await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => { throw new Error("must use persisted choice"); } }, storage, model, moviesParentDirectoryId: "movies", now: () => NOW });
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    expect(storage.transfers).toEqual(["remux1080"]);
    const after = await repo.getWorkflowRunSnapshot("movie_run", scope);
    expect(after?.workflowRun.status).toBe("awaiting_choice");
    expect(after?.workflowRun.movieChoices?.chosenId).toBeUndefined();
    expect(after?.workflowRun.movieChoices?.candidates.map((r) => r.id)).toEqual(ranked.map((r) => r.id));
  });

  it.each(["2160p BD ISO", "BD ISO", "蓝光原盘"])("AC5/AC7: selected %s is routed using actual ISO files", async (release) => {
    const repo = new InMemoryWorkflowRepository();
    const queued = runningFixture();
    await repo.saveWorkflowRunSnapshot({ ...queued, workflowRun: { ...queued.workflowRun, status: "queued", movieChoiceMode: "blu-ray-iso" } });
    const selected = candidate("iso4k", release);
    const source = { ...snapshot, candidates: [selected] };
    const ranked = rankMovieCandidates([selected]);
    await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW });
    expect(await repo.publishMovieChoices({ workflowRunId: "movie_run", scope, resourceSnapshots: [source], candidates: ranked })).toBe(true);
    expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "iso4k", scope })).toBe("chosen");
    const storage = new FakeStorageExecutor({ transferOutcomes: { iso4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "iso_file", storageDirectoryId: "", name: "测试电影.2025.2160p.iso", sizeBytes: 60_000_000_000, episodeCode: null, providerFileId: "iso_file" }],
    } } });
    Object.assign(storage, { inspectCandidateShare: async () => ({ files: ["fixture-independent-verified-disc.iso"], directories: [] }) });
    const steps = [
      ["searchResources", { keyword: title.title }],
      ["transferCandidate", { snapshotId: "s1", candidateId: "s1-1" }],
      ["inspectTargetDir", {}],
      ["markObtained", { codes: ["MOVIE"] }],
      ["finish", {}],
    ] as const;
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      const step = steps[turn++];
      return step ? toolCall(step[0], step[1], `step_${turn}`) : finalText();
    } });
    const result = await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => { throw new Error("must use persisted choice"); } }, storage, model, moviesParentDirectoryId: "movies", now: () => NOW });
    expect(result).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    const saved = await repo.getWorkflowRunSnapshot("movie_run", scope);
    expect(saved?.workflowRun.movieChoices?.chosenId).toBe("iso4k");
    expect(saved?.transferAttempts.map((attempt) => attempt.candidateId)).toEqual(["iso4k"]);
    expect(saved?.episodes.some((episode) => episode.obtained)).toBe(true);
    expect((await storage.listTree({ directoryId: saved!.season.storageDirectoryId })).map((file) => file.path))
      .toContain("测试电影 (2025) {tmdb-900001} [4K ISO].iso");
    expect(saved?.episodes.flatMap((episode) => episode.verifiedFileIds)).toContain("iso_file");
  });

  it("AC2/AC7: an ISO release title whose landed payload is BDMV is rejected", async () => {
    const repo = new InMemoryWorkflowRepository();
    const queued = runningFixture();
    await repo.saveWorkflowRunSnapshot({ ...queued, workflowRun: { ...queued.workflowRun, status: "queued", movieChoiceMode: "blu-ray-iso" } });
    await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW });
    const ranked = (await import("../src/movie-quality-policy.js")).rankMovieCandidates(rows);
    expect(await repo.publishMovieChoices({ workflowRunId: "movie_run", scope, resourceSnapshots: [snapshot], candidates: ranked })).toBe(true);
    expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "iso4k", scope })).toBe("chosen");
    const storage = new FakeStorageExecutor({ transferOutcomes: { iso4k: {
      status: "succeeded", providerMessage: "offline fixture", files: [{ id: "bdmv_stream", storageDirectoryId: "", name: "BDMV/STREAM/00001.m2ts", sizeBytes: 30_000_000_000, episodeCode: null, providerFileId: "bdmv_stream" }],
    } } });
    Object.assign(storage, { inspectCandidateShare: async () => ({ files: ["fixture-independent-verified-disc.iso"], directories: [] }) });
    const steps = [
      ["searchResources", { keyword: title.title }],
      ["transferCandidate", { snapshotId: "s1", candidateId: "s1-1" }],
      ["inspectTargetDir", {}],
      ["markObtained", { codes: ["MOVIE"] }],
      ["finish", {}],
    ] as const;
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      const step = steps[turn++];
      return step ? toolCall(step[0], step[1], `step_${turn}`) : finalText();
    } });
    const result = await runQueuedMovieAcquisition({ repository: repo, resourceProvider: { search: async () => { throw new Error("must use persisted choice"); } }, storage, model, moviesParentDirectoryId: "movies", now: () => NOW });
    expect(result).toMatchObject({ status: "ran", workflowStatus: "awaiting_choice" });
    const saved = await repo.getWorkflowRunSnapshot("movie_run", scope);
    expect(saved?.workflowRun.movieChoices?.chosenId).toBeUndefined();
    expect(saved?.episodes.some((episode) => episode.obtained)).toBe(false);
  });

  it("AC1/AC2: offline AI search returns six ordered tiers, filters BDMV, and cannot invoke cloud writes", async () => {
    const keywords: string[] = [];
    const provider = { search: async ({ keyword }: { keyword: string }) => {
      keywords.push(keyword);
      return snapshot;
    } };
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      calls += 1;
      return calls === 1 ? toolCall("searchResources", { keyword: title.originalTitle }, "search")
        : calls === 2 ? toolCall("submitCandidates", { candidateIds: rows.map((r) => r.id) }, "submit") : finalText();
    } });
    const result = await findMovieChoices({ title, provider, model, workflowRunId: "movie_run" });
    expect(keywords).toEqual([title.title, title.originalTitle]);
    expect(result.candidates.map((r) => r.id)).toEqual(["iso4k", "dv_atmos", "remux4k", "ordinary4k", "iso1080", "remux1080", "ordinary1080"]);
    expect(result.candidates.find((r) => r.id === "dv_atmos")).toMatchObject({ tier: 2, dolbyVision: true, atmos: true, evidenceSource: "发布名称" });
    expect(result.resourceSnapshots).toHaveLength(2);
  });

  for (const [name, make] of [
    ["memory", () => new InMemoryWorkflowRepository()],
    ["sqlite", () => createSqliteWorkflowRepository({ path: ":memory:" })],
  ] as const) {
    it(`AC3/AC4/AC5: ${name} persists waiting; claim/expiry skip it; scoped choice is CAS`, async () => {
      const repo: WorkflowRepository = make();
      try {
        await repo.saveWorkflowRunSnapshot(runningFixture());
        expect(await repo.publishMovieChoices({ workflowRunId: "movie_run", scope: { accountId: "wrong", connectedStorageId: scope.connectedStorageId }, resourceSnapshots: [snapshot], candidates: [] })).toBe(false);
        const ranked = (await findMovieChoices({ title, provider: { search: async () => snapshot }, model: new MockLanguageModelV3({ doGenerate: async () => toolCall("submitCandidates", { candidateIds: ["iso4k", "remux4k"] }, "submit") }), workflowRunId: "movie_run" })).candidates;
        expect(await repo.publishMovieChoices({ workflowRunId: "movie_run", scope, resourceSnapshots: [snapshot], candidates: ranked })).toBe(true);
        const waiting = await repo.getWorkflowRunSnapshot("movie_run", scope);
        expect(waiting?.workflowRun.status).toBe("awaiting_choice");
        expect(waiting?.workflowRun.movieChoices?.candidates.map((r) => r.id)).toEqual(["iso4k", "remux4k"]);
        expect(waiting?.resourceSnapshots[0]?.candidates).toHaveLength(rows.length);
        expect(isStaleActiveWorkflowRun(waiting!.workflowRun, "2027-01-01T00:00:00.000Z")).toBe(false);
        expect(await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW })).toBeNull();
        expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "iso4k", scope: { accountId: scope.accountId, connectedStorageId: "drive_other" } })).toBe("unavailable");
        expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "bdmv", scope })).toBe("unavailable");
        expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "remux4k", scope })).toBe("chosen");
        expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "remux4k", scope })).toBe("already_chosen");
        expect(await repo.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "iso4k", scope })).toBe("unavailable");
        const claimed = await repo.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW });
        expect(claimed?.workflowRun.movieChoices?.chosenId).toBe("remux4k");
        const onlyChosen = chosenMovieProvider(claimed!.resourceSnapshots, claimed!.workflowRun.movieChoices!.chosenId!);
        expect((await onlyChosen.search({ keyword: "任意搜索词" })).candidates.map((r) => r.id)).toEqual(["remux4k"]);
      } finally {
        if ("close" in repo) await (repo as { close: () => Promise<void> | void }).close();
      }
    });
    it(`AC19: ${name} keeps a waiting replace message beyond the 10-minute orphan cutoff`, async () => {
      const repo: WorkflowRepository = make();
      try { await assertAwaitingMessageSurvivesOrphanSweep(repo); }
      finally { if ("close" in repo) await (repo as { close: () => Promise<void> | void }).close(); }
    });
    it(`AC23: ${name} restart search is scoped and one-shot under concurrent calls`, async () => {
      const repo: WorkflowRepository = make();
      try { await assertRestartMovieChoiceSearchCAS(repo); }
      finally { if ("close" in repo) await (repo as { close: () => Promise<void> | void }).close(); }
    });
  }

  it("AC3: SQLite waiting candidates survive repository close and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "movie-choice-acceptance-"));
    const path = join(dir, "workflow.sqlite");
    try {
      const first = createSqliteWorkflowRepository({ path });
      await first.saveWorkflowRunSnapshot(runningFixture());
      const ranked = (await import("../src/movie-quality-policy.js")).rankMovieCandidates(rows);
      expect(await first.publishMovieChoices({ workflowRunId: "movie_run", scope, resourceSnapshots: [snapshot], candidates: ranked })).toBe(true);
      first.close();

      const reopened = createSqliteWorkflowRepository({ path });
      try {
        const waiting = await reopened.getWorkflowRunSnapshot("movie_run", scope);
        expect(waiting?.workflowRun.status).toBe("awaiting_choice");
        expect(waiting?.workflowRun.movieChoices?.candidates.map((r) => r.id)).toEqual(ranked.map((r) => r.id));
        expect(waiting?.resourceSnapshots[0]?.candidates).toHaveLength(rows.length);
        expect(await reopened.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW })).toBeNull();
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const pgAdminUrl = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
  (pgAdminUrl ? it : it.skip)("AC3/AC4/AC5: isolated Postgres waiting survives a fresh connection and scoped CAS", async () => {
    const dbName = `wf_movie_choice_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: pgAdminUrl });
    await admin.connect();
    let created = false;
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      created = true;
      const dbUrl = new URL(pgAdminUrl!);
      dbUrl.pathname = `/${dbName}`;
      const first = createPostgresWorkflowRepositorySync({ connectionString: dbUrl.toString() });
      try {
        await first.saveWorkflowRunSnapshot(runningFixture());
        const ranked = (await import("../src/movie-quality-policy.js")).rankMovieCandidates(rows);
        expect(await first.publishMovieChoices({ workflowRunId: "movie_run", scope, resourceSnapshots: [snapshot], candidates: ranked })).toBe(true);
      } finally { await first.close(); }

      const reopened = createPostgresWorkflowRepositorySync({ connectionString: dbUrl.toString() });
      try {
        const waiting = await reopened.getWorkflowRunSnapshot("movie_run", scope);
        expect(waiting?.workflowRun.status).toBe("awaiting_choice");
        expect(waiting?.resourceSnapshots[0]?.candidates).toHaveLength(rows.length);
        expect(await reopened.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW })).toBeNull();
        expect(await reopened.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "iso4k", scope: { ...scope, accountId: "other" } })).toBe("unavailable");
        expect(await reopened.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "bdmv", scope })).toBe("unavailable");
        const raced = await Promise.all([
          reopened.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "iso4k", scope }),
          reopened.chooseMovieCandidate({ workflowRunId: "movie_run", candidateId: "remux4k", scope }),
        ]);
        expect(raced.filter((r) => r === "chosen")).toHaveLength(1);
        expect(raced.filter((r) => r === "unavailable")).toHaveLength(1);
        const claimed = await reopened.claimNextQueuedWorkflowRun({ kind: "movie_init", now: NOW });
        expect(claimed?.workflowRun.status).toBe("running");
        expect(["iso4k", "remux4k"]).toContain(claimed?.workflowRun.movieChoices?.chosenId);
        await assertAwaitingMessageSurvivesOrphanSweep(reopened);
        await assertRestartMovieChoiceSearchCAS(reopened);
      } finally { await reopened.close(); }
    } finally {
      if (created) await admin.query(`DROP DATABASE ${dbName}`);
      await admin.end();
    }
  });
});
