import { describe, expect, it } from "vitest";
import {
  extractBoundRemedyHarvest,
  findAcHeading,
  findBoundRemedyHeading,
  findLeanAcceptanceCriteriaHeading,
  leanAcceptanceCriteriaItems,
  leanSlicesSectionLines,
  parseCheckboxItems,
  parseLeanSlices,
  parseListItems,
  parseListItemsByPosition,
  parseListItemsByPositionFolded,
  parseSliceLine,
  sliceAcSection,
  sliceBoundRemedySection,
  sliceLeanAcceptanceCriteriaSection,
  stripCodeBlocks,
  stripFencedCodeBlocks,
} from "./markdown-scanners.js";

describe("lean Acceptance Criteria heading (#6333 item 1)", () => {
  const lean = [
    "**Lean:** bind.",
    "",
    "## Bound remedy",
    "1. Limb one.",
    "",
    "## Acceptance Criteria",
    "- Given a lean, then both lists are harvested.",
    "- Given a brief, then it records the source.",
    "",
    "## Reject",
    "- Not this.",
    "",
  ].join("\n");

  it("matches a level-2 heading and slices to the next level-2 heading", () => {
    expect(findLeanAcceptanceCriteriaHeading(lean)?.level).toBe(2);
    expect(leanAcceptanceCriteriaItems(lean).map((item) => item.title)).toEqual([
      "Given a lean, then both lists are harvested.",
      "Given a brief, then it records the source.",
    ]);
    expect(sliceLeanAcceptanceCriteriaSection(lean)).not.toContain("Not this.");
    expect(sliceBoundRemedySection(lean)).not.toContain("Given a lean");
  });

  it("ignores other heading levels, quoted headings and an empty text", () => {
    expect(findLeanAcceptanceCriteriaHeading("### Acceptance Criteria\n- x.\n")).toBeNull();
    expect(findLeanAcceptanceCriteriaHeading("> ## Acceptance Criteria\n- x.\n")).toBeNull();
    expect(findLeanAcceptanceCriteriaHeading("")).toBeNull();
    expect(sliceLeanAcceptanceCriteriaSection("no heading")).toBeNull();
    expect(leanAcceptanceCriteriaItems("no heading")).toEqual([]);
  });

  it("does not harvest a fenced example that contains an Acceptance Criteria heading", () => {
    const fenced = "## Bound remedy\n1. Limb.\n\n```\n## Acceptance Criteria\n- Fenced.\n```\n";
    expect(findLeanAcceptanceCriteriaHeading(fenced)).toBeNull();
    expect(leanAcceptanceCriteriaItems(fenced)).toEqual([]);
  });

  it("ends the slice at a closed trailer label", () => {
    const trailer = "## Acceptance Criteria\n- Kept.\n\nReject:\n- Dropped.\n";
    expect(leanAcceptanceCriteriaItems(trailer).map((item) => item.title)).toEqual(["Kept."]);
  });
});

describe("lean Slices section (#6333 item 6)", () => {
  it("parses label lines and ignores prose", () => {
    const text = "## Slices\nGive each item a slice.\n- slice-a: B1, A2\n- `slice-b`: B2\n";
    expect(leanSlicesSectionLines(text)).toEqual([
      "Give each item a slice.",
      "- slice-a: B1, A2",
      "- `slice-b`: B2",
    ]);
    expect(parseLeanSlices(text)).toEqual({
      present: true,
      assignments: [
        {
          label: "slice-a",
          refs: [
            { list: "B", index: 1 },
            { list: "A", index: 2 },
          ],
        },
        { label: "slice-b", refs: [{ list: "B", index: 2 }] },
      ],
      errors: [],
    });
  });

  it("reports absent sections and grammar errors", () => {
    expect(parseLeanSlices("## Bound remedy\n1. x\n")).toEqual({ present: false });
    expect(leanSlicesSectionLines("")).toBeNull();
    const bad = parseLeanSlices(
      "## Slices\n- Bad Label: B1\n- a: B1\n- a: B2\n- b: C1\n- c: B0\n- d:\n",
    );
    expect(bad.present && bad.errors).toEqual([
      "slice line is not '- <label>: B<n>, A<n>': Bad Label: B1",
      "slice label 'a' is listed twice",
      "slice 'b' has a reference that is not B<n> or A<n>: C1",
      "slice 'c' has a reference that is not B<n> or A<n>: B0",
      "slice 'd' assigns no items",
    ]);
    expect(parseLeanSlices("## Slices\nprose only\n")).toMatchObject({
      errors: ["Slices section assigns no items"],
    });
  });
});

describe("parseSliceLine (#6333 item 6)", () => {
  it("reads one closed slice line", () => {
    expect(parseSliceLine("Body.\n\ndeft-slice: 6333 slice-a\n")).toEqual({
      kind: "slice",
      parent: 6333,
      label: "slice-a",
    });
    expect(parseSliceLine("deft-slice: #6333 slice-a\r\ndeft-slice: 6333 slice-a\n")).toMatchObject(
      { kind: "slice", parent: 6333 },
    );
  });

  it("ignores fenced lines and refuses malformed or conflicting lines", () => {
    expect(parseSliceLine("```\ndeft-slice: 6333 slice-a\n```\n")).toEqual({ kind: "none" });
    expect(parseSliceLine("no slice")).toEqual({ kind: "none" });
    expect(parseSliceLine("deft-slice: slice-a")).toMatchObject({ kind: "malformed" });
    expect(parseSliceLine("deft-slice: 1 a\ndeft-slice: 2 a\n")).toEqual({
      kind: "malformed",
      detail: "issue body names more than one slice",
    });
    expect(parseSliceLine("deft-slice: 0 a")).toMatchObject({ kind: "malformed" });
  });
});

describe("stripCodeBlocks", () => {
  it("removes fenced and inline code", () => {
    const body = "Closes #1 in prose\n```\nCloses #99\n```\n`Closes #2` ok";
    expect(stripCodeBlocks(body)).toBe("Closes #1 in prose\n\n ok");
  });
});

describe("stripFencedCodeBlocks", () => {
  it("removes fenced blocks but preserves inline backticks", () => {
    const body = "`.deft/` added\n```\nCloses #99\n```\n`task check` passes";
    expect(stripFencedCodeBlocks(body)).toBe("`.deft/` added\n\n`task check` passes");
  });
});

describe("parseCheckboxItems", () => {
  it("parses task list lines", () => {
    const text = "- [ ] todo\n- [x] done\n  not a checkbox";
    expect(parseCheckboxItems(text)).toEqual([
      { title: "todo", status: "proposed" },
      { title: "done", status: "completed" },
    ]);
  });
});

describe("AC section fallback", () => {
  it("extracts numbered items under heading", () => {
    const text = "## Acceptance Criteria\n1. first\n2. second\n## Other";
    const heading = findAcHeading(text);
    expect(heading).not.toBeNull();
    const section = sliceAcSection(text, heading as NonNullable<typeof heading>);
    expect(parseListItems(section).map((i) => i.title)).toEqual(["first", "second"]);
  });
});

/** Field successor lean https://github.com/deftai/directive/issues/4254#issuecomment-5587555346 */
const LEAN_5587555346 = [
  "model: grok-4.6",
  "role: parent",
  "",
  "## In plain English",
  "",
  "The persist-then-deny story on #4254 does not bind as written.",
  "",
  "Recut: the five-point body is not the next-build contract.",
  "",
  "**Lean:** accept all classified headings from 5587545172.",
  "",
  "## Take map",
  "",
  "| # | Sibling | Heading | Class | Take |",
  "|---|---|---|---|---|",
  "| 1 | 5587545172 | Same-incarnation persist is unreachable | blocks-the-design | accept-into-contract |",
  "",
  "## Bound remedy (reading of the takes)",
  "",
  "1. Do not bind issue remedy 1 (same-incarnation second persist is idempotent allow) as the AC.",
  "2. Split the AC. Unique dest still conflicts across incarnations and parents.",
  "3. Keep occupied rollback. Do not add EXISTS rollback (that would delete the winner).",
  "4. If retry-allow is the fix, the key must be narrower than dest+parent.",
  "5. Logging of persist incarnation vs EXISTS does not change disposition.",
  "",
  "This map is an offer. Confirm or amend before bind.",
].join("\n");

describe("Bound-remedy harvest extractor (#4258)", () => {
  it("parses the 5587555346 Bound-remedy slice and ignores In plain English", () => {
    const heading = findBoundRemedyHeading(LEAN_5587555346);
    expect(heading).not.toBeNull();
    const harvest = extractBoundRemedyHarvest(LEAN_5587555346);
    expect(harvest.items.map((item) => item.title)).toEqual([
      "Do not bind issue remedy 1 (same-incarnation second persist is idempotent allow) as the AC.",
      "Split the AC. Unique dest still conflicts across incarnations and parents.",
      "Keep occupied rollback. Do not add EXISTS rollback (that would delete the winner).",
      "If retry-allow is the fix, the key must be narrower than dest+parent.",
      "Logging of persist incarnation vs EXISTS does not change disposition.",
    ]);
    expect(harvest.sourceText).not.toContain("does not bind as written");
  });

  it("refuses a numbered list without the Bound-remedy heading", () => {
    const lean = [
      "Recut: next-build is not this body.",
      "**Lean:** accept.",
      "",
      "1. numbered without heading",
      "2. still not enough",
    ].join("\n");
    expect(findBoundRemedyHeading(lean)).toBeNull();
    expect(extractBoundRemedyHarvest(lean)).toEqual({
      items: [],
      sourceText: "",
      constraintLines: [],
    });
  });

  it("accepts only the contract level-2 Bound-remedy heading", () => {
    expect(findBoundRemedyHeading("# Bound remedy\n1. not enough")).toBeNull();
    expect(findBoundRemedyHeading("### Bound remedy\n1. nested")).toBeNull();
    expect(findBoundRemedyHeading("## Bound remedy\n1. ok")).not.toBeNull();
  });

  it("does not treat extractPlanItems checkbox-first as this extractor", () => {
    const body = "## Acceptance\n- [ ] withdrawn body checkbox that must not win\n";
    expect(extractBoundRemedyHarvest(body).items).toEqual([]);
    expect(extractBoundRemedyHarvest(LEAN_5587555346).items).toHaveLength(5);
  });

  it("ignores a fenced Bound-remedy example and harvests the operative heading", () => {
    const lean = [
      "```",
      "## Bound remedy",
      "1. example only",
      "```",
      "",
      "## Bound remedy",
      "1. operative item",
    ].join("\n");
    const harvest = extractBoundRemedyHarvest(lean);
    expect(harvest.items.map((item) => item.title)).toEqual(["operative item"]);
    expect(harvest.sourceText).not.toContain("example only");
  });

  it("harvests the same Bound-remedy items when Recut: is rewritten as Spec-path:", () => {
    const recut = extractBoundRemedyHarvest(LEAN_5587555346);
    const specPath = extractBoundRemedyHarvest(LEAN_5587555346.replace("Recut:", "Spec-path:"));
    expect(specPath.items.map((item) => item.title)).toEqual(recut.items.map((item) => item.title));
    expect(specPath.items).toHaveLength(5);
  });
});

describe("parseListItemsByPositionFolded (#7001)", () => {
  it("folds an indented (a)-style sub-list into its parent item", () => {
    const text = [
      "1. First limb.",
      "2. Tests. None needs a build.",
      "   (a) Through the seam.",
      "   (b) In process.",
      "3. Third limb.",
    ].join("\n");
    expect(parseListItemsByPositionFolded(text).map((item) => item.title)).toEqual([
      "First limb.",
      "Tests. None needs a build. (a) Through the seam. (b) In process.",
      "Third limb.",
    ]);
  });

  it("keeps an indented - x or 1. x line as its own item, at its own position", () => {
    const text = "- Parent.\n  - Child one.\n  1. Child two.\n- Next.\n";
    const folded = parseListItemsByPositionFolded(text);
    expect(folded.map((item) => item.title)).toEqual([
      "Parent.",
      "Child one.",
      "Child two.",
      "Next.",
    ]);
    expect(folded).toEqual(parseListItemsByPosition(text));
  });

  it("ends an item at a blank line, so a later indented line does not fold", () => {
    const text = "- Item.\n\n  indented prose after a blank line\n- Next.\n";
    expect(parseListItemsByPositionFolded(text).map((item) => item.title)).toEqual([
      "Item.",
      "Next.",
    ]);
  });

  it("ends an item at an unindented prose line", () => {
    const text = "- Item.\nprose\n  indented after prose\n";
    expect(parseListItemsByPositionFolded(text).map((item) => item.title)).toEqual(["Item."]);
  });

  it("keeps the checkbox status of the first line and folds CRLF continuation text", () => {
    const text = "- [x] Done item\r\n  continues here.\r\n- [ ] Open item\r\n";
    expect(parseListItemsByPositionFolded(text)).toEqual([
      { title: "Done item continues here.", status: "completed" },
      { title: "Open item", status: "proposed" },
    ]);
  });

  it("reads the same rows as parseListItemsByPosition for a list with no continuation line", () => {
    const text = "1. A.\n2. A.\n- [x] B.\n\nprose\n  - C.\n";
    expect(parseListItemsByPositionFolded(text)).toEqual(parseListItemsByPosition(text));
  });
});
