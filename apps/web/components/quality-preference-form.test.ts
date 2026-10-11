import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QualityPreferenceForm } from "./quality-preference-form";

vi.mock("../app/actions", () => ({
  saveQualityPreferenceAction: vi.fn(),
  saveMovieQualityPreferenceAction: vi.fn(),
}));

describe("QualityPreferenceForm", () => {
  it("separates series/anime quality from the movie choice mode", () => {
    const html = renderToStaticMarkup(createElement(QualityPreferenceForm, {
      initial: "high", movieQualityPreference: "blu-ray-iso",
    }));
    expect(html).toContain('aria-label="剧集和动漫偏好画质"');
    expect(html).toContain('aria-label="电影偏好画质"');
    expect(html).toContain('<option value="high" selected="">');
    expect(html).toContain('<option value="blu-ray-iso" selected="">');
    expect(html).toContain("6. 普通 1080P");
    expect((html.match(/value="blu-ray-iso"/g) ?? []).length).toBe(1);
  });

  it("explains that an overwritten legacy series preference cannot be recovered", () => {
    const html = renderToStaticMarkup(createElement(QualityPreferenceForm, {
      initial: "any", movieQualityPreference: "blu-ray-iso", legacyQualityWasMovieMode: true,
    }));
    expect(html).toContain("原设置无法恢复");
    expect(html).toContain("重新选择剧集和动漫");
  });
});
