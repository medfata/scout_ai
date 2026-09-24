import { describe, expect, it } from "vitest";

import { rankIcpCandidates } from "@/src/ai/agents/icp";
import type { IcpCritiqueOutput, IcpOutput } from "@/src/ai/schemas";
import type { IcpScores } from "@/src/domain/types";

/**
 * Unit tests for the pure half of the ICP agent: merging the critic's scores over the
 * generated ones and ranking with `rankIcps` (section 6: "Rank by the sum; ties go to
 * reachability"). No model call and no database.
 */

function scoresOf(pain: number, budget: number, reach: number, proofFit: number, speed: number): IcpScores {
  return { pain, budget, reach, proofFit, speed };
}

function makeIcp(name: string, scores: IcpScores): IcpOutput {
  return {
    name,
    rationale: `Why ${name} is a fit.`,
    pains: ["Manual triage", "Slow first response"],
    triggers: ["Hiring support agents"],
    titles: ["Head of Support"],
    industries: ["SaaS"],
    sizeBands: ["11-50"],
    geos: ["United States"],
    disqualifiers: ["Agency"],
    angles: [
      { key: "triage", hook: "Your queue is growing faster than your team." },
      { key: "speed", hook: "First response time is the metric your buyers feel." },
    ],
    exa: { query: `${name} support automation`, criteria: ["Runs a support team", "Uses a help desk tool"] },
    scores,
  };
}

function critique(input: {
  rankings?: Array<{ name: string; scores: IcpScores; note?: string }>;
  drop?: Array<{ name: string; reason?: string }>;
}): IcpCritiqueOutput {
  return {
    rankings: (input.rankings ?? []).map((entry) => ({
      name: entry.name,
      scores: entry.scores,
      note: entry.note ?? "scored by the critic",
    })),
    drop: (input.drop ?? []).map((entry) => ({ name: entry.name, reason: entry.reason ?? "weak candidate" })),
  };
}

describe("rankIcpCandidates", () => {
  it("merges the critic's scores over the generated ones", () => {
    const first = makeIcp("Alpha", scoresOf(4, 4, 4, 4, 4));
    const second = makeIcp("Beta", scoresOf(1, 1, 1, 1, 1));

    const ranked = rankIcpCandidates(
      { icps: [first, second] },
      critique({
        rankings: [{ name: "Alpha", scores: scoresOf(1, 1, 1, 1, 1) }, { name: "Beta", scores: scoresOf(5, 5, 5, 5, 5) }],
      }),
    );

    expect(ranked.map((icp) => icp.name)).toEqual(["Beta", "Alpha"]);
    expect(ranked[0]?.scores).toEqual(scoresOf(5, 5, 5, 5, 5));
    expect(ranked[1]?.scores).toEqual(scoresOf(1, 1, 1, 1, 1));
  });

  it("keeps the generated scores for candidates the critic did not rank", () => {
    const generated = scoresOf(3, 3, 3, 3, 3);
    const ranked = rankIcpCandidates(
      { icps: [makeIcp("Alpha", scoresOf(5, 5, 5, 5, 5)), makeIcp("Beta", generated)] },
      critique({ rankings: [{ name: "Alpha", scores: scoresOf(1, 1, 1, 1, 1) }] }),
    );

    const beta = ranked.find((icp) => icp.name === "Beta");
    expect(beta?.scores).toEqual(generated);
  });

  it("drops the candidates the critic rejected", () => {
    const ranked = rankIcpCandidates(
      { icps: [makeIcp("Alpha", scoresOf(5, 5, 5, 5, 5)), makeIcp("Beta", scoresOf(4, 4, 4, 4, 4)), makeIcp("Gamma", scoresOf(3, 3, 3, 3, 3))] },
      critique({
        rankings: [
          { name: "Alpha", scores: scoresOf(5, 5, 5, 5, 5) },
          { name: "Beta", scores: scoresOf(4, 4, 4, 4, 4) },
          { name: "Gamma", scores: scoresOf(3, 3, 3, 3, 3) },
        ],
        drop: [{ name: "Gamma", reason: "Offer cannot serve this segment." }],
      }),
    );

    expect(ranked.map((icp) => icp.name)).toEqual(["Alpha", "Beta"]);
    expect(ranked.some((icp) => icp.name === "Gamma")).toBe(false);
  });

  it("matches names case-insensitively and trims whitespace", () => {
    const ranked = rankIcpCandidates(
      { icps: [makeIcp("B2B SaaS founders", scoresOf(4, 4, 4, 4, 4)), makeIcp("Agencies", scoresOf(1, 1, 1, 1, 1))] },
      critique({
        rankings: [{ name: "  b2b saas FOUNDERS ", scores: scoresOf(5, 5, 5, 5, 5) }],
        drop: [{ name: "AGENCIES", reason: "Too small." }],
      }),
    );

    expect(ranked.map((icp) => icp.name)).toEqual(["B2B SaaS founders"]);
    expect(ranked[0]?.scores).toEqual(scoresOf(5, 5, 5, 5, 5));
  });

  it("breaks score ties by reachability", () => {
    const ranked = rankIcpCandidates(
      { icps: [makeIcp("Low reach", scoresOf(4, 4, 3, 4, 5)), makeIcp("High reach", scoresOf(4, 4, 5, 4, 3))] },
      critique({ rankings: [] }),
    );

    expect(ranked.map((icp) => icp.name)).toEqual(["High reach", "Low reach"]);
    expect(ranked[0]?.rank).toBe(1);
  });

  it("assigns ranks 1..n in order", () => {
    const ranked = rankIcpCandidates(
      {
        icps: [
          makeIcp("Alpha", scoresOf(5, 5, 5, 5, 5)),
          makeIcp("Beta", scoresOf(4, 4, 4, 4, 4)),
          makeIcp("Gamma", scoresOf(3, 3, 3, 3, 3)),
        ],
      },
      critique({ rankings: [] }),
    );

    expect(ranked.map((icp) => icp.rank)).toEqual([1, 2, 3]);
    expect(ranked.map((icp) => icp.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("returns an empty set when the critic drops every candidate", () => {
    const ranked = rankIcpCandidates(
      { icps: [makeIcp("Alpha", scoresOf(5, 5, 5, 5, 5)), makeIcp("Beta", scoresOf(4, 4, 4, 4, 4))] },
      critique({ rankings: [], drop: [{ name: "Alpha" }, { name: "Beta" }] }),
    );

    expect(ranked).toEqual([]);
  });
});
