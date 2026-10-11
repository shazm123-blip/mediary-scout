import type { ResourceCandidate } from "./domain.js";

export type MovieQualityTier = 1 | 2 | 3 | 4 | 5 | 6;

export interface RankedMovieCandidate {
  id: string;
  title: string;
  tier: MovieQualityTier | null;
  /** Explicit ISO evidence even when resolution is unknown. */
  isoHint?: boolean;
  qualityLabel: string;
  dolbyVision: boolean;
  atmos: boolean;
  source: string;
  driveLabel: string;
  sizeBytes: number | null;
  subtitleLabel: string;
  evidenceSource: "发布名称" | "实际文件清单";
  recommendation: string;
  /** Search-result fallback was not included in an AI submitCandidates call. */
  identityPending?: boolean;
  /** Filename/title tokens only. These are clues, not verified media tracks. */
  evidence: string[];
}

const LABELS: Record<MovieQualityTier, string> = {
  1: "BD ISO 4K",
  2: "BD REMUX 4K",
  3: "普通 4K",
  4: "BD ISO 1080P",
  5: "BD REMUX 1080P",
  6: "普通 1080P",
};
const DRIVE_LABELS: Record<ResourceCandidate["type"], string> = {
  "115": "115", magnet: "磁力", manual: "手动", quark: "夸克", tianyi: "天翼", "123": "123", guangya: "光鸭",
};

/** BDMV is a directory structure, even if a release title also mentions ISO. */
export function isBdmvCandidate(candidate: Pick<ResourceCandidate, "title" | "providerPayload">): boolean {
  const evidence = [candidate.title, ...payloadNames(candidate.providerPayload)].join(" ");
  return /(?:^|[^a-z0-9])BDMV(?:$|[^a-z0-9])|blu[ ._-]*ray[ ._-]*folder|蓝光目录/i.test(evidence);
}

/** Unknown resolution is intentionally not guessed into 1080P. */
export function classifyMovieCandidate(candidate: ResourceCandidate): RankedMovieCandidate | null {
  if (isBdmvCandidate(candidate)) return null;
  const title = candidate.title;
  const fileNames = payloadNames(candidate.providerPayload);
  const fourK = /(?:^|[^a-z0-9])(?:2160p?|4k|uhd)(?:$|[^a-z0-9])/i.test(title);
  const fullHd = /(?:^|[^a-z0-9])(?:1080p?|fhd)(?:$|[^a-z0-9])/i.test(title);
  const isoFromFiles = fileNames.some((name) => /\.iso$/i.test(name));
  const iso = isoFromFiles || /(?:\.iso(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:bd[ ._-]*iso|iso[ ._-]*bd|iso|原盘镜像)(?:$|[^a-z0-9]))/i.test(title);
  const remux = /(?:^|[^a-z0-9])(?:remux|bd[ ._-]*remux)(?:$|[^a-z0-9])/i.test(title);
  const ambiguousDisc = /蓝光原盘|(?<!镜像)原盘/.test(title) && !iso && !remux;
  const tier: MovieQualityTier | null = fourK === fullHd || ambiguousDisc
    ? null : fourK ? (iso ? 1 : remux ? 2 : 3) : iso ? 4 : remux ? 5 : 6;
  const dolbyVision = /(?:^|[^a-z0-9])(?:dolby[ ._-]*vision|do[ ._-]*vi|dovi|dv)(?:$|[^a-z0-9])|杜比视界/i.test(title);
  const atmos = /(?:^|[^a-z0-9])(?:dolby[ ._-]*atmos|atmos)(?:$|[^a-z0-9])|杜比全景声/i.test(title);
  const payloadSize = candidate.providerPayload["sizeBytes"];
  const sizeBytes = typeof payloadSize === "number" && Number.isFinite(payloadSize) && payloadSize > 0 ? payloadSize : null;
  const subtitleLabel = /(?:中英双字|简繁|中文字幕|中字|chs|cht|chinese[ ._-]*sub)/i.test(title)
    ? "标题标注中文字幕"
    : "字幕未知";
  return {
    id: candidate.id,
    title,
    tier,
    ...(iso ? { isoHint: true } : {}),
    qualityLabel: tier === null ? "画质待确认" : LABELS[tier],
    dolbyVision,
    atmos,
    source: candidate.source,
    driveLabel: DRIVE_LABELS[candidate.type],
    sizeBytes,
    subtitleLabel,
    evidenceSource: isoFromFiles ? "实际文件清单" : "发布名称",
    recommendation: `${tier === null ? "画质信息不足，需核对实际文件；排在已分档候选之后" : `第 ${tier} 档`}${dolbyVision && atmos ? "；标题标注杜比视界和 Atmos" : dolbyVision ? "；标题标注杜比视界" : atmos ? "；标题标注 Atmos" : ""}`,
    evidence: [...(fourK ? ["发布名称含 4K/2160P/UHD"] : []), ...(fullHd ? ["发布名称含 1080P/FHD"] : []), ...(ambiguousDisc ? ["发布名称仅称原盘，未确认 ISO 或 BDMV"] : []), ...(isoFromFiles ? ["实际文件清单含 .iso"] : iso ? ["发布名称含 ISO"] : remux ? ["发布名称含 REMUX"] : []), ...(dolbyVision ? ["标题含杜比视界标记"] : []), ...(atmos ? ["标题含 Atmos 标记"] : [])],
  };
}

export function rankMovieCandidates(candidates: readonly ResourceCandidate[]): RankedMovieCandidate[] {
  return candidates.flatMap((candidate) => {
    const ranked = classifyMovieCandidate(candidate);
    return ranked ? [ranked] : [];
  }).sort((a, b) => (a.tier ?? Infinity) - (b.tier ?? Infinity) ||
    Number(b.dolbyVision) + Number(b.atmos) - Number(a.dolbyVision) - Number(a.atmos) ||
    0);
}

export function compareMovieUpgrade(
  candidate: Pick<RankedMovieCandidate, "tier" | "dolbyVision" | "atmos">,
  current: readonly { tier: MovieQualityTier | null; dolbyVision: boolean; atmos: boolean }[],
): "better" | "incomparable" | "not_better" {
  if (candidate.tier === null || current.length === 0 || current.some((asset) => asset.tier === null)) return "incomparable";
  const best = [...current].sort((a, b) => (a.tier! - b.tier!) ||
    (Number(b.dolbyVision) + Number(b.atmos)) - (Number(a.dolbyVision) + Number(a.atmos)))[0]!;
  if (candidate.tier < best.tier!) return "better";
  if (candidate.tier > best.tier!) return "not_better";
  return Number(candidate.dolbyVision) + Number(candidate.atmos) > Number(best.dolbyVision) + Number(best.atmos)
    ? "better" : "not_better";
}

export function classifyExistingMovieAsset(path: string, sizeBytes: number) {
  const candidate = classifyMovieCandidate({
    id: path, snapshotId: "existing", index: 0, title: path, type: "manual", source: "existing",
    providerPayload: {},
  } as ResourceCandidate);
  return { name: path.split("/").pop() ?? path, sizeBytes, tier: candidate?.tier ?? null,
    dolbyVision: candidate?.dolbyVision ?? false, atmos: candidate?.atmos ?? false };
}

function payloadNames(payload: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ["filename", "fileName", "path", "files"]) {
    const value = payload[key];
    if (typeof value === "string") names.push(value);
    if (Array.isArray(value)) {
      for (const file of value) {
        if (file && typeof file === "object") {
          const path = (file as Record<string, unknown>)["path"];
          if (typeof path === "string") names.push(path);
        }
      }
    }
  }
  return names;
}
