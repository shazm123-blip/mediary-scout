"use server";

import { revalidatePath } from "next/cache";
import { queueMovieUpgrade } from "@media-track/workflow";
import { assertNotDemo } from "../lib/demo-mode";

export async function queueMovieUpgradeAction(
  tmdbId: number,
  storageId?: string,
): Promise<{ success: boolean; runId?: string; message?: string }> {
  assertNotDemo();
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return { success: false, message: "电影编号无效。" };
  const { getWorkflowRepository, getActiveWorkspaceScope, requireAuthenticatedAccountId } = await import("../lib/workflow-runtime");
  const accountId = await requireAuthenticatedAccountId();
  const scope = await getActiveWorkspaceScope(storageId);
  if (scope.accountId !== accountId) return { success: false, message: "网盘工作区不可用。" };
  const repo = getWorkflowRepository();
  const drive = (await repo.listConnectedStorages(accountId)).find((item) => item.id === scope.connectedStorageId);
  if (drive?.status === "frozen") return { success: false, message: "网盘连接已冻结，请重新连接。" };
  const state = (await repo.listTrackedSeasonStates(scope)).find((item) =>
    item.title.type === "movie" && item.title.tmdbId === tmdbId && item.episodes.some((episode) => episode.obtained));
  if (!state) return { success: false, message: "尚无已获取的电影，无法检查升级。" };
  const queued = await queueMovieUpgrade({ state, repository: repo });
  if (queued.status !== "queued") return { success: false, message: "该电影已有进行中的任务，请稍后重试。" };
  revalidatePath(`/show/${tmdbId}`);
  revalidatePath("/activity");
  return { success: true, ...(queued.workflowRunId ? { runId: queued.workflowRunId } : {}), message: "已开始寻找，找到候选后由你选择更新。" };
}
