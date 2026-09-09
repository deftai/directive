import { describe, expect, it } from "vitest";
import {
  extractBoundRemedyHarvest,
  findAcHeading,
  findBoundRemedyHeading,
  parseCheckboxItems,
  parseListItems,
  sliceAcSection,
  stripCodeBlocks,
  stripFencedCodeBlocks,
} from "./markdown-scanners.js";

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
    expect(extractBoundRemedyHarvest(lean)).toEqual({ items: [], sourceText: "" });
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
});
