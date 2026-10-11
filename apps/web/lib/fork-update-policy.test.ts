import { afterEach, describe, expect, it, vi } from "vitest";
import { isForkBuild } from "./fork-update-policy";
import { requestUpdate } from "./updater-client";

afterEach(() => vi.unstubAllEnvs());

describe("custom build update protection", () => {
  it("blocks an upstream tag before reading credentials or calling the updater", async () => {
    vi.stubEnv("MEDIA_TRACK_FORK_BUILD", "1");
    const fetchImpl = vi.fn();
    expect(await requestUpdate("v2026.10.11", { stateDir: "/nonexistent", fetchImpl })).toEqual({
      ok: false,
      reason: "fork_protected",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not change the upstream non-custom path", () => {
    vi.stubEnv("MEDIA_TRACK_FORK_BUILD", "0");
    expect(isForkBuild()).toBe(false);
  });
});
