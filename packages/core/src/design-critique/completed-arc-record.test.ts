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

  it("picks the newest of several records that all cite the latest lean", () => {
    const first: ThreadComment = {
      id: SYNTHESIS_ID,
      body: `design-critique: synthesis accepted, because first\n\nsuccessor lean ${LEAN_ID}\n`,
    };
    const second: ThreadComment = {
      id: SYNTHESIS_ID + 5,
      body: `design-critique: synthesis accepted, because second\n\nsuccessor lean \`${LEAN_ID}\`\n`,
    };
    for (const order of [
      [lean, first, second],
      [lean, second, first],
    ]) {
      const verdict = evaluateCompletedArcRecord({ comments: order });
      expect(verdict).toMatchObject({ status: "complete", synthesisCommentId: second.id });
    }
  });

  it("re-evaluates the newest of several later syntheses after a stale record", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "**Lean:** recut take\n",
    };
    const staleLater: ThreadComment = {
      id: SYNTHESIS_ID + 20,
      body: "design-critique: synthesis accepted, because still open\n",
    };
    const newestLater: ThreadComment = {
      id: SYNTHESIS_ID + 30,
      body: `design-critique: synthesis accepted, because recut bound\n\nsuccessor lean ${recutLean.id}\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, synthesis, recutLean, staleLater, newestLater],
    });
    expect(verdict).toMatchObject({ status: "complete", synthesisCommentId: newestLater.id });
  });

  it("evaluates the newest synthesis when none of them completes", () => {
    const older: ThreadComment = {
      id: SYNTHESIS_ID,
      body: "design-critique: synthesis accepted, because older\n",
    };
    const newer: ThreadComment = {
      id: SYNTHESIS_ID + 1,
      body: `design-critique: synthesis accepted, because newer\n\ncomment ${CRITIC_ID}\n`,
    };
    const critic: ThreadComment = { id: CRITIC_ID, body: "role: critic\n\n## Finding 1\n" };
    expect(evaluateCompletedArcRecord({ comments: [critic, older, newer] })).toMatchObject({
      status: "blocked",
      reason: "cite-not-lean",
    });
  });

  it("reads the latest lean when the thread lists leans newest first", () => {
    const newerLean: ThreadComment = { id: LEAN_ID + 100, body: "**Lean:** recut take\n" };
    const record: ThreadComment = {
      id: SYNTHESIS_ID,
      body: `design-critique: synthesis accepted, because yes\n\nsuccessor lean ${newerLean.id}\n`,
    };
    expect(evaluateCompletedArcRecord({ comments: [newerLean, lean, record] })).toMatchObject({
      status: "complete",
      citedLeanId: newerLean.id,
    });
  });

  it("recognises a panel-deposit from its fields when the literal token is absent", () => {
    const deposit: ThreadComment = {
      id: CRITIC_ID,
      body: "model: grok-4.6\nrole: parent\n\nround: 1\nsiblings: 3\ninput-ceiling: 5390001612\n",
    };
    expect(evaluateCompletedArcRecord({ comments: [deposit] })).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("leaves a thread with neither deposit fields nor a critic post out of the arc", () => {
    const chatter: ThreadComment = { id: CRITIC_ID, body: "role: parent\n\nsiblings: 3\n" };
    expect(evaluateCompletedArcRecord({ comments: [chatter] })).toEqual({ status: "not-in-arc" });
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

describe("verified-claims table resolution precedence (#3932)", () => {
  const GHOST_TABLE_ID = 5499999999;
  const SECOND_TABLE_ID = 5443106999;
  const TABLE_SHAPED_CRITIC_ID = 5442700000;

  /** A critic comment that quotes the table heading while arguing about it. */
  const tableShapedCritic: ThreadComment = {
    id: TABLE_SHAPED_CRITIC_ID,
    body:
      "model: gpt-5.6-sol\nrole: critic\n\n" +
      "## Verified-claims table\n\nThe parent's table under-reports its methods.\n",
  };

  const secondTable: ThreadComment = {
    id: SECOND_TABLE_ID,
    body: "## Verified-claims table\n\n| Verified claim | Result |\n",
  };

  const record = (cite: string): ThreadComment => ({
    id: SYNTHESIS_ID,
    body: `design-critique: synthesis accepted, because agents agreed\n\n${cite}\n`,
  });

  it("refuses a typed table claim that is not a table, even when another cited body is table-shaped", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [
        lean,
        tableShapedCritic,
        record(
          `successor lean ${LEAN_ID}, verified-claims table ${GHOST_TABLE_ID}, ` +
            `comment ${TABLE_SHAPED_CRITIC_ID}`,
        ),
      ],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(GHOST_TABLE_ID));
    }
  });

  it("refuses a ghost typed claim beside a valid one, in both orders", () => {
    const orders: ReadonlyArray<readonly [string, string]> = [
      [
        "ghost first",
        `successor lean ${LEAN_ID}, verified-claims table ${GHOST_TABLE_ID}, ` +
          `verified-claims table ${TABLE_ID}`,
      ],
      [
        "valid first",
        `successor lean ${LEAN_ID}, verified-claims table ${TABLE_ID}, ` +
          `verified-claims table ${GHOST_TABLE_ID}`,
      ],
    ];
    for (const [label, cite] of orders) {
      const verdict = evaluateCompletedArcRecord({ comments: [lean, table, record(cite)] });
      expect(verdict, label).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
      expect(verdict, label).not.toHaveProperty("citedTableId");
      if (verdict.status === "blocked") {
        expect(verdict.detail, label).toContain(String(GHOST_TABLE_ID));
      }
    }
  });

  it("refuses two typed claims that name different tables", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [
        lean,
        table,
        secondTable,
        record(
          `successor lean ${LEAN_ID}, verified-claims table ${TABLE_ID}, ` +
            `verified-claims table ${SECOND_TABLE_ID}`,
        ),
      ],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "ambiguous-table-cite" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(TABLE_ID));
      expect(verdict.detail).toContain(String(SECOND_TABLE_ID));
    }
  });

  it("resolves the typed claim, not the generic citation that precedes it", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [
        lean,
        table,
        tableShapedCritic,
        record(
          `comment ${TABLE_SHAPED_CRITIC_ID} argues about it; the record is ` +
            `successor lean ${LEAN_ID}, verified-claims table ${TABLE_ID}`,
        ),
      ],
    });
    expect(verdict).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("reads a repeated citation of one table id as a single claim", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [
        lean,
        table,
        record(
          `successor lean ${LEAN_ID}, verified-claims table ${TABLE_ID}. ` +
            `Rows are in verified-claims table ${TABLE_ID}`,
        ),
      ],
    });
    expect(verdict).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("keeps generic resolution unchanged when the record carries no typed claim", () => {
    const generic: ReadonlyArray<readonly [string, string]> = [
      ["comment keyword", `comment ${LEAN_ID}, comment ${TABLE_ID}`],
      ["issuecomment anchor", `#issuecomment-${LEAN_ID} and #issuecomment-${TABLE_ID}`],
      ["comments permalink", `/issues/comments/${LEAN_ID} and /issues/comments/${TABLE_ID}`],
    ];
    for (const [label, cite] of generic) {
      expect(evaluateCompletedArcRecord({ comments: [lean, table, record(cite)] }), label).toEqual({
        status: "complete",
        synthesisCommentId: SYNTHESIS_ID,
        citedLeanId: LEAN_ID,
        citedTableId: TABLE_ID,
      });
    }
  });
});

describe("typed table refusal partition (#3942)", () => {
  const GHOST_TABLE_ID = 5499999999;

  /** Table ids from the seven live arc threads, the recorded AC5 baseline. */
  const LIVE_TABLE_IDS = [
    5458204775, 5458431222, 5466045455, 5466061856, 5466142398, 5466430284, 5466455972,
  ] as const;

  /** A real table by every published obligation: method column, claim rows, no heading. */
  const headinglessTable: ThreadComment = {
    id: TABLE_ID,
    body:
      "model: grok-4.6\nrole: parent\n\n" +
      "| # | Claim | Method | Result | Verdict |\n| --- | --- | --- | --- | --- |\n" +
      "| 1 | the refusal names the citation | parent re-ran the resolver | " +
      "the detail asserts a cause that is false in this state | verified |\n",
  };

  const typedRecord = (tableId: number): ThreadComment => ({
    id: SYNTHESIS_ID,
    body:
      "design-critique: synthesis accepted, because agents agreed\n\n" +
      `successor lean ${LEAN_ID}, verified-claims table ${tableId}\n`,
  });

  it("refuses a cited thread comment that carries no heading with its own reason", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, headinglessTable, typedRecord(TABLE_ID)],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "unshaped-table-cite" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(TABLE_ID));
      expect(verdict.detail).toContain("## Verified-claims table");
      expect(verdict.detail).toContain("add that heading to the cited comment");
      // The state this is not: the cited id is on the thread.
      expect(verdict.detail).not.toContain("not a comment on this thread");
    }
  });

  it("keeps the existing reason for a typed id that is not on the thread", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [lean, headinglessTable, typedRecord(GHOST_TABLE_ID)],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(GHOST_TABLE_ID));
      expect(verdict.detail).not.toContain("add that heading to the cited comment");
    }
  });

  it("gives the two states different reasons and details that differ by more than the id", () => {
    const onThread = evaluateCompletedArcRecord({
      comments: [lean, headinglessTable, typedRecord(TABLE_ID)],
    });
    const offThread = evaluateCompletedArcRecord({
      comments: [lean, headinglessTable, typedRecord(GHOST_TABLE_ID)],
    });
    expect(onThread).toMatchObject({ status: "blocked" });
    expect(offThread).toMatchObject({ status: "blocked" });
    if (onThread.status === "blocked" && offThread.status === "blocked") {
      expect(onThread.reason).not.toBe(offThread.reason);
      // Before this partition the two details were identical modulo the id.
      expect(onThread.detail.replace(String(TABLE_ID), "<id>")).not.toBe(
        offThread.detail.replace(String(GHOST_TABLE_ID), "<id>"),
      );
    }
  });

  it("reports both classes when one typed claim is absent and another carries no heading", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [
        lean,
        headinglessTable,
        {
          id: SYNTHESIS_ID,
          body:
            "design-critique: synthesis accepted, because agents agreed\n\n" +
            `successor lean ${LEAN_ID}, verified-claims table ${GHOST_TABLE_ID}, ` +
            `verified-claims table ${TABLE_ID}\n`,
        },
      ],
    });
    // An absent id ranks first: a body that is not there cannot be given a heading.
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(GHOST_TABLE_ID));
      expect(verdict.detail).toContain(String(TABLE_ID));
    }
  });

  it("leaves the untyped path completing with a null table id", () => {
    const untyped: ReadonlyArray<readonly [string, string]> = [
      ["comment keyword", `successor lean ${LEAN_ID}, comment ${TABLE_ID}`],
      ["permalink path", `successor lean ${LEAN_ID}, /issues/comments/${TABLE_ID}`],
      ["table not named", `successor lean ${LEAN_ID}`],
    ];
    for (const [label, cite] of untyped) {
      const record: ThreadComment = {
        id: SYNTHESIS_ID,
        body: `design-critique: synthesis accepted, because agents agreed\n\n${cite}\n`,
      };
      expect(
        evaluateCompletedArcRecord({ comments: [lean, headinglessTable, record] }),
        label,
      ).toEqual({
        status: "complete",
        synthesisCommentId: SYNTHESIS_ID,
        citedLeanId: LEAN_ID,
        citedTableId: null,
      });
    }
  });

  it("carries the new reason through the ingest assertion", () => {
    let thrown: unknown;
    try {
      assertCompletedArcAllowsIngest({
        issueNumber: 3942,
        comments: [lean, headinglessTable, typedRecord(TABLE_ID)],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DesignCritiqueIngestBlockedError);
    expect((thrown as DesignCritiqueIngestBlockedError).reason).toBe("unshaped-table-cite");
  });

  it("resolves a detected table unchanged for every recorded live arc id", () => {
    for (const id of LIVE_TABLE_IDS) {
      const live: ThreadComment = {
        id,
        body:
          "## Verified-claims table\n\n| # | Claim | Method | Verdict |\n" +
          "| --- | --- | --- | --- |\n",
      };
      expect(
        evaluateCompletedArcRecord({ comments: [lean, live, typedRecord(id)] }),
        String(id),
      ).toEqual({
        status: "complete",
        synthesisCommentId: SYNTHESIS_ID,
        citedLeanId: LEAN_ID,
        citedTableId: id,
      });
    }
  });
});

describe("set-level recut-then-ingest refuse (#4057)", () => {
  const cancel: ThreadComment = {
    id: 5499000001,
    body: "model: grok-4.6\nrole: parent\n\ndesign-critique: cancelled, because dominated into the set-level bind\n",
  };
  const dominatePointer: ThreadComment = {
    id: 5496111895,
    body: "model: grok-4.6\nrole: parent\n\nDominate into #3953.\n",
  };
  const leftoverCritic: ThreadComment = {
    id: 5471786938,
    body: "model: grok-4.5\nrole: critic\n\n## Finding 1\nleftover N=1 motion\n",
  };
  const setLevelCharter: ThreadComment = {
    id: 5495812914,
    body: "model: grok-4.6\nrole: triage\n\n" + "target shape: set-level (#3953, #3918, #3849)\n",
  };
  const recutShape: ThreadComment = {
    id: 5499000100,
    body: "model: grok-4.6\nrole: parent\n\ntarget shape: single issue premise\n",
  };
  const recutLean: ThreadComment = {
    id: 5499000200,
    body: "**Lean:** dest-based classifier story after recut.\n",
  };
  const recutSynthesis: ThreadComment = {
    id: 5499000300,
    body:
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      "successor lean 5499000200\n",
  };

  it("lets a parent dominate pointer through as not-in-arc", () => {
    expect(evaluateCompletedArcRecord({ comments: [dominatePointer] })).toEqual({
      status: "not-in-arc",
    });
  });

  it("keeps leftover mechanism-shaped without cancel as missing-record", () => {
    expect(
      evaluateCompletedArcRecord({
        labels: ["design-critique:mechanism-shaped"],
        comments: [leftoverCritic],
      }),
    ).toMatchObject({ status: "blocked", reason: "missing-record" });
  });

  it("treats cancel as terminal refuse even with leftover critic", () => {
    const verdict = evaluateCompletedArcRecord({
      labels: ["design-critique:mechanism-shaped"],
      comments: [leftoverCritic, cancel],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "cancelled" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(cancel.id));
    }
  });

  it("does not treat halt as cancel", () => {
    const halted: ThreadComment = {
      id: 5499000002,
      body: "model: grok-4.6\nrole: parent\n\ndesign-critique: halted, because same-fingerprint\n",
    };
    expect(evaluateCompletedArcRecord({ comments: [halted] })).toEqual({
      status: "not-in-arc",
    });
  });

  it("refuses a complete set-level anchor as unrecut-body", () => {
    const verdict = evaluateCompletedArcRecord({
      labels: ["design-critique:triage-ready"],
      comments: [setLevelCharter, lean, table, synthesis],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "unrecut-body" });
  });

  it("still completes a single-issue bound record", () => {
    expect(
      evaluateCompletedArcRecord({
        labels: ["design-critique:triage-ready"],
        comments: [lean, table, synthesis],
      }),
    ).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("lets a later recut lean after cancel start a new arc", () => {
    expect(
      evaluateCompletedArcRecord({
        comments: [leftoverCritic, cancel, recutLean],
      }),
    ).toMatchObject({ status: "blocked", reason: "missing-record" });
  });

  it("completes a recut single-issue arc after cancel", () => {
    expect(
      evaluateCompletedArcRecord({
        comments: [leftoverCritic, cancel, recutShape, recutLean, recutSynthesis],
      }),
    ).toEqual({
      status: "complete",
      synthesisCommentId: recutSynthesis.id,
      citedLeanId: recutLean.id,
      citedTableId: null,
    });
  });

  it("throws cancelled through the ingest assertion", () => {
    expect(() =>
      assertCompletedArcAllowsIngest({
        issueNumber: 3918,
        comments: [cancel],
      }),
    ).toThrow(DesignCritiqueIngestBlockedError);
    try {
      assertCompletedArcAllowsIngest({ issueNumber: 3918, comments: [cancel] });
    } catch (error) {
      expect(error).toBeInstanceOf(DesignCritiqueIngestBlockedError);
      expect((error as DesignCritiqueIngestBlockedError).reason).toBe("cancelled");
    }
  });
});
