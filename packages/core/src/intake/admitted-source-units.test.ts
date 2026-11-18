import { describe, expect, it } from "vitest";
import {
  admittedSourceUnitsFromBody,
  criteriaListUnits,
  hasCriteriaOnlyRecordShape,
  mayWriteCriteriaOnlyRecord,
  selectAdmittedSourceUnits,
  selectCriteriaOnlyRecord,
} from "./admitted-source-units.js";

const FOOTER = "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)";

const LIST_BODY = [
  "## Summary",
  "",
  "Ingest turns every sentence into a clause. That is wrong.",
  "",
  "## Evidence",
  "",
  "- [ ] a checkbox under Evidence",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] First criterion holds.",
  "- [x] Second criterion",
  "  wraps onto an indented line.",
  "- Third criterion holds.",
  "- First criterion holds.",
  "",
  "## Not in scope",
  "",
  "No new refusal.",
  "",
  "Refs #6599",
  "",
  FOOTER,
].join("\n");

describe("selectAdmittedSourceUnits - list route", () => {
  it("takes the Acceptance Criteria list items, not the prose or other checkboxes", () => {
    const picked = selectAdmittedSourceUnits(LIST_BODY);
    expect(picked.route).toBe("list");
    expect(picked.units).toEqual([
      "First criterion holds.",
      "Second criterion wraps onto an indented line.",
      "Third criterion holds.",
    ]);
    expect(picked.statuses).toEqual(["proposed", "completed", "proposed"]);
  });

  it("joins an indented continuation line but not a following list item", () => {
    const picked = selectAdmittedSourceUnits(
      ["## Acceptance Criteria", "- one", "    two", "  - nested", "- three"].join("\n"),
    );
    expect(picked.units).toEqual(["one two", "nested", "three"]);
  });

  it("keeps an unindented continuation line as part of its item (no text is dropped)", () => {
    const body = [
      "## Acceptance Criteria",
      "- The first criterion starts here",
      "and wraps with no indent.",
      "- The second criterion is short.",
      "",
      "Refs #6599",
    ].join("\n");
    expect(admittedSourceUnitsFromBody(body)).toEqual([
      "The first criterion starts here and wraps with no indent.",
      "The second criterion is short.",
    ]);
  });

  it("stops a continuation at a reference line or the generated footer", () => {
    const body = ["## Acceptance Criteria", "- Only criterion", "Refs #1", FOOTER].join("\n");
    expect(admittedSourceUnitsFromBody(body)).toEqual(["Only criterion"]);
  });

  it("ignores a fenced example heading and uses the real list after it", () => {
    const body = [
      "Example:",
      "```md",
      "## Acceptance Criteria",
      "- fenced bullet",
      "```",
      "",
      "## Acceptance Criteria",
      "- real criterion",
    ].join("\n");
    expect(admittedSourceUnitsFromBody(body)).toEqual(["real criterion"]);
  });

  it("does not let a checkbox elsewhere select the list route", () => {
    const body = ["## Evidence", "- [ ] a checkbox", "", "Some prose stays a sentence."].join("\n");
    const picked = selectAdmittedSourceUnits(body);
    expect(picked.route).toBe("sentence");
    expect(picked.units.join(" ")).toContain("a checkbox");
    expect(picked.units.join(" ")).toContain("Some prose stays a sentence.");
  });

  it("falls to the sentence route when the Acceptance Criteria section has no list", () => {
    const body = ["## Acceptance Criteria", "", "It must work."].join("\n");
    const picked = selectAdmittedSourceUnits(body);
    expect(picked.route).toBe("sentence");
    expect(picked.units).toEqual(["It must work."]);
  });
});

describe("selectAdmittedSourceUnits - sentence route", () => {
  const body = [
    "## Summary",
    "When an issue states no command, ingest makes every sentence a clause.",
    "",
    "## Evidence",
    "Evidence line without a terminator",
    "> quoted evidence line.",
    "",
    "Refs #6599",
    "Tracking #12",
    "Closes #5",
    "Fixes owner/repo#7",
    "Part of #9",
    "",
    FOOTER,
  ].join("\n");

  it("drops headings, reference lines, the footer and quotes", () => {
    const picked = selectAdmittedSourceUnits(body);
    expect(picked.route).toBe("sentence");
    expect(picked.units).toEqual([
      "When an issue states no command, ingest makes every sentence a clause.",
      "Evidence line without a terminator",
    ]);
  });

  it("never glues a heading word onto the next sentence", () => {
    const units = admittedSourceUnitsFromBody("## Summary\nIt breaks. Then it breaks again.");
    expect(units).toEqual(["It breaks.", "Then it breaks again."]);
    expect(units.some((unit) => unit.startsWith("Summary"))).toBe(false);
  });

  it("strips a leading checkbox marker from a list-item sentence", () => {
    expect(admittedSourceUnitsFromBody("- [ ] Do the thing.\n- [x] Do the other thing.")).toEqual([
      "Do the thing.",
      "Do the other thing.",
    ]);
  });

  it("keeps inline code as text", () => {
    expect(admittedSourceUnitsFromBody("Run `pnpm test` now.")).toEqual(["Run `pnpm test` now."]);
  });

  it("returns no units for an empty body", () => {
    expect(admittedSourceUnitsFromBody("")).toEqual([]);
  });
});

const NW = "design-critique: not warranted, because the criteria are the whole change";
const DIGEST = `Target-digest: sha256:${"a".repeat(64)}`;
const RECORD_BODY = [NW, DIGEST, "", "## Acceptance Criteria", "- crit one", "- crit two", ""].join(
  "\n",
);

describe("criteria-only record", () => {
  it("reads the list items of the Acceptance Criteria section", () => {
    expect(criteriaListUnits(RECORD_BODY)).toEqual(["crit one", "crit two"]);
    expect(criteriaListUnits("no list here")).toEqual([]);
  });

  it("needs the not-warranted line, a Target-digest and a list", () => {
    expect(hasCriteriaOnlyRecordShape(RECORD_BODY)).toBe(true);
    expect(hasCriteriaOnlyRecordShape(RECORD_BODY.replace(NW, "nothing"))).toBe(false);
    expect(hasCriteriaOnlyRecordShape(RECORD_BODY.replace(DIGEST, ""))).toBe(false);
    expect(hasCriteriaOnlyRecordShape(`${NW}\n${DIGEST}\n`)).toBe(false);
  });

  const denyAll = { getJson: () => ({ ok: false as const, detail: "404" }) };
  const writer = (permission: string) => ({
    getJson: (path: string) =>
      path.includes("/collaborators/")
        ? { ok: true as const, value: { permission } }
        : { ok: false as const, detail: "unexpected" },
  });

  it("admits the issue's author without a permission read", () => {
    expect(
      mayWriteCriteriaOnlyRecord({
        login: "Author",
        issueAuthor: "author",
        repo: "o/r",
        reader: denyAll,
      }),
    ).toBe(true);
  });

  it("admits a writer who is not the author and refuses a reader or a failed read", () => {
    const base = { login: "other", issueAuthor: "author", repo: "o/r" } as const;
    expect(mayWriteCriteriaOnlyRecord({ ...base, reader: writer("write") })).toBe(true);
    expect(mayWriteCriteriaOnlyRecord({ ...base, reader: writer("maintain") })).toBe(true);
    expect(mayWriteCriteriaOnlyRecord({ ...base, reader: writer("read") })).toBe(false);
    expect(mayWriteCriteriaOnlyRecord({ ...base, reader: denyAll })).toBe(false);
    expect(mayWriteCriteriaOnlyRecord({ ...base, login: null, reader: writer("write") })).toBe(
      false,
    );
  });

  it("uses the latest qualifying comment and skips an unqualified commenter", () => {
    const picked = selectCriteriaOnlyRecord({
      comments: [
        { id: 1, body: RECORD_BODY, login: "author" },
        { id: 2, body: RECORD_BODY.replace("crit two", "crit 2"), login: "stranger" },
        { id: 3, body: "plain comment", login: "author" },
      ],
      issueAuthor: "author",
      repo: "o/r",
      reader: denyAll,
    });
    expect(picked).toMatchObject({ status: "found", commentId: 1 });
    const later = selectCriteriaOnlyRecord({
      comments: [
        { id: 1, body: RECORD_BODY, login: "author" },
        { id: 2, body: RECORD_BODY.replace("crit two", "crit 2"), login: "stranger" },
      ],
      issueAuthor: "author",
      repo: "o/r",
      reader: writer("write"),
    });
    expect(later).toMatchObject({ status: "found", commentId: 2, items: ["crit one", "crit 2"] });
  });

  it("finds nothing when no commenter qualifies", () => {
    expect(
      selectCriteriaOnlyRecord({
        comments: [{ id: 2, body: RECORD_BODY, login: "stranger" }],
        issueAuthor: "author",
        repo: "o/r",
        reader: denyAll,
      }),
    ).toEqual({ status: "none" });
  });
});
