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
    expect(missing).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
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
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "cite-not-lean",
    });
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

  it("does not let a historical table block a recut that cites only the new lean", () => {
    const shaped: ThreadComment = {
      id: SYNTHESIS_ID,
      body: `design-critique: synthesis accepted, because yes\n\nsuccessor lean ${LEAN_ID}\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, shaped],
    });
    expect(verdict).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: null,
    });
  });

  it("blocks a chipless in-flight critique that has a critic post but no record", () => {
    const critic: ThreadComment = {
      id: CRITIC_ID,
      body: "model: grok-4.6\nrole: critic\n\n## Finding 1\nchips are load-bearing\n",
    };
    const verdict = evaluateCompletedArcRecord({ comments: [critic] });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("keeps a valid completed-arc record when a later lone-shape comment exists", () => {
    const lone: ThreadComment = {
      id: SYNTHESIS_ID + 1,
      body: "design-critique: synthesis accepted, because noise\n",
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, synthesis, lone],
    });
    expect(verdict.status).toBe("complete");
    if (verdict.status === "complete") {
      expect(verdict.synthesisCommentId).toBe(SYNTHESIS_ID);
    }
  });

  it("blocks a chipless panel-deposit before any critic posts", () => {
    const deposit: ThreadComment = {
      id: CRITIC_ID - 1,
      body: "model: grok-4.6\nrole: parent\n\npanel-deposit\nround: 1\nsiblings: 3\ninput-ceiling: 5390001612\n",
    };
    const verdict = evaluateCompletedArcRecord({ comments: [deposit] });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("blocks a recut lean plus incomplete later synthesis instead of reusing stale clearance", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "**Lean:** recut of 5442939496. New takes.\n",
    };
    const incomplete: ThreadComment = {
      id: SYNTHESIS_ID + 20,
      body: "design-critique: synthesis accepted, because recut still open\n",
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, synthesis, recutLean, incomplete],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "lone-shape" });
  });

  it("blocks a recut lean with no new synthesis yet", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "**Lean:** recut of 5442939496. New takes.\n",
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, synthesis, recutLean],
    });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("completes a recut when synthesis cites the latest lean", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "**Lean:** recut of 5442939496. New takes.\n",
    };
    const recutSynthesis: ThreadComment = {
      id: SYNTHESIS_ID + 20,
      body:
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `successor lean ${recutLean.id}\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, synthesis, recutLean, recutSynthesis],
    });
    expect(verdict).toEqual({
      status: "complete",
      synthesisCommentId: recutSynthesis.id,
      citedLeanId: recutLean.id,
      citedTableId: null,
    });
  });
});

describe("completed-arc citation grammar (#3831)", () => {
  const houseStyle: ThreadComment = {
    id: SYNTHESIS_ID,
    body:
      "model: claude-opus-5\nrole: parent\n\n" +
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      `Bound contract: successor lean \`${LEAN_ID}\`, verified-claims table \`${TABLE_ID}\`.\n`,
  };

  it("completes a synthesis whose ids sit in code spans", () => {
    expect(evaluateCompletedArcRecord({ comments: [lean, table, houseStyle] })).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("completes a synthesis whose citation keywords are bolded", () => {
    const bolded: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `**successor lean:** ${LEAN_ID}. **verified-claims table:** ${TABLE_ID}.\n`,
    };
    expect(evaluateCompletedArcRecord({ comments: [lean, table, bolded] })).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("completes a permalink synthesis, the form this arc's own record used", () => {
    const permalink: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `Bound contract: [successor lean](https://github.com/deftai/directive/issues/3831#issuecomment-${LEAN_ID}), ` +
        `[verified-claims table](https://github.com/deftai/directive/issues/3831#issuecomment-${TABLE_ID}).\n`,
    };
    expect(evaluateCompletedArcRecord({ comments: [lean, table, permalink] })).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("no longer waives the table requirement when the table id is decorated", () => {
    const ghostTable: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `successor lean ${LEAN_ID}, verified-claims table \`5439999999\`.\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, ghostTable],
    });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "missing-table-cite",
    });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("5439999999");
    }
  });

  it("resolves the typed table id across mixed-form matrices", () => {
    const matrices: ReadonlyArray<readonly [string, string]> = [
      [
        "bare lean, decorated table",
        `successor lean ${LEAN_ID}, verified-claims table \`${TABLE_ID}\``,
      ],
      [
        "decorated lean, bare table",
        `successor lean \`${LEAN_ID}\`, verified-claims table ${TABLE_ID}`,
      ],
      [
        "bolded keyword, decorated table",
        `**successor lean** ${LEAN_ID}, **verified-claims table** \`${TABLE_ID}\``,
      ],
    ];
    for (const [label, cite] of matrices) {
      const shaped: ThreadComment = {
        id: SYNTHESIS_ID,
        body: `design-critique: synthesis accepted, because agents agreed\n\n${cite}\n`,
      };
      expect(evaluateCompletedArcRecord({ comments: [lean, table, shaped] }), label).toEqual({
        status: "complete",
        synthesisCommentId: SYNTHESIS_ID,
        citedLeanId: LEAN_ID,
        citedTableId: TABLE_ID,
      });
    }
  });

  it("clears on set membership, so citing the superseded lean first does not block", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "**Lean:** recut of 5442939496. New takes.\n",
    };
    const supersededFirst: ThreadComment = {
      id: SYNTHESIS_ID + 20,
      body:
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `Supersedes successor lean ${LEAN_ID}. The bound contract is successor lean ${recutLean.id}.\n`,
    };
    const boundFirst: ThreadComment = {
      id: SYNTHESIS_ID + 20,
      body:
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `The bound contract is successor lean ${recutLean.id}, superseding successor lean ${LEAN_ID}.\n`,
    };
    for (const record of [supersededFirst, boundFirst]) {
      expect(
        evaluateCompletedArcRecord({
          comments: [lean, table, recutLean, record],
        }),
        record.body,
      ).toEqual({
        status: "complete",
        synthesisCommentId: record.id,
        citedLeanId: recutLean.id,
        citedTableId: null,
      });
    }
  });

  it("does not assert a recut when a record cites only the superseded lean", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "**Lean:** recut of 5442939496. New takes.\n",
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, synthesis, recutLean],
    });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
    if (verdict.status === "blocked") {
      expect(verdict.detail).not.toContain("recut");
      expect(verdict.detail).toContain(String(recutLean.id));
      expect(verdict.detail).toContain(String(LEAN_ID));
    }
  });

  it("refuses every non-affirmative position class", () => {
    const positions: ReadonlyArray<readonly [string, string]> = [
      ["fenced", `\`\`\`text\nsuccessor lean ${LEAN_ID}\n\`\`\``],
      ["inline code span", `the parser wants \`successor lean ${LEAN_ID}\` shaped text`],
      ["blockquote", `> they wrote: successor lean ${LEAN_ID}`],
      ["strikethrough", `~~successor lean ${LEAN_ID}~~ withdrawn`],
      ["negation", `do not use successor lean ${LEAN_ID}`],
    ];
    for (const [label, cite] of positions) {
      const shaped: ThreadComment = {
        id: SYNTHESIS_ID,
        body: `design-critique: synthesis accepted, because I say so\n\n${cite}\n`,
      };
      const verdict = evaluateCompletedArcRecord({
        comments: [lean, table, shaped],
      });
      expect(verdict, label).toMatchObject({
        status: "blocked",
        reason: "lone-shape",
      });
      if (verdict.status === "blocked") {
        expect(verdict.detail, label).toContain("refused by position");
      }
    }
  });

  it("echoes the observation instead of guessing at a cause", () => {
    const decorated: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `successor lean **${LEAN_ID}**, verified-claims table **${TABLE_ID}**.\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, table, decorated],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "lone-shape" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("2 8-or-more digit id(s) appear in the body");
      expect(verdict.detail).toContain(String(LEAN_ID));
      expect(verdict.detail).toContain("accepted forms:");
      expect(verdict.detail).toContain("successor lean `12345678`");
      expect(verdict.detail).not.toContain("refused by position");
    }
  });

  it("says so plainly when the body carries no id at all", () => {
    const bare: ThreadComment = {
      id: SYNTHESIS_ID,
      body: "design-critique: synthesis accepted, because agents agreed\n",
    };
    const verdict = evaluateCompletedArcRecord({ comments: [lean, bare] });
    expect(verdict).toMatchObject({ status: "blocked", reason: "lone-shape" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("no 8-or-more digit id appears in the body");
    }
  });

  it("truncates a long id list in the detail", () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => 54400000 + n);
    const noisy: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `ids: ${many.join(" ")}\n`,
    };
    const verdict = evaluateCompletedArcRecord({ comments: [lean, noisy] });
    expect(verdict).toMatchObject({ status: "blocked", reason: "lone-shape" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("and 2 more");
    }
  });

  it("names the cited ids when none of them is a lean", () => {
    const critic: ThreadComment = {
      id: CRITIC_ID,
      body: "role: critic\n\n## Finding 1\n",
    };
    const shaped: ThreadComment = {
      id: SYNTHESIS_ID,
      body: `design-critique: synthesis accepted, because yes\n\ncomment ${CRITIC_ID}\n`,
    };
    const verdict = evaluateCompletedArcRecord({ comments: [critic, shaped] });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "cite-not-lean",
    });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(CRITIC_ID));
    }
  });

  it("names the accepted forms when the record is missing entirely", () => {
    const verdict = evaluateCompletedArcRecord({
      labels: ["design-critique:mechanism-shaped"],
      comments: [lean],
    });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("#issuecomment-12345678");
    }
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
