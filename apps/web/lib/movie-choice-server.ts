import { compareMovieUpgrade, type RankedMovieCandidate, type WorkflowRepository, type WorkflowScope } from "@media-track/workflow";

export type MovieChoiceItem = RankedMovieCandidate & { comparison?: "better" | "incomparable"; preflightUnsupported?: boolean };

export interface MovieChoicesView {
  runId: string;
  status: "awaiting_choice" | "queued" | "running";
  candidates: MovieChoiceItem[];
  isUpgrade: boolean;
  currentAssets: Array<{ name: string; sizeBytes: number; tier: 1 | 2 | 3 | 4 | 5 | 6 | null; dolbyVision: boolean; atmos: boolean }>;
  targetDriveLabel: string;
  lastFailure?: { candidateId: string; reason: string };
}

export async function getMovieChoicesView(
  repo: Pick<WorkflowRepository, "listActiveWorkflowRuns" | "listConnectedStorages">,
  scope: WorkflowScope,
  tmdbId: number,
): Promise<MovieChoicesView | null> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const runs = await repo.listActiveWorkflowRuns(scope);
  const snapshot = runs.find((run) => run.title.id === `tmdb_movie_${tmdbId}` &&
    (run.workflowRun.kind === "movie_init" || run.workflowRun.kind === "replace_request") && run.workflowRun.movieChoices?.version === 1);
  if (!snapshot) return null;
  const status = snapshot.workflowRun.status;
  if (status !== "awaiting_choice" && status !== "queued" && status !== "running") return null;
  const currentAssets = snapshot.workflowRun.movieUpgrade?.currentAssets ?? [];
  const drive = (await repo.listConnectedStorages(scope.accountId)).find((item) => item.id === scope.connectedStorageId);
  return {
    runId: snapshot.workflowRun.id,
    status,
    candidates: snapshot.workflowRun.movieChoices!.candidates.map((candidate) => ({ ...candidate,
      ...(snapshot.resourceSnapshots.some((row) => row.candidates.some((item) => item.id === candidate.id && (item.type === "magnet" || item.type === "manual")))
        ? { preflightUnsupported: true } : {}),
      ...(snapshot.workflowRun.movieUpgrade ? { comparison: compareMovieUpgrade(candidate, currentAssets) === "better" ? "better" as const : "incomparable" as const } : {}) })),
    isUpgrade: Boolean(snapshot.workflowRun.movieUpgrade),
    currentAssets,
    targetDriveLabel: drive?.label || drive?.provider || "当前网盘",
    ...(snapshot.workflowRun.movieChoices?.lastFailure ? { lastFailure: snapshot.workflowRun.movieChoices.lastFailure } : {}),
  };
}
