import { describe, expect, it } from "vitest";
import {
  assertCompletedArcAllowsIngest,
  DesignCritiqueIngestBlockedError,
  evaluateCompletedArcRecord,
  extractCitedCommentIds,
  type ThreadComment,
} from "./completed-arc-record.js";

const LEAN_ID = 5442939496;
const TABLE_ID = 5443106967;
const SYNTHESIS_ID = 5443114746;
const CRITIC_ID = 5442800000;

const lean: ThreadComment = {
  id: LEAN_ID,
  body: "**Lean:** operator amend of 5442883752. Chips stay convenience.\n",
};

const table: ThreadComment = {
  id: TABLE_ID,
  body: "## Verified-claims table\n\n| Verified claim | Result |\n",
};

const synthesis: ThreadComment = {
  id: SYNTHESIS_ID,
  body:
    "model: grok-4.6\nrole: parent\n\n" +
    "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
    `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
};

describe("extractCitedCommentIds", () => {
  it("reads successor lean, table, and issuecomment URLs", () => {
    expect(
      extractCitedCommentIds(
        `successor lean ${LEAN_ID} verified-claims table ${TABLE_ID} ` +
          `https://github.com/deftai/directive/issues/comments/${LEAN_ID}`,
      ),
    ).toEqual([LEAN_ID, TABLE_ID]);
  });
});

describe("evaluateCompletedArcRecord (#3806)", () => {
  it("lets ordinary issues through with no chip and no synthesis shape", () => {
    expect(evaluateCompletedArcRecord({ labels: ["bug"], comments: [] })).toEqual({
      status: "not-in-arc",
    });
  });

  it("completes when synthesis cites the accepted lean and table", () => {
    const verdict = evaluateCompletedArcRecord({
      labels: ["design-critique:mechanism-shaped", "bug"],
      comments: [lean, table, synthesis],
    });
    expect(verdict).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("does not treat leftover mechanism-shaped or triage-ready as clearance", () => {
    const missing = evaluateCompletedArcRecord({
      labels: ["design-critique:triage-ready"],
      comments: [],
    });
    expect(missing).toMatchObject({ status: "blocked", reason: "missing-record" });
  });

  it("blocks a lone synthesis-accepted sentence that does not cite a lean", () => {
    const lone: ThreadComment = {
      id: SYNTHESIS_ID,
      body: "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n",
    };
    const verdict = evaluateCompletedArcRecord({
      labels: ["design-critique:triage-ready"],
      comments: [lean, lone],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "lone-shape" });
  });

  it("blocks a cite that is not a successor lean", () => {
    const critic: ThreadComment = {
      id: CRITIC_ID,
      body: "role: critic\n\n## Finding 1\nchips are load-bearing\n",
    };
    const shaped: ThreadComment = {
      id: SYNTHESIS_ID,
      body: `design-critique: synthesis accepted, because yes\n\ncomment ${CRITIC_ID}\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [critic, shaped],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "cite-not-lean" });
  });

  it("ignores author_association and GitHub login", () => {
    const verdict = evaluateCompletedArcRecord({
      labels: ["design-critique:mechanism-shaped"],
      comments: [lean, table, synthesis],
    });
    expect(verdict.status).toBe("complete");
  });

  it("does not require the triage-ready chip once the record is present", () => {
    const verdict = evaluateCompletedArcRecord({
      labels: ["bug", "design-critique:mechanism-shaped"],
      comments: [lean, table, synthesis],
    });
    expect(verdict.status).toBe("complete");
  });

  it("selects the highest-id synthesis comment even when thread order is reversed", () => {
    const older: ThreadComment = {
      id: SYNTHESIS_ID - 1,
      body: "design-critique: synthesis accepted, because stale\n",
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [synthesis, older, lean, table],
    });
    expect(verdict.status).toBe("complete");
    if (verdict.status === "complete") {
      expect(verdict.synthesisCommentId).toBe(SYNTHESIS_ID);
    }
  });

  it("completes without a verified-claims table when none was posted", () => {
    const shaped: ThreadComment = {
      id: SYNTHESIS_ID,
      body: `design-critique: synthesis accepted, because yes\n\nsuccessor lean ${LEAN_ID}\n`,
    };
    const verdict = evaluateCompletedArcRecord({ comments: [lean, shaped] });
    expect(verdict).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: null,
    });
  });

  it("blocks when a verified-claims table was posted but not cited", () => {
    const shaped: ThreadComment = {
      id: SYNTHESIS_ID,
      body: `design-critique: synthesis accepted, because yes\n\nsuccessor lean ${LEAN_ID}\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, shaped],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
  });
});

describe("assertCompletedArcAllowsIngest", () => {
  it("throws a non-halt ingest error on lone shape", () => {
    expect(() =>
      assertCompletedArcAllowsIngest({
        issueNumber: 3806,
        comments: [
          {
            id: SYNTHESIS_ID,
            body: "design-critique: synthesis accepted, because empty disagreement set\n",
          },
        ],
      }),
    ).toThrow(DesignCritiqueIngestBlockedError);
  });

  it("returns complete for the bound #3806 record", () => {
    const verdict = assertCompletedArcAllowsIngest({
      issueNumber: 3806,
      labels: ["design-critique:triage-ready"],
      comments: [lean, table, synthesis],
    });
    expect(verdict.status).toBe("complete");
  });
});
