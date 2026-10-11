import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MovieChoicePanel, requiresMovieChoiceAcknowledgement } from "./movie-choice-panel";
import type { MovieChoicesView } from "../lib/movie-choice-server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../app/movie-choice-actions", () => ({ chooseMovieCandidateAction: vi.fn(), restartMovieChoiceSearchAction: vi.fn() }));

const view: MovieChoicesView = {
  runId: "run-1",
  status: "awaiting_choice",
  isUpgrade: false,
  currentAssets: [],
  targetDriveLabel: "115 · 测试网盘",
  candidates: [{
    id: "resource-1",
    title: "Film.2160p.BD.ISO.DV.Atmos",
    tier: 1,
    qualityLabel: "BD ISO 4K",
    dolbyVision: true,
    atmos: true,
    source: "PanSou",
    driveLabel: "115",
    sizeBytes: null,
    subtitleLabel: "未知",
    evidenceSource: "发布名称",
    recommendation: "画质优先级最高",
    evidence: ["2160p", "ISO"],
  }],
};

describe("MovieChoicePanel", () => {
  it("shows the rank, Dolby tags, drive, unknown metadata, and evidence before transfer", () => {
    const html = renderToStaticMarkup(createElement(MovieChoicePanel, { view }));
    expect(html).toContain("第 1 档 · BD ISO 4K");
    expect(html).toContain("杜比视界");
    expect(html).toContain("Atmos");
    expect(html).toContain("资源来源：115");
    expect(html).toContain("转存到：115 · 测试网盘");
    expect(html).toContain("链接状态：待转存检查");
    expect(html).toContain("大小未知");
    expect(html).toContain("字幕：未知");
    expect(html).toContain("识别依据：发布名称");
    expect(html).toContain("Film.2160p.BD.ISO.DV.Atmos");
    expect(html).toContain("转存所选资源");
    expect(html).toContain("disabled");
  });

  it("does not claim unmarked Dolby tracks are absent or let a running task choose again", () => {
    const html = renderToStaticMarkup(createElement(MovieChoicePanel, {
      view: { ...view, status: "running", candidates: [{ ...view.candidates[0]!, dolbyVision: false, atmos: false }] },
    }));
    expect(html).toContain("杜比视界未见标记");
    expect(html).toContain("Atmos 未见标记");
    expect(html).not.toContain("转存所选资源");
  });

  it("shows current quality and upgrade comparison before the explicit update choice", () => {
    const html = renderToStaticMarkup(createElement(MovieChoicePanel, {
      view: {
        ...view, isUpgrade: true,
        currentAssets: [{ name: "Film.1080p.mkv", sizeBytes: 8 * 1024 ** 3, tier: 6, dolbyVision: false, atmos: false }],
        candidates: [{ ...view.candidates[0]!, comparison: "better" }],
      },
    }));
    expect(html).toContain("当前版本");
    expect(html).toContain("第 6 档 · 普通 1080P");
    expect(html).toContain("优于当前版本");
    expect(html).toContain("更新为所选版本");
    expect(html).toContain("先获取并验证新版");
  });

  it("labels unknown current quality as incomparable and promises to keep old files", () => {
    const html = renderToStaticMarkup(createElement(MovieChoicePanel, {
      view: {
        ...view, isUpgrade: true,
        currentAssets: [{ name: "Film.mkv", sizeBytes: 0, tier: null, dolbyVision: false, atmos: false }],
        candidates: [{ ...view.candidates[0]!, comparison: "incomparable" }],
      },
    }));
    expect(html).toContain("画质未知 · 无法比较");
    expect(html).toContain("当前画质未知时保留旧版");
    expect(html).not.toContain("优于当前版本");
  });

  it("shows a persisted, safe failure reason next to the previously chosen candidate", () => {
    const html = renderToStaticMarkup(createElement(MovieChoicePanel, {
      view: { ...view, lastFailure: { candidateId: "resource-1", reason: "分享链接失效或无法转存" } },
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("上次所选资源未获取");
    expect(html).toContain("上次选择失败：分享链接失效或无法转存");
  });

  it("disables sources that cannot be checked before transfer", () => {
    const html = renderToStaticMarkup(createElement(MovieChoicePanel, {
      view: { ...view, candidates: [{ ...view.candidates[0]!, preflightUnsupported: true }] },
    }));
    expect(html).toContain("无法只读核验 · 当前不支持转存");
    expect(html).toMatch(/type="radio"[^>]*disabled/);
  });

  it("lists unranked and AI-unconfirmed candidates separately, requiring explicit acknowledgement", () => {
    const uncertain = { ...view.candidates[0]!, id: "resource-unknown", tier: null, qualityLabel: "待确认", identityPending: true, comparison: "incomparable" as const };
    const html = renderToStaticMarkup(createElement(MovieChoicePanel, {
      view: { ...view, candidates: [view.candidates[0]!, uncertain] },
    }));
    expect(html).toContain("待确认 · 不参与六档排序");
    expect(html).toContain("画质/原盘格式待确认");
    expect(html).toContain("AI 未确认 · 片名和年份待核对");
    expect(html).not.toContain("第 null 档");
    expect(requiresMovieChoiceAcknowledgement(uncertain)).toBe(true);
    expect(requiresMovieChoiceAcknowledgement({ ...view.candidates[0]!, identityPending: true })).toBe(true);
    expect(requiresMovieChoiceAcknowledgement(view.candidates[0])).toBe(false);
  });
});
