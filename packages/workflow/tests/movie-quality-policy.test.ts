import { describe, expect, it } from "vitest";
import type { ResourceCandidate } from "../src/domain.js";
import { classifyMovieCandidate, compareMovieUpgrade, rankMovieCandidates } from "../src/movie-quality-policy.js";

function candidate(id: string, title: string, payload: Record<string, unknown> = {}): ResourceCandidate {
  return { id, snapshotId: "snapshot", index: 0, title, type: "115", source: "PanSou", providerPayload: payload };
}

describe("movie quality policy", () => {
  it("orders all six tiers and Dolby evidence within each tier", () => {
    const rows = [
      candidate("ordinary1080", "Film 1080p WEB"),
      candidate("remux1080", "Film 1080p BluRay REMUX"),
      candidate("iso1080", "Film 1080p BD ISO"),
      candidate("ordinary4k", "Film 2160p WEB"),
      candidate("remux4k", "Film 2160p BD REMUX"),
      candidate("iso4k", "Film 2160p BD.ISO"),
      candidate("dv", "Film 2160p BD REMUX DoVi"),
      candidate("both", "Film 2160p BD REMUX Dolby.Vision Atmos"),
    ];
    expect(rankMovieCandidates(rows).map((r) => r.id)).toEqual([
      "iso4k", "both", "dv", "remux4k", "ordinary4k", "iso1080", "remux1080", "ordinary1080",
    ]);
  });

  it("excludes BDMV regardless of an ISO claim or payload file path", () => {
    expect(classifyMovieCandidate(candidate("a", "Film 2160p ISO BDMV"))).toBeNull();
    expect(classifyMovieCandidate(candidate("b", "Film 2160p ISO", { files: [{ path: "Film/BDMV/index.bdmv" }] }))).toBeNull();
  });

  it("keeps unknown resolution and ambiguous disc type after six known tiers", () => {
    expect(classifyMovieCandidate(candidate("unknown", "Film BD REMUX"))).toMatchObject({ tier: null, qualityLabel: "画质待确认" });
    expect(classifyMovieCandidate(candidate("unknown_iso", "Film BD ISO"))).toMatchObject({ tier: null, isoHint: true });
    expect(classifyMovieCandidate(candidate("ambiguous", "Film 2160p 蓝光原盘"))).toMatchObject({ tier: null });
    expect(rankMovieCandidates([
      candidate("unknown", "Film BD REMUX"), candidate("known", "Film 1080p WEB"),
      candidate("ambiguous", "Film 2160p 蓝光原盘"), candidate("bdmv", "Film BDMV"),
    ]).map((item) => item.id)).toEqual(["known", "unknown", "ambiguous"]);
    const result = classifyMovieCandidate(candidate("known", "Film 1080p REMUX", { sizeBytes: 10 }));
    expect(result).toMatchObject({ tier: 5, dolbyVision: false, atmos: false, sizeBytes: 10 });
    expect(compareMovieUpgrade({ tier: null, dolbyVision: true, atmos: true },
      [{ tier: 6, dolbyVision: false, atmos: false }])).toBe("incomparable");
  });
});
