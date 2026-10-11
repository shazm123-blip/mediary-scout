import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { MediaTitle, ResourceCandidate, ResourceSnapshot } from "../src/domain.js";
import { findMovieChoices, matchesMovieIdentityForFallback } from "../src/movie-choice-search.js";

const title: MediaTitle = { id: "tmdb_movie_1", tmdbId: 1, type: "movie", title: "测试电影", originalTitle: "Test Film", year: 2025, aliases: [] };
const row = (id: string, name: string): ResourceCandidate => ({ id, snapshotId: "s", index: 0, title: name,
  type: "115", source: "offline", providerPayload: {} });
const rows = [
  row("known", "测试电影.2025.2160p.REMUX"),
  row("unknown", "测试电影.2025.蓝光原盘"),
  row("sequel", "测试电影2.2025.2160p"),
  row("other", "另一部测试电影.2025.2160p"),
  row("wrong_year", "测试电影.2024.2160p"),
  row("bdmv", "测试电影.2025.2160p.BDMV"),
];
const snapshot: ResourceSnapshot = { id: "s", provider: "offline", keyword: title.title, candidates: rows, createdAt: "2026-10-11T00:00:00Z" };
const usage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
const finalText = () => ({ content: [{ type: "text" as const, text: "done" }],
  finishReason: { unified: "stop" as const, raw: "stop" as const }, usage, warnings: [] });
const submit = (candidateIds: string[]) => ({ content: [{ type: "tool-call" as const, toolCallId: "submit",
  toolName: "submitCandidates", input: JSON.stringify({ candidateIds }) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage, warnings: [] });
const provider = { search: async () => snapshot };

describe("movie choice search fallback", () => {
  it("recovers only exact movie-and-year matches when the model never submits", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => finalText() });
    const result = await findMovieChoices({ title, provider, model, workflowRunId: "run" });
    expect(result.candidates.map((item) => item.id)).toEqual(["known", "unknown"]);
    expect(result.candidates[0]).toMatchObject({ tier: 2, identityPending: true });
    expect(result.candidates[1]).toMatchObject({ tier: null, identityPending: true });
    expect(result.candidates[0]?.recommendation).toContain("AI 未提交确认");
    expect(matchesMovieIdentityForFallback(title, rows[2]!)).toBe(false);
    expect(matchesMovieIdentityForFallback(title, rows[3]!)).toBe(false);
  });

  it("honors an explicit empty submit and does not restore excluded resources", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => submit([]) });
    const result = await findMovieChoices({ title, provider, model, workflowRunId: "run" });
    expect(result.candidates).toEqual([]);
  });

  it("treats the last submit as the complete AI decision", async () => {
    let turn = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => ++turn === 1 ? submit(["known"]) : submit([]) });
    const result = await findMovieChoices({ title, provider, model, workflowRunId: "run" });
    expect(result.candidates).toEqual([]);
  });

  it("keeps AI-selected unknown-quality candidates without a fallback marker", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => submit(["unknown"]) });
    const result = await findMovieChoices({ title, provider, model, workflowRunId: "run" });
    expect(result.candidates).toMatchObject([{ id: "unknown", tier: null }]);
    expect(result.candidates[0]?.identityPending).toBeUndefined();
  });

  it("reports an incomplete source when an empty search is followed by a failed retry", async () => {
    let searches = 0;
    const failingProvider = { search: async () => {
      if (++searches === 1) return { ...snapshot, candidates: [] };
      throw new Error("network unavailable");
    } };
    const model = new MockLanguageModelV3({ doGenerate: async () => finalText() });
    await expect(findMovieChoices({ title, provider: failingProvider, model, workflowRunId: "run" }))
      .rejects.toThrow("MOVIE_SEARCH_SOURCE_INCOMPLETE");
  });
});
