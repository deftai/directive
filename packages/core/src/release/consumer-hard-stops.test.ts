import { describe, expect, it } from "vitest";
import {
  classifyHardStop,
  enumerateConsumerHardStops,
  evaluateConsumerHardStopCensus,
  issueFromInventoryRow,
  parseClosesSet,
} from "./consumer-hard-stops.js";

describe("classifyHardStop (#3900 check 4 / #3713)", () => {
  it("matches a BLOCKER title and does not read a body", () => {
    const match = classifyHardStop({
      number: 3600,
      title: "BLOCKER: shipped main.md schema 0.6 vs setup 0.8",
      labels: [],
    });
    expect(match).toEqual({
      number: 3600,
      title: "BLOCKER: shipped main.md schema 0.6 vs setup 0.8",
      viaTitle: true,
      viaLabel: false,
    });
  });

  it("matches the adoption-blocker label without deriving it from a title", () => {
    const match = classifyHardStop({
      number: 99,
      title: "install fails on first session",
      labels: ["adoption-blocker"],
    });
    expect(match?.viaLabel).toBe(true);
    expect(match?.viaTitle).toBe(false);
  });

  it("does not treat a title that merely mentions blocker as classification", () => {
    expect(
      classifyHardStop({
        number: 1,
        title: "docs: mention of blocker in the guide",
        labels: [],
      }),
    ).toBeNull();
  });

  it("does not derive adoption-blocker from a BLOCKER title", () => {
    const match = classifyHardStop({
      number: 3601,
      title: "BLOCKER: missing REFERENCES.md",
      labels: [],
    });
    expect(match?.viaTitle).toBe(true);
    expect(match?.viaLabel).toBe(false);
  });
});

describe("enumerateConsumerHardStops", () => {
  it("unions title and label matches and ignores other open issues", () => {
    const matches = enumerateConsumerHardStops([
      { number: 2, title: "feat: something", labels: [] },
      { number: 10, title: "BLOCKER: a", labels: [] },
      { number: 11, title: "install", labels: ["adoption-blocker"] },
    ]);
    expect(matches.map((m) => m.number)).toEqual([10, 11]);
  });
});

describe("parseClosesSet", () => {
  it("reads Closes from Unreleased only, never from later sections", () => {
    const text = [
      "## [Unreleased]",
      "",
      "### Fixed",
      "- foo. Closes #3600.",
      "",
      "## [0.108.0] - 2026-08-29",
      "",
      "- Closes #9999",
    ].join("\n");
    expect([...parseClosesSet(text)].sort()).toEqual([3600]);
  });
});

describe("evaluateConsumerHardStopCensus", () => {
  it("fails when an open hard-stop is not in the cut Closes set", () => {
    const result = evaluateConsumerHardStopCensus({
      issues: [{ number: 3600, title: "BLOCKER: schema", labels: [] }],
      closesSet: new Set(),
    });
    expect(result.code).toBe(1);
    expect(result.shipsPast.map((e) => e.number)).toEqual([3600]);
    expect(result.message).toContain("Recovery:");
  });

  it("passes when the cut Closes set covers every open hard-stop", () => {
    const result = evaluateConsumerHardStopCensus({
      issues: [{ number: 3600, title: "BLOCKER: schema", labels: [] }],
      closesSet: new Set([3600]),
    });
    expect(result.code).toBe(0);
    expect(result.shipsPast).toEqual([]);
  });

  it("is non-vacuous: adding a BLOCKER title flips pass to fail", () => {
    const none = evaluateConsumerHardStopCensus({ issues: [], closesSet: new Set() });
    expect(none.code).toBe(0);
    const mutated = evaluateConsumerHardStopCensus({
      issues: [{ number: 1, title: "BLOCKER: escaped", labels: [] }],
      closesSet: new Set(),
    });
    expect(mutated.code).toBe(1);
  });
});

describe("issueFromInventoryRow", () => {
  it("takes title, number, and label names and never requires a body", () => {
    const issue = issueFromInventoryRow({
      number: 3600,
      title: "BLOCKER: x",
      labels: [{ name: "enhancement" }],
      body: "untrusted consumer text that must not be ingested",
    });
    expect(issue).toEqual({
      number: 3600,
      title: "BLOCKER: x",
      labels: ["enhancement"],
    });
    expect(issue && "body" in issue).toBe(false);
  });

  it("skips pull request rows", () => {
    expect(
      issueFromInventoryRow({
        number: 1,
        title: "BLOCKER: pr",
        labels: [],
        pull_request: { url: "https://example.invalid" },
      }),
    ).toBeNull();
  });
});
