"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { saveMovieQualityPreferenceAction, saveQualityPreferenceAction } from "../app/actions";
import { runAction } from "../lib/run-action";

const SERIES_QUALITIES = [
  { key: "any", label: "不限（默认）" },
  { key: "high", label: "高画质（≈4K）" },
  { key: "medium", label: "中画质（≈1080p）" },
] as const;

export function QualityPreferenceForm({
  initial,
  movieQualityPreference,
  legacyQualityWasMovieMode = false,
}: {
  initial: string;
  movieQualityPreference: string;
  legacyQualityWasMovieMode?: boolean;
}) {
  const [seriesPending, startSeriesTransition] = useTransition();
  const [moviePending, startMovieTransition] = useTransition();
  const [seriesValue, setSeriesValue] = useState(initial);
  const [movieValue, setMovieValue] = useState(movieQualityPreference);
  const [showLegacyWarning, setShowLegacyWarning] = useState(legacyQualityWasMovieMode);
  const [seriesResult, setSeriesResult] = useState<string | null>(null);
  const [movieResult, setMovieResult] = useState<string | null>(null);

  const saveSeries = () => {
    startSeriesTransition(async () => {
      const r = await runAction(
        () => saveQualityPreferenceAction(seriesValue),
        (msg) => setSeriesResult(`❌ ${msg}`),
      );
      if (!r.ok) return;
      if (r.value.success) setShowLegacyWarning(false);
      setSeriesResult(r.value.success ? "✅ 保存成功" : `❌ ${r.value.message ?? "保存失败"}`);
    });
  };

  const saveMovie = () => {
    startMovieTransition(async () => {
      const r = await runAction(
        () => saveMovieQualityPreferenceAction(movieValue),
        (msg) => setMovieResult(`❌ ${msg}`),
      );
      if (!r.ok) return;
      setMovieResult(r.value.success ? "✅ 保存成功" : `❌ ${r.value.message ?? "保存失败"}`);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>剧集和动漫的偏好画质会作为选片优先级传给 AI。</p>
      {showLegacyWarning ? (
        <p className="panel-note" style={{ marginBottom: 12 }} role="status">
          旧版电影模式曾覆盖剧集画质偏好，原设置无法恢复。请重新选择剧集和动漫的画质偏好。
        </p>
      ) : null}
      <div className="setting-row">
        <select
          value={seriesValue}
          onChange={(event) => { setSeriesValue(event.target.value); setSeriesResult(null); }}
          className="setting-control"
          aria-label="剧集和动漫偏好画质"
        >
          {SERIES_QUALITIES.map((quality) => <option key={quality.key} value={quality.key}>{quality.label}</option>)}
        </select>
        <button type="button" className="primary-button" onClick={saveSeries} disabled={seriesPending} aria-label="保存剧集和动漫偏好画质">
          {seriesPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
      </div>
      {seriesResult ? <p className="panel-note" role="status" style={{ marginTop: 8 }}>{seriesResult}</p> : null}

      <p className="panel-note" style={{ margin: "20px 0 12px" }}>电影画质偏好单独保存，不影响剧集和动漫。</p>
      <div className="setting-row">
        <select
          value={movieValue}
          onChange={(event) => { setMovieValue(event.target.value); setMovieResult(null); }}
          className="setting-control"
          aria-label="电影偏好画质"
        >
          <option value="any">不限（默认）</option>
          <option value="blu-ray-iso">蓝光 ISO 优先（选源后获取）</option>
        </select>
        <button type="button" className="primary-button" onClick={saveMovie} disabled={moviePending} aria-label="保存电影偏好画质">
          {moviePending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
      </div>
      {movieResult ? <p className="panel-note" role="status" style={{ marginTop: 8 }}>{movieResult}</p> : null}
      {movieValue === "blu-ray-iso" ? (
        <p className="panel-note" style={{ marginTop: 12 }}>
          AI 搜索后按 1. BD ISO 4K → 2. BD REMUX 4K → 3. 普通 4K → 4. BD ISO 1080P → 5. BD REMUX 1080P → 6. 普通 1080P 排序。同档双杜比优先，其次单杜比；BDMV 排除。画质无法确认的资源单独列出，选定前不会转存。
        </p>
      ) : null}
    </div>
  );
}
