import { describe, expect, it } from "vitest";
import { classifyPosition } from "../design-critique/citation-grammar.js";
import {
  classifyHardStop,
  enumerateConsumerHardStops,
  evaluateConsumerHardStopCensus,
  issueFromInventoryRow,
  parseClosesSet,
} from "./consumer-hard-stops.js";

function unreleased(body: string): string {
  return ["## [Unreleased]", "", body, "", "## [0.108.0] - 2026-08-29", "", "- Closes #9999"].join(
    "\n",
  );
}

const BYPASS_FORMS: readonly {
  readonly name: string;
  readonly body: string;
  readonly reason: "code-fence" | "inline-code" | "blockquote" | "strikethrough" | "negation";
}[] = [
  {
    name: "fenced code block",
    body: ["```", "Closes #3463", "```"].join("\n"),
    reason: "code-fence",
  },
  {
    name: "inline code span",
    body: "do not write `Closes #3463` here",
    reason: "inline-code",
  },
  { name: "blockquote", body: "> quoted: Closes #3463", reason: "blockquote" },
  { name: "strikethrough", body: "~~Closes #3463~~", reason: "strikethrough" },
  { name: "explicit negation", body: "does not Closes #3463", reason: "negation" },
];

describe("classifyHardStop (#3900 check 4 / #3713 / #3969)", () => {
  it("does not let a BLOCKER title alone classify", () => {
    expect(
      classifyHardStop({
        number: 3600,
        title: "BLOCKER: shipped main.md schema 0.6 vs setup 0.8",
        labels: [],
      }),
    ).toBeNull();
  });

  it("matches the adoption-blocker label without deriving it from a title", () => {
    const match = classifyHardStop({
      number: 99,
      title: "install fails on first session",
      labels: ["adoption-blocker"],
    });
    expect(match).toEqual({
      number: 99,
      title: "install fails on first session",
      viaTitle: false,
      viaLabel: true,
    });
  });

  it("matches blocks-release-tag so a privileged deadlined entry is visible", () => {
    const match = classifyHardStop({
      number: 3899,
      title: "chore(packaging,release): post-release remediation",
      labels: ["blocks-release-tag"],
    });
    expect(match).toEqual({
      number: 3899,
      title: "chore(packaging,release): post-release remediation",
      viaTitle: false,
      viaLabel: true,
    });
  });

  it("records a BLOCKER title as a flare when a privileged label is also present", () => {
    const match = classifyHardStop({
      number: 7,
      title: "BLOCKER: install fails",
      labels: ["adoption-blocker"],
    });
    expect(match?.viaTitle).toBe(true);
    expect(match?.viaLabel).toBe(true);
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
    expect(
      classifyHardStop({
        number: 3601,
        title: "BLOCKER: missing REFERENCES.md",
        labels: [],
      }),
    ).toBeNull();
  });
});

describe("enumerateConsumerHardStops", () => {
  it("unions privileged labels and ignores title-only BLOCKER issues", () => {
    const matches = enumerateConsumerHardStops([
      { number: 2, title: "feat: something", labels: [] },
      { number: 10, title: "BLOCKER: a", labels: [] },
      { number: 11, title: "install", labels: ["adoption-blocker"] },
      { number: 3899, title: "chore: remediation", labels: ["blocks-release-tag"] },
    ]);
    expect(matches.map((m) => m.number)).toEqual([11, 3899]);
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
  it("fails when an open privileged hard-stop is not in the cut Closes set", () => {
    const result = evaluateConsumerHardStopCensus({
      issues: [{ number: 3463, title: "feat: rust lane", labels: ["adoption-blocker"] }],
      closesSet: new Set(),
    });
    expect(result.code).toBe(1);
    expect(result.shipsPast.map((e) => e.number)).toEqual([3463]);
    expect(result.message).toContain("Recovery:");
  });

  it("passes when the cut Closes set covers every open hard-stop", () => {
    const result = evaluateConsumerHardStopCensus({
      issues: [{ number: 3463, title: "feat: rust lane", labels: ["adoption-blocker"] }],
      closesSet: new Set([3463]),
    });
    expect(result.code).toBe(0);
    expect(result.shipsPast).toEqual([]);
  });

  it("is non-vacuous: adding a privileged label flips pass to fail", () => {
    const none = evaluateConsumerHardStopCensus({ issues: [], closesSet: new Set() });
    expect(none.code).toBe(0);
    const mutated = evaluateConsumerHardStopCensus({
      issues: [{ number: 3899, title: "chore: remediation", labels: ["blocks-release-tag"] }],
      closesSet: new Set(),
    });
    expect(mutated.code).toBe(1);
  });

  it("title-only BLOCKER does not flip pass to fail", () => {
    const result = evaluateConsumerHardStopCensus({
      issues: [{ number: 1, title: "BLOCKER: escaped", labels: [] }],
      closesSet: new Set(),
    });
    expect(result.code).toBe(0);
    expect(result.matches).toEqual([]);
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

describe("parseClosesSet position classification (#3969)", () => {
  it("plain control still clears", () => {
    const text = unreleased("- foo. Closes #3463.");
    expect([...parseClosesSet(text)].sort()).toEqual([3463]);
  });

  it.each(
    BYPASS_FORMS,
  )("does not clear from $name (fails before the classifier is composed)", (form) => {
    const text = unreleased(form.body);
    const after = text.split(/^## \[Unreleased\]\s*$/m)[1] ?? "";
    const section = after.split(/^## \[/m)[0] ?? after;
    const match = /\b(?:Closes|Fixes|Resolves)\s+#(\d+)/gi.exec(section);
    expect(match, form.name).not.toBeNull();
    expect(classifyPosition(section, match?.index ?? 0), form.name).toBe(form.reason);
    expect([...parseClosesSet(text)], form.name).not.toContain(3463);
  });
});
