import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ values: new Map<string, string>(), globalValues: new Map<string, string>(), writes: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/demo-mode", () => ({ assertNotDemo: vi.fn() }));
vi.mock("../lib/workflow-runtime", () => ({
  queueCandidateSeries: vi.fn(), queueCandidateTracking: vi.fn(), reserveCandidate: vi.fn(),
  QUALITY_PREFERENCE_SETTING_KEY: "quality_preference",
  MOVIE_QUALITY_PREFERENCE_SETTING_KEY: "movie_quality_preference",
  getCurrentAccountId: async () => "account_a",
  getAccountScopedSettings: () => ({
    getSetting: async (key: string) => settings.values.get(key) || settings.globalValues.get(key) || null,
  }),
  getWorkflowRepository: () => ({
    getAccountSetting: async (_account: string, key: string) => settings.values.get(key) ?? null,
    setAccountSetting: async (account: string, key: string, value: string) => {
      settings.writes(account, key, value);
      settings.values.set(key, value);
    },
  }),
}));
import { saveMovieQualityPreferenceAction, saveQualityPreferenceAction } from "./actions";

beforeEach(() => { settings.values.clear(); settings.globalValues.clear(); settings.writes.mockClear(); });

describe("independent quality settings saves", () => {
  it("saving movie choice does not overwrite the series preference", async () => {
    settings.values.set("quality_preference", "high");
    expect(await saveMovieQualityPreferenceAction("blu-ray-iso")).toEqual({ success: true });
    expect(settings.values.get("quality_preference")).toBe("high");
    expect(settings.writes.mock.calls).toEqual([["account_a", "movie_quality_preference", "blu-ray-iso"]]);
  });

  it("migrates the legacy movie mode before saving a new series preference", async () => {
    settings.values.set("quality_preference", "blu-ray-iso");
    expect(await saveQualityPreferenceAction("medium")).toEqual({ success: true });
    expect(settings.values.get("movie_quality_preference")).toBe("blu-ray-iso");
    expect(settings.values.get("quality_preference")).toBe("medium");
  });

  it("does not re-enable a movie preference explicitly switched off", async () => {
    settings.values.set("quality_preference", "blu-ray-iso");
    settings.values.set("movie_quality_preference", "any");
    await saveQualityPreferenceAction("high");
    expect(settings.values.get("movie_quality_preference")).toBe("any");
    expect(settings.writes).toHaveBeenCalledTimes(1);
  });

  it("preserves inherited global legacy movie mode when setting account series quality", async () => {
    settings.globalValues.set("quality_preference", "blu-ray-iso");
    await saveQualityPreferenceAction("high");
    expect(settings.values.get("movie_quality_preference")).toBe("blu-ray-iso");
    expect(settings.values.get("quality_preference")).toBe("high");
    expect(settings.globalValues.get("quality_preference")).toBe("blu-ray-iso");
  });

  it("rejects mixed setting values without writing", async () => {
    expect(await saveQualityPreferenceAction("blu-ray-iso")).toMatchObject({ success: false });
    expect(await saveMovieQualityPreferenceAction("high")).toMatchObject({ success: false });
    expect(settings.writes).not.toHaveBeenCalled();
  });
});
