"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { queueMovieUpgradeAction } from "../app/movie-upgrade-actions";
import { useRouter } from "../lib/use-router";

export function MovieUpgradeButton({ tmdbId, storageId, acquiring = false }: {
  tmdbId: number;
  storageId: string | undefined;
  acquiring?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="movie-upgrade-action">
      <button
        type="button"
        className="primary-button"
        disabled={isPending || acquiring}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            try {
              const result = await queueMovieUpgradeAction(tmdbId, storageId);
              setMessage(result.message ?? (result.success ? "已开始寻找，找到候选后由你选择更新。" : "未能开始搜索，请稍后重试。"));
              if (result.success) router.refresh();
            } catch {
              setMessage("未能开始搜索，请刷新页面后重试。");
            }
          });
        }}
      >
        {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Search size={14} aria-hidden />}
        {isPending ? "正在寻找更好画质…" : "寻找更好画质"}
      </button>
      {message ? <p className="movie-choice-message" role="status">{message}</p> : null}
    </div>
  );
}
