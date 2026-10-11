import { describe, expect, it, vi } from "vitest";
import type { MediaTitle, PackageTreeFile } from "../src/domain.js";
import type { StorageExecutor } from "../src/ports.js";
import { Pan115AuthError } from "../src/pan115-cookie-client.js";
import { renameLandedMovieFiles } from "../src/movie-file-naming.js";

const title: MediaTitle = { id: "tmdb_movie_1858", tmdbId: 1858, type: "movie", title: "变形金刚",
  originalTitle: "Transformers", year: 2007, aliases: [] };
const file = (id: string, path: string): PackageTreeFile => ({ providerFileId: id, path, sizeBytes: 10 });
const actual = "Transformers.2007.2160p.REMUX.DV.Atmos.mkv";
const named = "变形金刚 (2007) {tmdb-1858} [4K REMUX DV Atmos].mkv";

function storage(initial: PackageTreeFile[], noOp = false) {
  const files = initial.map((item) => ({ ...item }));
  const renameFile = vi.fn(async (input: { fileId: string; newName: string }) => {
    if (!noOp) files.find((item) => item.providerFileId === input.fileId)!.path = input.newName;
  });
  const listTree = vi.fn(async () => files.map((item) => ({ ...item })));
  return { files, renameFile, listTree } as unknown as Pick<StorageExecutor, "listTree" | "renameFile"> & { files: PackageTreeFile[];
    renameFile: typeof renameFile; listTree: typeof listTree };
}

describe("rename landed movie files", () => {
  it("uses actual new-file markers and renames only exact paired new subtitles", async () => {
    const cloud = storage([file("old", "Old.1080p.mkv"), file("main", actual),
      file("zh", "Transformers.2007.2160p.REMUX.DV.Atmos.zh-CN.forced.srt"),
      file("unrelated", "Transformers.2007.2160p.REMUX.DV.Atmos2.srt"),
      file("old_sub", "Old.1080p.zh.srt")]);
    const result = await renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["old", "main"], beforeFileIds: new Set(["old", "old_sub"]) });
    expect(result.warnings).toEqual([]);
    expect(result.renamed).toEqual([
      { id: "main", oldName: actual, newName: named },
      { id: "zh", oldName: "Transformers.2007.2160p.REMUX.DV.Atmos.zh-CN.forced.srt",
        newName: "变形金刚 (2007) {tmdb-1858} [4K REMUX DV Atmos].zh-CN.forced.srt" },
    ]);
    expect(cloud.files.find((item) => item.providerFileId === "old")?.path).toBe("Old.1080p.mkv");
    expect(cloud.files.find((item) => item.providerFileId === "unrelated")?.path).toBe("Transformers.2007.2160p.REMUX.DV.Atmos2.srt");
    expect(cloud.listTree).toHaveBeenCalledTimes(3);
  });

  it("keeps unknown quality unknown and derives ISO only from the landed extension", async () => {
    const cloud = storage([file("iso", "disc.iso")]);
    const result = await renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["iso"], beforeFileIds: new Set() });
    expect(result.renamed[0]?.newName).toBe("变形金刚 (2007) {tmdb-1858} [画质待确认 ISO].iso");
  });

  it("keeps paired VobSub index and binary subtitle names together", async () => {
    const cloud = storage([file("main", actual),
      file("idx", "Transformers.2007.2160p.REMUX.DV.Atmos.zh.idx"),
      file("sub", "Transformers.2007.2160p.REMUX.DV.Atmos.zh.sub")]);
    const result = await renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["main"], beforeFileIds: new Set() });
    expect(result.renamed.map((item) => item.newName)).toEqual([named,
      "变形金刚 (2007) {tmdb-1858} [4K REMUX DV Atmos].zh.idx",
      "变形金刚 (2007) {tmdb-1858} [4K REMUX DV Atmos].zh.sub"]);
    expect(result.warnings).toEqual([]);
  });

  it("skips every rename on a collision with an existing old version", async () => {
    const cloud = storage([file("old", named), file("main", actual), file("sub", "Transformers.2007.2160p.REMUX.DV.Atmos.srt")]);
    const result = await renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["main"], beforeFileIds: new Set(["old"]) });
    expect(result.renamed).toEqual([]);
    expect(result.warnings).toEqual(["目标文件名已存在，整组保留原名。"]);
    expect(cloud.renameFile).not.toHaveBeenCalled();
  });

  it("checks paired-subtitle collisions before changing the main file", async () => {
    const cloud = storage([file("old_sub", "变形金刚 (2007) {tmdb-1858} [4K REMUX DV Atmos].zh.srt"),
      file("main", actual), file("new_sub", "Transformers.2007.2160p.REMUX.DV.Atmos.zh.srt")]);
    const result = await renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["main"], beforeFileIds: new Set(["old_sub"]) });
    expect(result.renamed).toEqual([]);
    expect(result.warnings).toEqual(["目标文件名已存在，整组保留原名。"]);
    expect(cloud.renameFile).not.toHaveBeenCalled();
  });

  it("does not guess a main file when multiple eligible videos landed", async () => {
    const cloud = storage([file("a", "A.2160p.mkv"), file("b", "B.1080p.mkv")]);
    const result = await renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["a", "b"], beforeFileIds: new Set() });
    expect(result.warnings).toEqual(["发现多个新正片，未自动重命名。"]);
    expect(cloud.renameFile).not.toHaveBeenCalled();
  });

  it("reports a successful API no-op after read-back and preserves auth errors", async () => {
    const cloud = storage([file("main", actual)], true);
    const result = await renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["main"], beforeFileIds: new Set() });
    expect(result.renamed).toEqual([]);
    expect(result.warnings).toEqual(["重命名结果未通过文件 ID 与名称复核，后续文件保留原名。"]);
    cloud.renameFile.mockRejectedValueOnce(new Pan115AuthError("offline auth failed"));
    await expect(renameLandedMovieFiles({ storage: cloud, directoryId: "movie", title,
      eligibleFileIds: ["main"], beforeFileIds: new Set() })).rejects.toBeInstanceOf(Pan115AuthError);
  });
});
