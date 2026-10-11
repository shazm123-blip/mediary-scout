import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runMovieAcquisitionV2 } from "../src/movie-workflow-v2.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { mediaLibraryFolderName } from "../src/media-library-folder.js";
import type { MediaTitle, VerifiedFile } from "../src/domain.js";

const title: MediaTitle = { id: "tmdb_movie_1858", tmdbId: 1858, type: "movie", title: "变形金刚",
  originalTitle: "Transformers", year: 2007, aliases: [] };
const usage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
const file = (id: string, name: string): VerifiedFile => ({ id, providerFileId: id, name, storageDirectoryId: "", sizeBytes: 10_000_000, episodeCode: null });
function model() {
  const steps = [["searchResources", { keyword: title.title }], ["transferCandidate", { snapshotId: "s1", candidateId: "s1-1" }],
    ["inspectTargetDir", {}], ["markObtained", { codes: ["MOVIE"] }], ["finish", {}]] as const;
  let turn = 0;
  return new MockLanguageModelV3({ doGenerate: async () => {
    const step = steps[turn++];
    return step ? { content: [{ type: "tool-call" as const, toolCallId: `c${turn}`, toolName: step[0], input: JSON.stringify(step[1]) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage, warnings: [] }
      : { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage, warnings: [] };
  } });
}
async function run(storage: FakeStorageExecutor) {
  return runMovieAcquisitionV2({ title, storage, moviesParentDirectoryId: "movies", workflowRunId: "naming_run", model: model(),
    resourceProvider: { search: async ({ keyword }) => ({ id: "snapshot", provider: "offline", keyword, createdAt: "2026-10-11T00:00:00Z",
      candidates: [{ id: "source", snapshotId: "snapshot", index: 0, title: "Transformers 2007 2160p REMUX DV Atmos", type: "115", source: "offline", providerPayload: {} }] }) } });
}
function executor(files: VerifiedFile[]) {
  return new FakeStorageExecutor({ transferOutcomes: { source: { status: "succeeded", providerMessage: "offline", files } } });
}

describe("movie file naming in the actual workflow", () => {
  it("renames new movie and paired subtitles in ordinary movie acquisition, preserving old IDs", async () => {
    const stem = "Transformers.2007.2160p.REMUX.DV.Atmos";
    const storage = executor([file("main", `${stem}.mkv`), file("sub", `${stem}.zh.srt`)]);
    const directoryId = await storage.createDirectory({ parentId: "movies", name: mediaLibraryFolderName(title) });
    storage.seedDirectoryFiles(directoryId, [file("old", "Old.1080p.mkv")]);
    const result = await run(storage);
    expect(result.status).toBe("succeeded");
    expect(await storage.listTree({ directoryId })).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerFileId: "old", path: "Old.1080p.mkv" }),
      expect.objectContaining({ providerFileId: "main", path: "变形金刚 (2007) {tmdb-1858} [4K REMUX DV Atmos].mkv" }),
      expect.objectContaining({ providerFileId: "sub", path: "变形金刚 (2007) {tmdb-1858} [4K REMUX DV Atmos].zh.srt" }),
    ]));
    expect(result.episodes[0]?.verifiedFileIds).toEqual(["main"]);
    expect(result.movieAssetEvidence).toEqual([{ fileId: "main", tier: 2, dolbyVision: true, atmos: true }]);
  });

  it("does not label a 1080P actual file as the candidate's claimed 4K REMUX", async () => {
    const storage = executor([file("main", "Transformers.2007.1080p.WEB.mkv")]);
    const result = await run(storage);
    expect((await storage.listTree({ directoryId: result.season.storageDirectoryId }))[0]?.path)
      .toBe("变形金刚 (2007) {tmdb-1858} [1080P].mkv");
    expect(result.movieAssetEvidence).toEqual([{ fileId: "main", tier: 6, dolbyVision: false, atmos: false }]);
  });

  it("reports naming failure after a successful landing instead of claiming every step completed", async () => {
    const storage = executor([file("main", "Transformers.2007.2160p.REMUX.mkv")]);
    storage.renameFile = async () => { throw new Error("offline rename refused"); };
    const result = await run(storage);
    expect(result.status).toBe("succeeded");
    expect(result.movieNamingWarnings?.length).toBeGreaterThan(0);
    expect(result.auditEvents).toContainEqual(expect.objectContaining({ type: "movie_file_rename_incomplete" }));
    expect(result.notification.body).toContain("命名未全部完成");
    expect((await storage.listTree({ directoryId: result.season.storageDirectoryId }))[0]?.path).toBe("Transformers.2007.2160p.REMUX.mkv");
  });
});
