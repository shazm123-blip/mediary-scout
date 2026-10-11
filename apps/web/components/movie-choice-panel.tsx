"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import { chooseMovieCandidateAction, restartMovieChoiceSearchAction } from "../app/movie-choice-actions";
import type { MovieChoicesView } from "../lib/movie-choice-server";

const TIERS = [
  "BD ISO 4K",
  "BD REMUX 4K",
  "普通 4K",
  "BD ISO 1080P",
  "BD REMUX 1080P",
  "普通 1080P",
] as const;

function sizeLabel(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "大小未知";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function requiresMovieChoiceAcknowledgement(candidate: MovieChoicesView["candidates"][number] | undefined): boolean {
  return candidate?.tier === null || candidate?.identityPending === true;
}

export function MovieChoicePanel({ view, storageId }: { view: MovieChoicesView; storageId?: string | undefined }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmedUncertain, setConfirmedUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const awaiting = view.status === "awaiting_choice";
  const selected = view.candidates.find((candidate) => candidate.id === selectedId && !candidate.preflightUnsupported);
  const upgrade = view.isUpgrade;
  const incomparable = upgrade && (selected?.comparison === "incomparable" || selected?.tier === null);
  const needsConfirmation = requiresMovieChoiceAcknowledgement(selected);
  const rankedCandidates = view.candidates.filter((candidate) => candidate.tier !== null);
  const uncertainCandidates = view.candidates.filter((candidate) => candidate.tier === null);
  const missingTiers = TIERS.filter((_, index) => !view.candidates.some((candidate) => candidate.tier === index + 1));

  const choose = () => {
    if (!selected || !awaiting || isPending || (needsConfirmation && !confirmedUncertain)) return;
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await chooseMovieCandidateAction(view.runId, selected.id, storageId);
        if (result.success) {
          setMessage(upgrade ? "已提交更新，正在获取并验证新版。" : "已提交选中的版本，正在继续获取。");
          router.refresh();
        } else {
          setMessage(result.message ?? "提交失败，请刷新候选列表后重试。");
        }
      } catch {
        setMessage("提交失败，请刷新候选列表后重试。");
      }
    });
  };
  const searchAgain = () => {
    if (!awaiting || isPending) return;
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await restartMovieChoiceSearchAction(view.runId, storageId);
        if (result.success) {
          setSelectedId(null);
          setMessage("已重新开始搜索，新的候选会显示在这里。");
          router.refresh();
        } else setMessage(result.message ?? "暂时无法重新搜索，请刷新后重试。");
      } catch { setMessage("暂时无法重新搜索，请刷新后重试。"); }
    });
  };

  return (
    <section className="movie-choice-panel" aria-labelledby="movie-choice-heading">
      <div className="movie-choice-head">
        <div>
          <h2 id="movie-choice-heading">{upgrade ? "选择更好的电影版本" : "选择电影版本"}</h2>
          <p>
            {awaiting
              ? upgrade ? "AI 已整理候选。先获取并验证新版，再清理可确定被替换的旧版；当前画质未知时保留旧版。" : "AI 已整理候选。请确认版本；选定前不会转存，资源链接将在转存时检查。"
              : "所选版本已提交，AI 正在继续处理。"}
          </p>
        </div>
        <div className="movie-choice-badges">
          {awaiting ? <button type="button" className="movie-choice-refresh" onClick={searchAgain} disabled={isPending}>重新搜索</button> : null}
          <button type="button" className="movie-choice-refresh" onClick={() => router.refresh()} aria-label="刷新候选列表">
            <RefreshCw size={14} aria-hidden /> 刷新
          </button>
        </div>
      </div>
      {view.lastFailure ? <p className="movie-choice-message" role="alert">上次所选资源未获取：{view.lastFailure.reason}。请检查标记后重新选择。</p> : null}
      {upgrade ? (
        <div className="movie-choice-current">
          <h3>当前版本</h3>
          {view.currentAssets.length === 0 ? <p>暂无能确认身份的旧正片，无法比较画质；获取新版会保留旧文件。</p> : null}
          <ul>
            {view.currentAssets.map((asset, index) => (
              <li key={`${asset.name}-${index}`}>
                <strong>{asset.tier ? `第 ${asset.tier} 档 · ${TIERS[asset.tier - 1]}` : "画质未知 · 无法比较"}</strong>
                <span>{asset.name}</span>
                <span>{sizeLabel(asset.sizeBytes)} · {asset.dolbyVision ? "杜比视界" : "杜比视界未见标记"} · {asset.atmos ? "Atmos" : "Atmos 未见标记"}</span>
              </li>
            ))}
          </ul>
          <p>当前版本依据实际文件名识别；候选依据下方来源标注识别，均未探测视频轨道。</p>
        </div>
      ) : null}
      <p className="movie-choice-rule">
        优先级：{TIERS.map((label, index) => `${index + 1}. ${label}`).join(" → ")}。同档双杜比优先，其次单杜比；已识别的 BDMV 排除，转存前再次核验。
      </p>
      {!upgrade && missingTiers.length > 0 ? <p className="movie-choice-rule">本次未找到：{missingTiers.join("、")}。仅代表本次搜索结果。</p> : null}
      {view.candidates.length === 0 ? (
        <p className="movie-choice-empty" role="status">暂无可选资源。可稍后刷新查看；当前不会自动改选其他版本。</p>
      ) : (
        <div className="movie-choice-list" role="radiogroup" aria-label="电影候选版本">
          {[rankedCandidates, uncertainCandidates].map((group, index) => group.length > 0 ? (
            <div key={index} className="movie-choice-list">
              {index === 1 ? <h3>待确认 · 不参与六档排序</h3> : null}
              {group.map((candidate) => (
            <label key={candidate.id} className={`movie-choice-card${selectedId === candidate.id ? " is-selected" : ""}`}>
              <input
                type="radio"
                name={`movie-choice-${view.runId}`}
                value={candidate.id}
                checked={selectedId === candidate.id}
                onChange={() => { setSelectedId(candidate.id); setConfirmedUncertain(false); setMessage(null); }}
                disabled={!awaiting || isPending || candidate.preflightUnsupported}
              />
              <span className="movie-choice-content">
                <span className="movie-choice-badges">
                  <strong>{candidate.tier === null ? "画质/原盘格式待确认" : `第 ${candidate.tier} 档 · ${candidate.qualityLabel}`}</strong>
                  {candidate.identityPending ? <strong>AI 未确认 · 片名和年份待核对</strong> : null}
                  {upgrade ? <strong>{candidate.tier !== null && candidate.comparison === "better" ? "优于当前版本" : "当前或候选画质未知 · 无法比较"}</strong> : null}
                  <span>{candidate.dolbyVision ? "杜比视界" : "杜比视界未见标记"}</span>
                  <span>{candidate.atmos ? "Atmos" : "Atmos 未见标记"}</span>
                  <span>资源来源：{candidate.driveLabel}</span>
                  {candidate.preflightUnsupported ? <strong>无法只读核验 · 当前不支持转存</strong> : null}
                </span>
                <strong className="movie-choice-title">{candidate.title}</strong>
                <span className="movie-choice-details">
                  <span>{sizeLabel(candidate.sizeBytes)}</span>
                  <span>字幕：{candidate.subtitleLabel}</span>
                  <span>搜索来源：{candidate.source}</span>
                  <span>转存到：{view.targetDriveLabel || "当前网盘"}</span>
                  <span>链接状态：待转存检查</span>
                  <span>文件清单：{candidate.preflightUnsupported ? "当前来源不支持预检" : "选定后只读核验，无法核验不转存"}</span>
                </span>
                <span className="movie-choice-evidence">
                  {candidate.recommendation} · 识别依据：{candidate.evidenceSource}
                  {candidate.evidence.length > 0 ? `（${candidate.evidence.join("、")}）` : "（详情待确认）"}
                </span>
                {view.lastFailure?.candidateId === candidate.id ? <strong className="movie-choice-message">上次选择失败：{view.lastFailure.reason}</strong> : null}
              </span>
            </label>
              ))}
            </div>
          ) : null)}
        </div>
      )}
      {awaiting && view.candidates.length > 0 ? (
        <>
          {upgrade && selected ? <p className="movie-choice-message">{incomparable ? "无法确认比当前更好，本次获取将保留旧文件。" : "新版验证成功后，将删除被替换的旧正片及其配对字幕；失败保留旧版。"}</p> : null}
          {needsConfirmation ? (
            <label className="movie-choice-message">
              <input type="checkbox" checked={confirmedUncertain} onChange={(event) => setConfirmedUncertain(event.target.checked)} disabled={isPending} />
              我已核对片名、年份与来源，了解画质或影片身份仍待确认；转存前会再次核验。
            </label>
          ) : null}
          <button type="button" className="primary-button movie-choice-submit" disabled={!selected || isPending || (needsConfirmation && !confirmedUncertain)} onClick={choose}>
            {isPending ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Check size={15} aria-hidden />}
            {isPending ? "正在提交…" : upgrade ? incomparable ? "获取所选版本，保留旧版" : "更新为所选版本" : "转存所选资源"}
          </button>
        </>
      ) : null}
      {message ? <p className="movie-choice-message" role="status">{message}</p> : null}
    </section>
  );
}
