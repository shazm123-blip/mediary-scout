import type { ResourceCandidate } from "./domain.js";
import type { StorageExecutor } from "./ports.js";
import { isBrandStorageAuthError } from "./storage-auth-error.js";

export interface ShareEntry { id: string; name: string; directory: boolean }

/** Exhaustive bounded walk. A cap is a rejection, never a partial approval. */
export async function inspectShareTree(
  list: (parentId: string) => Promise<ShareEntry[]>, rootId: string,
): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  const seen = new Set<string>();
  const walk = async (id: string, path: string, depth: number): Promise<void> => {
    if (depth > 6 || seen.size > 2000) throw new Error("MOVIE_SHARE_PREFLIGHT_INCOMPLETE");
    for (const entry of await list(id)) {
      if (!entry.name || !entry.id) throw new Error("MOVIE_SHARE_PREFLIGHT_INCOMPLETE");
      const filePath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.directory) {
        if (seen.has(entry.id)) throw new Error("MOVIE_SHARE_PREFLIGHT_CYCLE");
        seen.add(entry.id);
        directories.push(filePath);
        await walk(entry.id, filePath, depth + 1);
      } else files.push(filePath);
      if (files.length + directories.length > 2000) throw new Error("MOVIE_SHARE_PREFLIGHT_INCOMPLETE");
    }
  };
  await walk(rootId, "", 0);
  return { files, directories };
}

/** No directory-structured Blu-ray and at least one expected media file. */
export async function preflightChosenMovieSource(input: {
  storage: StorageExecutor; candidate: ResourceCandidate; expectIso: boolean | null;
}): Promise<{ isIso: boolean }> {
  if (input.candidate.type === "magnet" || input.candidate.type === "manual")
    throw new Error("MOVIE_SHARE_PREFLIGHT_UNSUPPORTED");
  if (!input.storage.inspectCandidateShare) throw new Error("MOVIE_SHARE_PREFLIGHT_UNSUPPORTED");
  let tree: { files: string[]; directories: string[] };
  try {
    tree = await input.storage.inspectCandidateShare(input.candidate);
  } catch (error) {
    if (isBrandStorageAuthError(error) || movieSharePreflightFailure(error)) throw error;
    throw new Error("MOVIE_SHARE_PREFLIGHT_INCOMPLETE", { cause: error });
  }
  if (tree.directories.some((path) => /(?:^|\/)BDMV(?:\/|$)/i.test(path)) ||
      tree.files.some((path) => /(?:^|\/)BDMV(?:\/|$)|\.bdmv$/i.test(path))) {
    throw new Error("MOVIE_SHARE_PREFLIGHT_BDMV");
  }
  const hasIso = tree.files.some((path) => /\.iso$/i.test(path));
  const isIso = input.expectIso ?? hasIso;
  const movieFile = isIso ? /\.iso$/i : /\.(mkv|mp4|avi|m2ts|ts|mov|flv|wmv)$/i;
  if (!tree.files.some((path) => movieFile.test(path))) throw new Error("MOVIE_SHARE_PREFLIGHT_NO_MOVIE");
  return { isIso };
}

/** Fixed user-facing copy; never expose share URLs, credentials or raw provider errors. */
export function movieSharePreflightFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("MOVIE_SHARE_PREFLIGHT_BDMV")) return "所选分享包含 BDMV 目录或文件，已拦截转存，请改选。";
  if (message.includes("MOVIE_SHARE_PREFLIGHT_UNSUPPORTED")) return "所选链接不支持转存前只读核验，已拦截转存，请改选。";
  if (message.includes("MOVIE_SHARE_PREFLIGHT_NO_MOVIE")) return "所选分享未找到符合画质类型的电影文件，已拦截转存，请改选。";
  if (/MOVIE_SHARE_PREFLIGHT_INCOMPLETE|MOVIE_SHARE_PREFLIGHT_CYCLE|SHARE_(?:LIST|PREFLIGHT)_INCOMPLETE/.test(message))
    return "所选分享的文件清单无法完整核验，已拦截转存，请改选。";
  return null;
}
