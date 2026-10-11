import { describe, expect, it, vi } from "vitest";
import { inspectShareTree, preflightChosenMovieSource } from "../src/movie-share-preflight.js";
import type { ResourceCandidate } from "../src/domain.js";
import type { StorageExecutor } from "../src/ports.js";

const candidate: ResourceCandidate = {
  id: "chosen", snapshotId: "snap", index: 0, title: "Film 2160p ISO", type: "115", source: "offline", providerPayload: {},
};

describe("movie share preflight", () => {
  it("walks every nested directory and rejects BDMV even when an ISO is also present", async () => {
    const list = vi.fn(async (parent: string) => parent === ""
      ? [{ id: "iso", name: "Film.iso", directory: false }, { id: "folder", name: "Extras", directory: true }]
      : parent === "folder" ? [{ id: "bdmv", name: "BDMV", directory: true }] : []);
    const tree = await inspectShareTree(list, "");
    expect(tree).toEqual({ files: ["Film.iso"], directories: ["Extras", "Extras/BDMV"] });
    await expect(preflightChosenMovieSource({ storage: { inspectCandidateShare: async () => tree } as unknown as StorageExecutor,
      candidate, expectIso: true })).rejects.toThrow("MOVIE_SHARE_PREFLIGHT_BDMV");
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("accepts a standalone ISO and standalone m2ts but rejects absent inspection", async () => {
    const storage = { inspectCandidateShare: async () => ({ files: ["Film.iso"], directories: [] }) } as unknown as StorageExecutor;
    await expect(preflightChosenMovieSource({ storage, candidate, expectIso: true })).resolves.toEqual({ isIso: true });
    await expect(preflightChosenMovieSource({ storage: { inspectCandidateShare: async () => ({ files: ["Film.m2ts"], directories: [] }) } as unknown as StorageExecutor,
      candidate, expectIso: false })).resolves.toEqual({ isIso: false });
    await expect(preflightChosenMovieSource({ storage: {} as StorageExecutor, candidate, expectIso: true }))
      .rejects.toThrow("MOVIE_SHARE_PREFLIGHT_UNSUPPORTED");
    await expect(preflightChosenMovieSource({ storage, candidate: { ...candidate, type: "magnet" }, expectIso: true }))
      .rejects.toThrow("MOVIE_SHARE_PREFLIGHT_UNSUPPORTED");
  });

  it.each([["Film.iso", true], ["Film.mkv", false]])("detects unknown-format %s from the actual share", async (file, isIso) => {
    const storage = { inspectCandidateShare: async () => ({ files: [file], directories: [] }) } as unknown as StorageExecutor;
    await expect(preflightChosenMovieSource({ storage, candidate, expectIso: null })).resolves.toEqual({ isIso });
  });

  it("does not mistake an ISO release for a regular video because it includes a sample", async () => {
    const storage = { inspectCandidateShare: async () => ({ files: ["Film.iso", "sample.mp4"], directories: [] }) } as unknown as StorageExecutor;
    await expect(preflightChosenMovieSource({ storage, candidate, expectIso: null })).resolves.toEqual({ isIso: true });
  });

  it("fails closed on incomplete nested listing", async () => {
    await expect(inspectShareTree(async (parent) => parent === "" ? [{ id: "folder", name: "Pack", directory: true }]
      : Promise.reject(new Error("MOVIE_SHARE_PREFLIGHT_INCOMPLETE")), ""))
      .rejects.toThrow("MOVIE_SHARE_PREFLIGHT_INCOMPLETE");
    await expect(preflightChosenMovieSource({ storage: { inspectCandidateShare: async () => { throw new Error("network down"); } } as unknown as StorageExecutor,
      candidate, expectIso: true })).rejects.toThrow("MOVIE_SHARE_PREFLIGHT_INCOMPLETE");
  });
});
