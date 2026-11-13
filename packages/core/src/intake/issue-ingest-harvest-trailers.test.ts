/**
 * #6265: a lean's Bound-remedy harvest keeps only the remedy limbs.
 *
 * Lean: the Bound-remedy slice ends at a closed trailer set (Reject, Not proposed,
 * Footnote(s), takes, Residual, Notes, Coordination), Reject lines land in
 * `plan.narratives.Constraint`, and `hashBoundRemedyBytes` uses the same slicer.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashBoundRemedyBytes } from "../design-critique/pain-audit-follow-through-gate.js";
import { buildIssueVbrief, ScannerHardFailError } from "./issue-ingest.js";
import { extractBoundRemedyHarvest } from "./markdown-scanners.js";

const LIMBS = [
  "Outside-root path-fence skip in runtimeAuthorityForDirectWrite. relieves: P1",
  "Same admit path relieves Bash-push friction. relieves: P2",
  "Same admit path relieves scratch Write friction. relieves: P3",
  "Preserve project edit authority on outside-root targets.",
  "Positive-allow arm skips outside-root Write only when every target is outside.",
  "Fixture matrix (a) through (h) for the fence.",
];

const REJECTS = [
  "Widening file_scope globs to match ../** or absolute host paths",
  "Removing story fence for in-repo writes under an active brief",
  "Softening authz / protected-store for outside-root targets",
];

function lean6189(trailer = ""): string {
  return [
    "model: grok-4-5",
    "role: parent",
    "Lean: Prefer-A Bound",
    "Spec-path: packages/core/src/hooks/dispatcher.ts",
    "",
    "## In plain English",
    "Active stories should fence repository writes, not temp scratch.",
    "",
    "## Bound remedy",
    ...LIMBS.map((limb) => `- ${limb}`),
    "",
    "Reject:",
    ...REJECTS.map((line) => `- ${line}`),
    "",
    "Footnotes (dispose-as-footnote):",
    "- P2 relief is Write/Edit parity; Shell-outside-root stays a residual.",
    "- authzForMutationTargets stays upstream of this skip.",
    "",
    "takes:",
    "- accept-into-contract: 6807858710/C1",
    "- accept-into-contract: 6807874908/F1",
    "- operator-steer: 6839167710",
    trailer,
  ].join("\n");
}

function sha(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

describe("Bound-remedy slice ends at the closed trailer set (#6265 limb 1)", () => {
  it("#6189-shaped lean harvests its 6 limbs, not Reject / Footnotes / takes", () => {
    const harvest = extractBoundRemedyHarvest(lean6189());
    expect(harvest.items.map((item) => item.title)).toEqual(LIMBS);
    expect(harvest.sourceText).not.toContain("Widening file_scope");
    expect(harvest.sourceText).not.toContain("accept-into-contract");
    expect(harvest.sourceText).not.toContain("authzForMutationTargets");
  });

  it("stores Reject list lines as constraint lines (#6265 limb 2)", () => {
    const harvest = extractBoundRemedyHarvest(lean6189());
    expect(harvest.constraintLines).toEqual(REJECTS);
  });

  it.each([
    ["Reject:"],
    ["Not proposed:"],
    ["Footnote:"],
    ["Footnotes (dispose-as-footnote):"],
    ["takes:"],
    ["Residual:"],
    ["Notes:"],
    ["Coordination (cohort):"],
    ["**Reject:**"],
    ["### Reject"],
  ])("trailer %s ends the slice", (label) => {
    const body = `## Bound remedy\n- limb one\n- limb two\n\n${label}\n- not a limb\n`;
    expect(extractBoundRemedyHarvest(body).items.map((item) => item.title)).toEqual([
      "limb one",
      "limb two",
    ]);
  });

  it("keeps a colon-intro line, a limb ending in ':', nested sub-bullets and prose naming Reject:", () => {
    const body = [
      "## Bound remedy",
      "Limb group A:",
      "- Add these cases:",
      "  - nested case one",
      "  - nested case two",
      "- Keep Reject: lines as must-not text",
      "Implementation notes:",
      "- limb after a non-trailer label",
      "",
      "Reject:",
      "- a rejected alternative",
    ].join("\n");
    const harvest = extractBoundRemedyHarvest(body);
    expect(harvest.items.map((item) => item.title)).toEqual([
      "Add these cases:",
      "nested case one",
      "nested case two",
      "Keep Reject: lines as must-not text",
      "limb after a non-trailer label",
    ]);
    expect(harvest.constraintLines).toEqual(["a rejected alternative"]);
  });

  it("ignores a trailer label inside a fenced example and keeps the limbs after it", () => {
    const body = [
      "## Bound remedy",
      "- Teach the lean shape:",
      "```md",
      "Reject:",
      "- sample rejected line",
      "```",
      "- a real limb after the sample",
      "",
      "Reject:",
      "- a rejected alternative",
    ].join("\n");
    const harvest = extractBoundRemedyHarvest(body);
    expect(harvest.items.map((item) => item.title)).toEqual([
      "Teach the lean shape:",
      "a real limb after the sample",
    ]);
    expect(harvest.constraintLines).toEqual(["a rejected alternative"]);
    expect(hashBoundRemedyBytes(body)).toBe(
      sha(["Teach the lean shape:", "a real limb after the sample"]),
    );
    const changed = body.replace("a real limb after the sample", "a changed real limb");
    expect(hashBoundRemedyBytes(changed)).not.toBe(hashBoundRemedyBytes(body));
  });

  it("ignores a level-2 heading inside a fenced example", () => {
    const body = [
      "## Bound remedy",
      "- limb one",
      "~~~md",
      "## Reject",
      "- sample line",
      "~~~",
      "- limb two",
      "",
      "## Not proposed",
      "- a non-goal",
    ].join("\n");
    expect(extractBoundRemedyHarvest(body).items.map((item) => item.title)).toEqual([
      "limb one",
      "limb two",
    ]);
    expect(hashBoundRemedyBytes(body)).toBe(sha(["limb one", "limb two"]));
  });

  it("still ends at the next level-2 heading, and a Not proposed heading is a constraint source", () => {
    const body = "## Bound remedy\n- limb\n\n## Not proposed\n- a non-goal\n- another non-goal\n";
    const harvest = extractBoundRemedyHarvest(body);
    expect(harvest.items.map((item) => item.title)).toEqual(["limb"]);
    expect(harvest.constraintLines).toEqual(["a non-goal", "another non-goal"]);
  });
});

describe("hashBoundRemedyBytes uses the same slicer (#6265 limb 1)", () => {
  it("hashes only the limbs; leans that differ only below the trailer share a digest", () => {
    const a = lean6189();
    const b = lean6189("- accept-into-contract: 999/F9 (later take)");
    expect(hashBoundRemedyBytes(a)).toBe(sha(LIMBS));
    expect(hashBoundRemedyBytes(b)).toBe(hashBoundRemedyBytes(a));
    expect(hashBoundRemedyBytes(a)).toBe(hashBoundRemedyBytes(`${a}`));
  });

  it("a limb edit still changes the digest", () => {
    const a = lean6189();
    const changed = a.replace("Fixture matrix (a) through (h)", "Fixture matrix (a) through (i)");
    expect(hashBoundRemedyBytes(changed)).not.toBe(hashBoundRemedyBytes(a));
  });

  it("hashes the same titles the intake harvest returns", () => {
    const body = lean6189();
    const titles = extractBoundRemedyHarvest(body).items.map((item) => item.title);
    expect(hashBoundRemedyBytes(body)).toBe(sha(titles));
  });
});

describe("Spec-path ingest stores Reject lines as Constraint (#6265 limb 2)", () => {
  function ingestLean(lean: string): Record<string, unknown> {
    const harvest = extractBoundRemedyHarvest(lean);
    const [vbrief] = buildIssueVbrief(
      {
        number: 6189,
        title: "story write fence refuses Write/Edit outside the repo",
        url: "https://github.com/o/r/issues/6189",
        body: "## Summary\nThe fence refuses scratch writes.\n",
        labels: [],
      },
      "proposed",
      "https://github.com/o/r",
      {
        specPathHarvest: {
          items: harvest.items.map((item) => ({ title: item.title, status: item.status })),
          sourceText: harvest.sourceText,
          constraintLines: harvest.constraintLines,
        },
      },
    );
    return vbrief.plan as Record<string, unknown>;
  }

  it("gives 6 items, Reject lines in Constraint, and no footnote or take in items or clauses", () => {
    const plan = ingestLean(lean6189());
    const items = plan.items as { title: string }[];
    expect(items.map((item) => item.title)).toEqual(LIMBS);
    const narratives = plan.narratives as Record<string, string>;
    for (const line of REJECTS) {
      expect(narratives.Constraint).toContain(line);
    }
    const clauses = ((plan.acceptance as Record<string, unknown>).clauses ?? []) as {
      text: string;
    }[];
    const surfaces = [...items.map((item) => item.title), ...clauses.map((c) => c.text)];
    for (const text of surfaces) {
      expect(text).not.toMatch(/accept-into-contract|operator-steer|authzForMutationTargets/);
      expect(text).not.toMatch(/Widening file_scope/);
    }
    expect(narratives.Overview).not.toContain("Widening file_scope");
  });

  it("scans Constraint text with the untrusted-text scanner", () => {
    const secret = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const lean = lean6189().replace(REJECTS[0] as string, `Leaking ${secret}`);
    expect(() => ingestLean(lean)).toThrow(ScannerHardFailError);
  });
});
