import type { MediaTitle, PackageTreeFile } from "./domain.js";
import type { StorageExecutor } from "./ports.js";
import { isBrandStorageAuthError } from "./storage-auth-error.js";

const MOVIE_EXT = /\.(iso|mkv|mp4|avi|m2ts|ts|mov|flv|wmv)$/i;
const SUBTITLE_EXT = /\.(srt|ass|ssa|sub|idx|vtt|sup|smi)$/i;
const SUBTITLE_SUFFIX = /^(?:\.(?:zh|zh-cn|zh-tw|zh-hans|zh-hant|chs|cht|cn|en|eng|english|chinese|forced|sdh|cc|简体|繁体|中字))+$/i;

export interface MovieRenameResult {
  renamed: Array<{ id: string; oldName: string; newName: string }>;
  warnings: string[];
}

/** Rename one newly verified root movie and its new, unambiguous subtitles. */
export async function renameLandedMovieFiles(input: {
  storage: Pick<StorageExecutor, "listTree" | "renameFile">;
  directoryId: string;
  title: MediaTitle;
  eligibleFileIds: readonly string[];
  beforeFileIds: ReadonlySet<string>;
}): Promise<MovieRenameResult> {
  const result: MovieRenameResult = { renamed: [], warnings: [] };
  let tree: PackageTreeFile[];
  try { tree = await input.storage.listTree({ directoryId: input.directoryId }); }
  catch (error) {
    if (isBrandStorageAuthError(error)) throw error;
    result.warnings.push("无法读取新文件清单，未重命名。");
    return result;
  }
  const eligible = new Set(input.eligibleFileIds);
  const fresh = (file: PackageTreeFile) => !input.beforeFileIds.has(file.providerFileId) && !file.path.includes("/");
  const movies = tree.filter((file) => fresh(file) && eligible.has(file.providerFileId) && MOVIE_EXT.test(file.path));
  if (movies.length !== 1) {
    result.warnings.push(movies.length ? "发现多个新正片，未自动重命名。" : "未找到唯一新正片，未重命名。");
    return result;
  }
  const movie = movies[0]!;
  const oldStem = movie.path.replace(MOVIE_EXT, "");
  const ext = movie.path.slice(oldStem.length);
  const targetStem = `${safeFileName(input.title.title)} (${input.title.year || "—"}) {tmdb-${input.title.tmdbId}} [${movieTags(movie.path, ext).join(" ")}]`;
  const subtitles = tree.flatMap((file) => {
    if (!fresh(file) || !SUBTITLE_EXT.test(file.path)) return [];
    const subtitleExt = file.path.match(SUBTITLE_EXT)![0];
    const stem = file.path.slice(0, -subtitleExt.length);
    if (stem.toLowerCase() === oldStem.toLowerCase()) return [{ file, target: `${targetStem}${subtitleExt}` }];
    if (!stem.toLowerCase().startsWith(`${oldStem.toLowerCase()}.`)) return [];
    const suffix = stem.slice(oldStem.length);
    return SUBTITLE_SUFFIX.test(suffix) ? [{ file, target: `${targetStem}${suffix}${subtitleExt}` }] : [];
  });
  const plan = [{ file: movie, target: `${targetStem}${ext}` }, ...subtitles];
  const planIds = new Set(plan.map(({ file }) => file.providerFileId));
  const occupied = new Set(tree.filter((file) => !file.path.includes("/") && !planIds.has(file.providerFileId))
    .map((file) => file.path.toLowerCase()));
  const targets = plan.map(({ target }) => target.toLowerCase());
  if (targets.some((name) => occupied.has(name)) || new Set(targets).size !== targets.length) {
    result.warnings.push("目标文件名已存在，整组保留原名。");
    return result;
  }
  for (const { file, target } of plan) {
    if (file.path === target) continue;
    try {
      await input.storage.renameFile({ directoryId: input.directoryId, fileId: file.providerFileId, newName: target });
      const after = await input.storage.listTree({ directoryId: input.directoryId });
      if (!after.some((item) => item.providerFileId === file.providerFileId && item.path === target)) {
        result.warnings.push("重命名结果未通过文件 ID 与名称复核，后续文件保留原名。");
        return result;
      }
    } catch (error) {
      if (isBrandStorageAuthError(error)) throw error;
      result.warnings.push("重命名或复核失败，后续文件保留原名。");
      return result;
    }
    result.renamed.push({ id: file.providerFileId, oldName: file.path, newName: target });
  }
  return result;
}

function movieTags(name: string, ext: string): string[] {
  const fourK = /(?:^|[^a-z0-9])(?:2160p?|4k|uhd)(?:$|[^a-z0-9])/i.test(name);
  const hd = /(?:^|[^a-z0-9])(?:1080p?|fhd)(?:$|[^a-z0-9])/i.test(name);
  const tags = [fourK === hd ? "画质待确认" : fourK ? "4K" : "1080P"];
  if (ext.toLowerCase() === ".iso") tags.push("ISO");
  else if (/(?:^|[^a-z0-9])remux(?:$|[^a-z0-9])/i.test(name)) tags.push("REMUX");
  if (/(?:^|[^a-z0-9])(?:dolby[ ._-]*vision|do[ ._-]*vi|dovi|dv)(?:$|[^a-z0-9])|杜比视界/i.test(name)) tags.push("DV");
  if (/(?:^|[^a-z0-9])(?:dolby[ ._-]*atmos|atmos)(?:$|[^a-z0-9])|杜比全景声/i.test(name)) tags.push("Atmos");
  return tags;
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "电影";
}
