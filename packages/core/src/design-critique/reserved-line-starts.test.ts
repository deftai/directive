/**
 * Reserved line-starts inside a mandated plain-language summary (#3929).
 *
 * `content/contracts/design-critique.md` `## Plain-language summary` requires a
 * summary on the successor lean and on the synthesis, and prohibits three
 * reserved line-start families inside it per a per-artifact matrix. These cases
 * exercise each family on each artifact kind. Contract-token locking alone
 * cannot observe an arc comment.
 *
 * The lean-as-its-own-table cell is asserted at the shape predicate only. Its
 * ingest consequence -- a synthesis citing a table id that is not a table still
 * clearing -- is the #3932 defect and is not remediated or pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateCompletedArcRecord,
  extractCitedCommentIds,
  isSuccessorLeanBody,
  isSynthesisAcceptedShape,
  isVerifiedClaimsTableBody,
  type ThreadComment,
} from "./completed-arc-record.js";

const LEAN_ID = 5466361010;
const TABLE_ID = 5466397546;
const SYNTHESIS_ID = 5466399388;
const CRITIC_ID = 5466306525;

const ACCEPTED_SENTENCE =
  "design-critique: synthesis accepted, because agents agreed (empty disagreement set)";

/** Nine spellings: zero to two asterisks counted independently on each side. */
const LEAN_TOKEN_SPELLINGS = [
  "Lean:",
  "*Lean:",
  "**Lean:",
  "Lean:*",
  "Lean:**",
  "*Lean:*",
  "*Lean:**",
  "**Lean:*",
  "**Lean:**",
] as const;

const lean: ThreadComment = {
  id: LEAN_ID,
  body:
    "model: grok-4.6\nrole: parent\n\n" +
    "**Lean:** the target does not survive as written.\n\n" +
    "## In plain English\n\nThe arc found three blocking defects.\n\n" +
    `Supersedes comment ${CRITIC_ID}.\n`,
};

const table: ThreadComment = {
  id: TABLE_ID,
  body: "## Verified-claims table\n\n| # | Claim | Method | Verdict |\n| --- | --- | --- | --- |\n",
};

const synthesis: ThreadComment = {
  id: SYNTHESIS_ID,
  body:
    "model: grok-4.6\nrole: parent\n\n" +
    `${ACCEPTED_SENTENCE}\n\n` +
    "## In plain English\n\nThe design survived; two criteria were struck.\n\n" +
    `Citing accepted successor lean ${LEAN_ID} and verified-claims table ${TABLE_ID}.\n`,
};

const completeArc = [lean, table, synthesis];

function summaryWithLine(base: ThreadComment, line: string, id?: number): ThreadComment {
  return {
    id: id ?? base.id,
    body: base.body.replace("## In plain English\n\n", `## In plain English\n\n${line}\n\n`),
  };
}

describe("mandated summary keeps a complete arc complete (#3929)", () => {
  it("clears ingest when both artifacts carry the heading token and no reserved line-start", () => {
    expect(evaluateCompletedArcRecord({ comments: completeArc })).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("does not let the heading token itself classify either comment", () => {
    expect(isSuccessorLeanBody(synthesis.body)).toBe(false);
    expect(isVerifiedClaimsTableBody(synthesis.body)).toBe(false);
    expect(isVerifiedClaimsTableBody(lean.body)).toBe(false);
    expect(isSynthesisAcceptedShape(lean.body)).toBe(false);
  });
});

describe("family 1 -- successor-lean token (#3929)", () => {
  it("blocks a complete arc from a synthesis summary, in all nine spellings", () => {
    for (const spelling of LEAN_TOKEN_SPELLINGS) {
      const shaped = summaryWithLine(synthesis, `${spelling} the design survives.`);
      expect(isSuccessorLeanBody(shaped.body), spelling).toBe(true);
      const verdict = evaluateCompletedArcRecord({ comments: [lean, table, shaped] });
      expect(verdict, spelling).toMatchObject({
        status: "blocked",
        reason: "missing-record",
      });
      if (verdict.status === "blocked") {
        // The record now has to cite the synthesis against itself to clear.
        expect(verdict.detail, spelling).toContain(String(SYNTHESIS_ID));
      }
    }
  });

  it("blocks the same arc from an unrelated later comment", () => {
    const walk: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: `model: grok-4.6\nrole: parent\n\nAccept 1, critic ${CRITIC_ID}.\n\n**Lean:** on that heading only.\n`,
    };
    const verdict = evaluateCompletedArcRecord({ comments: [...completeArc, walk] });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-record" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(walk.id));
    }
  });

  it("is inert inside a lean summary, because the comment already is the lean", () => {
    for (const spelling of LEAN_TOKEN_SPELLINGS) {
      const shaped = summaryWithLine(lean, `${spelling} restating the take.`);
      const verdict = evaluateCompletedArcRecord({ comments: [shaped, table, synthesis] });
      expect(verdict, spelling).toEqual({
        status: "complete",
        synthesisCommentId: SYNTHESIS_ID,
        citedLeanId: LEAN_ID,
        citedTableId: TABLE_ID,
      });
    }
  });
});

describe("family 2 -- verified-claims-table heading (#3929)", () => {
  it("makes a lean read as the table as well as the lean", () => {
    const shaped = summaryWithLine(lean, "## Verified-claims table");
    expect(isSuccessorLeanBody(shaped.body)).toBe(true);
    expect(isVerifiedClaimsTableBody(shaped.body)).toBe(true);
  });

  it("makes a synthesis read as its own table", () => {
    const shaped = summaryWithLine(synthesis, "## Verified-claims table");
    expect(isSynthesisAcceptedShape(shaped.body)).toBe(true);
    expect(isVerifiedClaimsTableBody(shaped.body)).toBe(true);
  });
});

describe("family 3 -- the fixed accepted sentence (#3929)", () => {
  it("reclassifies a lean as a synthesis even inside a fence", () => {
    const fenced = summaryWithLine(
      lean,
      "What the synthesis will state:\n\n```text\n" + ACCEPTED_SENTENCE + "\n```",
      LEAN_ID + 10,
    );
    expect(isSynthesisAcceptedShape(fenced.body)).toBe(true);
  });

  it("flips a complete arc to blocked, with the reason depending on the lean citations", () => {
    const fenceBlock = "```text\n" + ACCEPTED_SENTENCE + "\n```";
    const withCites = summaryWithLine(lean, fenceBlock, SYNTHESIS_ID + 10);
    const cited = evaluateCompletedArcRecord({ comments: [...completeArc, withCites] });
    expect(cited).toMatchObject({ status: "blocked", reason: "cite-not-lean" });

    const withoutCites: ThreadComment = {
      id: SYNTHESIS_ID + 20,
      body: `model: grok-4.6\nrole: parent\n\n**Lean:** unchanged.\n\n## In plain English\n\n${fenceBlock}\n`,
    };
    const bare = evaluateCompletedArcRecord({ comments: [...completeArc, withoutCites] });
    expect(bare).toMatchObject({ status: "blocked", reason: "lone-shape" });
  });

  it("is undetected in a blockquote, where the citation predicate refuses instead", () => {
    const quoted = summaryWithLine(lean, `> ${ACCEPTED_SENTENCE}`, LEAN_ID + 30);
    expect(isSynthesisAcceptedShape(quoted.body)).toBe(false);
    // No one quoting convention is safe for both parsers: the same blockquote
    // that hides the sentence from the shape predicate refuses a citation.
    expect(extractCitedCommentIds(`> Citing accepted successor lean ${LEAN_ID}.`)).toEqual([]);
    expect(extractCitedCommentIds(`Citing accepted successor lean ${LEAN_ID}.`)).toEqual([LEAN_ID]);
  });
});
