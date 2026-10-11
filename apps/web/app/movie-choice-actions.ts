"use server";

import { revalidatePath } from "next/cache";
import { assertNotDemo } from "../lib/demo-mode";

export async function chooseMovieCandidateAction(
  runId: string,
  candidateId: string,
  storageId?: string,
): Promise<{ success: boolean; message?: string }> {
  assertNotDemo();
  if (!runId || !candidateId || runId.length > 160 || candidateId.length > 250) {
    return { success: false, message: "候选资源无效。" };
  }
  const { getWorkflowRepository, requireAuthenticatedAccountId, getActiveWorkspaceScope } = await import("../lib/workflow-runtime");
  const accountId = await requireAuthenticatedAccountId();
  const scope = await getActiveWorkspaceScope(storageId);
  if (scope.accountId !== accountId) return { success: false, message: "网盘工作区不可用。" };
  const repo = getWorkflowRepository();
  const snapshot = await repo.getWorkflowRunSnapshot(runId, scope);
  if (!snapshot || snapshot.title.type !== "movie") return { success: false, message: "待选任务不存在。" };
  if (snapshot.connectedStorageId !== scope.connectedStorageId) return { success: false, message: "待选任务不属于当前网盘。" };
  if (snapshot.resourceSnapshots.some((row) => row.candidates.some((item) => item.id === candidateId && (item.type === "magnet" || item.type === "manual"))))
    return { success: false, message: "此来源无法在转存前只读核验，请选择可核验的网盘分享。" };
  const result = await repo.chooseMovieCandidate({
    workflowRunId: runId,
    candidateId,
    scope,
  });
  if (result === "unavailable") return { success: false, message: "该资源不可选，请刷新列表。" };
  revalidatePath(`/show/${snapshot.title.tmdbId}`);
  revalidatePath("/activity");
  return { success: true };
}

export async function restartMovieChoiceSearchAction(runId: string, storageId?: string): Promise<{ success: boolean; message?: string }> {
  assertNotDemo();
  if (!runId || runId.length > 160) return { success: false, message: "待选任务无效。" };
  const { getWorkflowRepository, requireAuthenticatedAccountId, getActiveWorkspaceScope } = await import("../lib/workflow-runtime");
  const accountId = await requireAuthenticatedAccountId();
  const scope = await getActiveWorkspaceScope(storageId);
  if (scope.accountId !== accountId) return { success: false, message: "网盘工作区不可用。" };
  const repo = getWorkflowRepository();
  const snapshot = await repo.getWorkflowRunSnapshot(runId, scope);
  if (!snapshot || snapshot.title.type !== "movie" || snapshot.connectedStorageId !== scope.connectedStorageId)
    return { success: false, message: "待选任务不存在。" };
  if (!await repo.restartMovieChoiceSearch({ workflowRunId: runId, scope }))
    return { success: false, message: "任务已变化，请刷新后重试。" };
  revalidatePath(`/show/${snapshot.title.tmdbId}`);
  revalidatePath("/activity");
  return { success: true };
}
