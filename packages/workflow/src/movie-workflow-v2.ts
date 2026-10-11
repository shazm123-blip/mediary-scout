import type { AgentMemoryStore } from "./agent-memory.js";
import type { LanguageModel } from "ai";
import {
  createEpisodeStates,
  movieAnchorSeason,
  type AgentDecision,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type MovieWorkflowResult,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowStatus,
} from "./domain.js";
import { buildMovieReport, buildReplacementReport, emptyRunOutcome, formatReportPushText } from "./notification-report.js";
import { classifyTransferBlock } from "./acquisition-v2/transfer-block.js";
import { classifySearchSourceFault } from "./acquisition-v2/search-source-fault.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { DeadLinkStore } from "./acquisition-v2/dead-links.js";
import { readLandedSize, type LandedSize } from "./acquisition-v2/landed-size.js";
import type { AgentToolEvent } from "./acquisition-v2/activity.js";
import { runAcquisitionV2, type RunAcquisitionV2Request, type RunAcquisitionV2Result } from "./acquisition-v2/orchestrator.js";
import type { JevJudge } from "./jev-judge.js";
import { getQualityGuidance, getSearchRecipe } from "./acquisition-v2/search-profile.js";
import { ensureMediaLibraryDirectory } from "./media-library-folder.js";
import { renameLandedMovieFiles } from "./movie-file-naming.js";
import { classifyExistingMovieAsset, type MovieQualityTier } from "./movie-quality-policy.js";

function defaultNowIso(): string {
  return new Date().toISOString();
}

/**
 * Phase 7d — movie acquisition on the V2 engine. Same effect as the old
 * runMovieAcquisition (verify-or-create Movies/Title (Year), agent confirms the
 * one film and transfers it, mark, clean staging) but the semantic loop is the
 * strong movie task agent inside the sandbox. Produces the existing
 * MovieWorkflowResult so runner/web/UI are unchanged.
 */
export interface RunMovieAcquisitionV2Request {
  title: MediaTitle;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  moviesParentDirectoryId: string;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** Global quality preference ("high"/"medium"); undefined = 不限 (no guidance). */
  qualityPreference?: "high" | "medium";
  /** True only after a durable user choice; permits the chosen ISO as a movie asset. */
  userChosenSource?: boolean;
  expectIso?: boolean;
  rejectBdmv?: () => boolean;
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /** Optional Jev candidate prefilter (see orchestrator.jevJudge). */
  jevJudge?: JevJudge;
  deadLinkStore?: DeadLinkStore;
  /** Agent memory (see orchestrator.memory). */
  memory?: { store: AgentMemoryStore; accountId: string; drive?: string };
  /** A replace_request run (see orchestrator.userRequest; requestedEpisodes ["MOVIE"]). */
  userRequest?: RunAcquisitionV2Request["userRequest"];
  /** Replace runs: the film was obtained before the run (its old file is there), so
   *  it stays obtained whether or not a replacement landed. Default false. */
  priorObtained?: boolean;
  /** See orchestrator.protectExisting (episodes ["MOVIE"] when the film has a kept replacement). */
  protectExisting?: RunAcquisitionV2Request["protectExisting"];
  /** See orchestrator.rejectedLookup. */
  rejectedLookup?: RunAcquisitionV2Request["rejectedLookup"];
  /** See orchestrator.linkHistory. */
  linkHistory?: RunAcquisitionV2Request["linkHistory"];
  onProgress?: (event: AgentToolEvent) => void;
  now?: () => string;
}

/** The movie result plus the replace outcome of a replace_request run. */
export type MovieAcquisitionV2Result = MovieWorkflowResult & {
  replacement?: RunAcquisitionV2Result["replacement"];
  movieNamingWarnings?: string[];
  /** Actual file evidence captured before any generated filename is written. */
  movieAssetEvidence?: Array<{ fileId: string; tier: MovieQualityTier | null; dolbyVision: boolean; atmos: boolean }>;
};

export async function runMovieAcquisitionV2(
  request: RunMovieAcquisitionV2Request,
): Promise<MovieAcquisitionV2Result> {
  const now = request.now ?? defaultNowIso;

  // verify-or-create Movies/Title (Year) {tmdb-N} (legacy Title (Year) reused).
  // For a movie this dir IS the staging, the flatten target, and the final
  // location — there is NO separate staging (§5): transfer lands here, the
  // wrapper is flattened in place, mark. So stagingDirectoryId ===
  // targetMovieDirectoryId === the movie dir.
  const movieDirectoryId = await ensureMediaLibraryDirectory({
    executor: request.storage,
    parentId: request.moviesParentDirectoryId,
    title: request.title.title,
    year: request.title.year ?? "—",
    tmdbId: request.title.tmdbId,
  });
  const beforeFileIds = new Set((await request.storage.listTree({ directoryId: movieDirectoryId })).map((file) => file.providerFileId));

  const v2 = await runAcquisitionV2({
    provider: request.resourceProvider,
    executor: request.storage,
    model: request.model,
    workflowRunId: request.workflowRunId,
    target: {
      kind: "movie",
      title: request.title.title,
      aliases: request.title.aliases,
      year: request.title.year ?? 0,
      qualityPreference: "4K",
      tmdbId: request.title.tmdbId,
    },
    stagingDirectoryId: movieDirectoryId,
    targetMovieDirectoryId: movieDirectoryId,
    ...(request.userChosenSource ? { userChosenSource: true } : {}),
    searchHints: getSearchRecipe("movie"), // movie search is origin-independent
    searchProfile: "movie",
    ...(request.userChosenSource
      ? { qualityGuidance: "用户已经选择这个唯一候选。只转存已选资源，允许 BD ISO 作为正片文件；仍排除 BDMV。不可更换资源。检查实际落地的 ISO/MKV/MP4 文件，失败则如实报告。" }
      : getQualityGuidance("movie", request.qualityPreference) === ""
      ? {}
      : { qualityGuidance: getQualityGuidance("movie", request.qualityPreference) }),
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
    ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request.preferredLanguage === undefined ? {} : { preferredLanguage: request.preferredLanguage }),
    // 国产片(CN origin)→ 电影 prompt 跳过中文字幕 floor(原生中文对白,无中字可寻)。
    ...(request.title.originCountries === undefined ? {} : { originCountries: request.title.originCountries }),
    ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
    ...(request.assrtToken === undefined ? {} : { assrtToken: request.assrtToken }),
    ...(request.jevJudge === undefined ? {} : { jevJudge: request.jevJudge }),
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
    ...(request.memory ? { memory: request.memory } : {}),
    ...(request.userRequest ? { userRequest: request.userRequest } : {}),
    ...(request.protectExisting ? { protectExisting: request.protectExisting } : {}),
    ...(request.rejectedLookup ? { rejectedLookup: request.rejectedLookup } : {}),
    ...(request.linkHistory ? { linkHistory: request.linkHistory } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
  });

  // Truth = the AGENT'S coverage (its markObtained), NOT a mechanical file scan
  // (§1.13/§7b). The agent looked at the real files and declared coverage; the
  // workflow records that, it does not re-derive obtained by counting files.
  // A replace run never un-obtains the film: the old file stays in the directory
  // whether or not a replacement landed (spec §4.5). One that was never obtained
  // is obtained only by what landed now.
  const landedFiles = (await request.storage.listTree({ directoryId: movieDirectoryId }))
    .filter((file) => !beforeFileIds.has(file.providerFileId));
  const verifiedAssets = landedFiles.filter((file) =>
    !/(?:^|\/)BDMV(?:\/|$)/i.test(file.path) &&
    (request.expectIso ? /\.iso$/i.test(file.path) : /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i.test(file.path)) &&
    !file.path.includes("/"),
  );
  let obtained = (v2.coverage.coverageMet || (request.userRequest !== undefined && request.priorObtained === true)) &&
    (!request.userChosenSource || verifiedAssets.length > 0) && !request.rejectBdmv?.();
  const movieAssetEvidence = verifiedAssets.map((file) => {
    const quality = classifyExistingMovieAsset(file.path, file.sizeBytes);
    return { fileId: file.providerFileId, tier: quality.tier, dolbyVision: quality.dolbyVision, atmos: quality.atmos };
  });
  const naming = obtained && verifiedAssets.length > 0
    ? await renameLandedMovieFiles({ storage: request.storage, directoryId: movieDirectoryId,
      title: request.title, eligibleFileIds: verifiedAssets.map((file) => file.providerFileId), beforeFileIds })
    : { renamed: [], warnings: [] };
  const finalFileIds = naming.renamed.length > 0 || naming.warnings.length > 0
    ? new Set((await request.storage.listTree({ directoryId: movieDirectoryId })).map((file) => file.providerFileId))
    : new Set(landedFiles.map((file) => file.providerFileId));
  const finalVerifiedAssets = verifiedAssets.filter((file) => finalFileIds.has(file.providerFileId));
  if (finalVerifiedAssets.length !== verifiedAssets.length) {
    obtained = false;
    naming.warnings.push("重命名后的电影文件身份无法核实，请检查；旧版保留。");
  }

  // Real landed volume for the push (best-effort; never fails the run). The
  // movie dir IS the staging+final location, so its video file(s) are the film.
  // Not on a replace run: the dir holds the old AND the new film (double count).
  const landed =
    obtained && !request.userRequest ? await readLandedSize(request.storage, [movieDirectoryId]) : undefined;

  const result = buildResult({
    request,
    movieDirectoryId,
    obtained,
    status: obtained ? "succeeded" : "no_coverage",
    kind: obtained ? "movie_init" : "no_coverage",
    snapshots: v2.outcome.resourceSnapshots,
    attempts: v2.outcome.transferAttempts,
    decisions: v2.outcome.decisions,
    auditEvents: [...v2.auditEvents,
      ...(naming.renamed.length > 0 ? [{ type: "movie_files_renamed", message: `已按片名、年份和版本标记重命名 ${naming.renamed.length} 个文件` }] : []),
      ...naming.warnings.map((message) => ({ type: "movie_file_rename_incomplete", message }))],
    verifiedFileIds: finalVerifiedAssets.map((file) => file.providerFileId),
    // 中文字幕软兜底: the agent landed a raw match with no confirmed 中字 → flag it.
    subtitleFallback: obtained && v2.coverage.subtitleFallback,
    ...(landed ? { landed } : {}),
    ...(v2.replacement ? { replacementResults: v2.replacement.results } : {}),
    now,
  });
  if (naming.warnings.length > 0) {
    result.notifications = result.notifications.map((notification) => {
      if (!notification.report) return notification;
      const report = { ...notification.report, lines: [...notification.report.lines, "电影文件命名未全部完成，请检查；旧版保留。"] };
      return { ...notification, report, body: formatReportPushText(report) };
    });
    result.notification = result.notifications.find((item) => item.id === result.notification.id) ?? result.notification;
  }
  return { ...result, movieAssetEvidence, movieNamingWarnings: naming.warnings,
    ...(v2.replacement ? { replacement: v2.replacement } : {}) };
}

function buildResult(input: {
  request: RunMovieAcquisitionV2Request;
  movieDirectoryId: string;
  obtained: boolean;
  status: WorkflowStatus;
  kind: string;
  snapshots: ResourceSnapshot[];
  attempts: TransferAttempt[];
  decisions: AgentDecision[];
  auditEvents: AuditEvent[];
  verifiedFileIds?: string[];
  /** Landed via the 中文字幕 last-resort fallback (no confirmed 中字) → notification flag. */
  subtitleFallback?: boolean;
  landed?: LandedSize;
  /** A replace_request run: the notification reports the replacement, not "入库". */
  replacementResults?: Array<{ episode: string; outcome: "replaced" | "not_found" }>;
  now: () => string;
}): MovieWorkflowResult {
  const season: TrackedSeason = movieAnchorSeason({
    titleId: input.request.title.id,
    qualityPreference: "4K",
    storageDirectoryId: input.movieDirectoryId,
  });
  const episodes: EpisodeState[] = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: 1,
    totalEpisodes: 1,
    latestAiredEpisode: 1,
  }).map((episode) => ({ ...episode, obtained: input.obtained, verifiedFileIds: input.obtained ? input.verifiedFileIds ?? [] : [] }));

  const t = input.request.title;
  const meta = { posterPath: t.posterPath ?? null, tmdbId: t.tmdbId, mediaType: t.type, year: t.year };
  if (input.request.userRequest) {
    const report = buildReplacementReport({
      titleName: t.title,
      movie: true,
      results: input.replacementResults ?? [],
      transferBlockReason: classifyTransferBlock(input.attempts)?.reason ?? null,
      searchSourceFaultReason: classifySearchSourceFault(input.auditEvents)?.reason ?? null,
      meta,
    });
    const notification: NotificationEvent = {
      id: `notification_${input.request.workflowRunId}`,
      workflowRunId: input.request.workflowRunId,
      kind: report.status === "failed" ? "transfer_failed" : "replacement_done",
      title: t.title,
      body: formatReportPushText(report),
      createdAt: input.now(),
      trigger: "user",
      report,
    };
    return {
      status: input.status,
      title: t,
      season,
      episodes,
      resourceSnapshots: input.snapshots,
      transferAttempts: input.attempts,
      decisions: input.decisions,
      notification,
      notifications: [notification],
      auditEvents: input.auditEvents,
    };
  }
  const baseReport = buildMovieReport(
    t.title,
    meta,
    input.landed,
    input.subtitleFallback ?? false,
  );
  // 别甩锅: nothing landed could mean truly no resource (no_coverage), the account
  // was systemically blocked (115 云下载配额不足/登录过期), OR the search source
  // itself was down all run (源挂了 6 天却报「暂未找到资源」的那个真实案例) — say which.
  // 电影与剧集共用 emptyRunOutcome,所以这两条必须同时接,否则电影仍在撒谎。
  const report = input.obtained
    ? baseReport
    : {
        ...baseReport,
        ...emptyRunOutcome(
          classifyTransferBlock(input.attempts)?.reason ?? null,
          classifySearchSourceFault(input.auditEvents)?.reason ?? null,
        ),
      };
  const notification: NotificationEvent = {
    id: `notification_${input.request.workflowRunId}`,
    workflowRunId: input.request.workflowRunId,
    // A systemic transfer block → report.status "failed" → distinct kind so the
    // leading icon + daily-digest don't count it as 暂无资源.
    kind: report.status === "failed" ? "transfer_failed" : input.kind,
    title: input.request.title.title,
    body: formatReportPushText(report),
    createdAt: input.now(),
    trigger: "user",
    report,
  };

  return {
    status: input.status,
    title: input.request.title,
    season,
    episodes,
    resourceSnapshots: input.snapshots,
    transferAttempts: input.attempts,
    decisions: input.decisions,
    notification,
    notifications: [notification],
    auditEvents: input.auditEvents,
  };
}
