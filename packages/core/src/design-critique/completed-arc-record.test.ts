import { describe, expect, it } from "vitest";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import {
  applyIngestReadyRemainingSet,
  assertCompletedArcAllowsIngest,
  COMPLETED_ARC_BLOCK_REASONS,
  DesignCritiqueIngestBlockedError,
  evaluateCompletedArcRecord,
  evaluateTargetDigestAdmission,
  extractCitedCommentIds,
  extractOperativeTargetDigest,
  hashIssueBodyBytes,
  isInFlightCritiqueThread,
  type ThreadComment,
} from "./completed-arc-record.js";

const LEAN_ID = 5442939496;
const TABLE_ID = 5443106967;
const SYNTHESIS_ID = 5443114746;
const CRITIC_ID = 5442800000;

const PLAIN_ENGLISH_SUMMARY =
  "## In plain English\n\n" +
  "The problem was missing machine clearance for ordinary-language summaries.\n\n" +
  "The accepted design adds a presence-only gate on the cited lean and synthesis.\n\n";

function withPlainEnglish(body: string, summary = PLAIN_ENGLISH_SUMMARY): string {
  if (/(?:^|\n)##\s+In plain English\b/i.test(body)) return body;
  return `${summary}${body}`;
}

/** Fixture adapter: ensure lean/synthesis-shaped bodies carry ## In plain English (#5415). */
function evalArc(
  input: Parameters<typeof evaluateCompletedArcRecord>[0],
): ReturnType<typeof evaluateCompletedArcRecord> {
  return evaluateCompletedArcRecord({
    ...input,
    comments: input.comments.map((comment) => ({
      ...comment,
      body: withPlainEnglish(comment.body),
    })),
  });
}

function assertArc(
  input: Parameters<typeof assertCompletedArcAllowsIngest>[0],
): ReturnType<typeof assertCompletedArcAllowsIngest> {
  return assertCompletedArcAllowsIngest({
    ...input,
    comments: input.comments.map((comment) => ({
      ...comment,
      body: withPlainEnglish(comment.body),
    })),
  });
}

const lean: ThreadComment = {
  id: LEAN_ID,
  body: withPlainEnglish("**Lean:** operator amend of 5442883752. Chips stay convenience.\n"),
};

const table: ThreadComment = {
  id: TABLE_ID,
  body: "## Verified-claims table\n\n| Verified claim | Result |\n",
};

const synthesis: ThreadComment = {
  id: SYNTHESIS_ID,
  body: withPlainEnglish(
    "model: grok-4.6\nrole: parent\n\n" +
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
  ),
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
    expect(evalArc({ labels: ["bug"], comments: [] })).toEqual({
      status: "not-in-arc",
    });
  });

  it("completes when synthesis cites the accepted lean and table", () => {
    const verdict = evalArc({
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

  it("does not treat leftover mechanism-shaped or ingest-ready as clearance", () => {
    const missing = evalArc({
      labels: ["design-critique:ingest-ready"],
      comments: [{ id: 1, body: "role: critic\n\n## Finding 1\n" }],
    });
    expect(missing).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("catalog chip alone with zero thread evidence is not-in-arc (#4298)", () => {
    for (const chip of [
      "design-critique:mechanism-shaped",
      "design-critique:in-progress",
      "design-critique:ingest-ready",
      "design-critique:triage-ready",
      "design-critique:recut-needed",
    ]) {
      const verdict = evalArc({
        labels: [chip],
        comments: [],
      });
      expect(verdict, chip).toEqual({ status: "not-in-arc" });
    }
  });

  it("blocks a lone synthesis-accepted sentence that does not cite a lean", () => {
    const lone: ThreadComment = {
      id: SYNTHESIS_ID,
      body: "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n",
    };
    const verdict = evalArc({
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
    const verdict = evalArc({
      comments: [critic, shaped],
    });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "cite-not-lean",
    });
  });

  it("ignores author_association and GitHub login", () => {
    const verdict = evalArc({
      labels: ["design-critique:mechanism-shaped"],
      comments: [lean, table, synthesis],
    });
    expect(verdict.status).toBe("complete");
  });

  it("does not require the triage-ready chip once the record is present", () => {
    const verdict = evalArc({
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
    const verdict = evalArc({
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
    const verdict = evalArc({ comments: [lean, shaped] });
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
    const verdict = evalArc({
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
    const verdict = evalArc({ comments: [critic] });
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
    const verdict = evalArc({
      comments: [lean, table, synthesis, lone],
    });
    expect(verdict.status).toBe("complete");
    if (verdict.status === "complete") {
      expect(verdict.synthesisCommentId).toBe(SYNTHESIS_ID);
    }
  });

  it("still treats a panel-deposit with families as in-flight evidence (#4067)", () => {
    const deposit: ThreadComment = {
      id: CRITIC_ID - 1,
      body: "model: grok-4.6\nrole: parent\n\npanel-deposit\nround: 1\nsiblings: 3\ninput-ceiling: 5390001612\nfamilies: grok, claude, codex\n",
    };
    const verdict = evalArc({ comments: [deposit] });
    expect(verdict).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("blocks a chipless panel-deposit before any critic posts", () => {
    const deposit: ThreadComment = {
      id: CRITIC_ID - 1,
      body: "model: grok-4.6\nrole: parent\n\npanel-deposit\nround: 1\nsiblings: 3\ninput-ceiling: 5390001612\n",
    };
    const verdict = evalArc({ comments: [deposit] });
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
    const verdict = evalArc({
      comments: [lean, table, synthesis, recutLean, incomplete],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "lone-shape" });
  });

  it("blocks a recut lean with no new synthesis yet", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "**Lean:** recut of 5442939496. New takes.\n",
    };
    const verdict = evalArc({
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
    const verdict = evalArc({
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
    expect(evalArc({ comments: [lean, table, houseStyle] })).toEqual({
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
    expect(evalArc({ comments: [lean, table, bolded] })).toEqual({
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
    expect(evalArc({ comments: [lean, table, permalink] })).toEqual({
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
    const verdict = evalArc({
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
      expect(evalArc({ comments: [lean, table, shaped] }), label).toEqual({
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
        evalArc({
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
    const verdict = evalArc({
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
      const verdict = evalArc({
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
    const verdict = evalArc({
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
    const verdict = evalArc({ comments: [lean, bare] });
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
    const verdict = evalArc({ comments: [lean, noisy] });
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
    const verdict = evalArc({ comments: [critic, shaped] });
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
      const verdict = evalArc({ comments: order });
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
    const verdict = evalArc({
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
    expect(evalArc({ comments: [critic, older, newer] })).toMatchObject({
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
    expect(evalArc({ comments: [newerLean, lean, record] })).toMatchObject({
      status: "complete",
      citedLeanId: newerLean.id,
    });
  });

  it("recognises a panel-deposit from its fields when the literal token is absent", () => {
    const deposit: ThreadComment = {
      id: CRITIC_ID,
      body: "model: grok-4.6\nrole: parent\n\nround: 1\nsiblings: 3\ninput-ceiling: 5390001612\n",
    };
    expect(evalArc({ comments: [deposit] })).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("leaves a thread with neither deposit fields nor a critic post out of the arc", () => {
    const chatter: ThreadComment = { id: CRITIC_ID, body: "role: parent\n\nsiblings: 3\n" };
    expect(evalArc({ comments: [chatter] })).toEqual({ status: "not-in-arc" });
  });

  it("names the accepted forms when the record is missing entirely", () => {
    const verdict = evalArc({
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
      assertArc({
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
    const verdict = assertArc({
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
    const verdict = evalArc({
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
      const verdict = evalArc({ comments: [lean, table, record(cite)] });
      expect(verdict, label).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
      expect(verdict, label).not.toHaveProperty("citedTableId");
      if (verdict.status === "blocked") {
        expect(verdict.detail, label).toContain(String(GHOST_TABLE_ID));
      }
    }
  });

  it("refuses two typed claims that name different tables", () => {
    const verdict = evalArc({
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
    const verdict = evalArc({
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
    const verdict = evalArc({
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
      expect(evalArc({ comments: [lean, table, record(cite)] }), label).toEqual({
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
    const verdict = evalArc({
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
    const verdict = evalArc({
      comments: [lean, headinglessTable, typedRecord(GHOST_TABLE_ID)],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-table-cite" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(GHOST_TABLE_ID));
      expect(verdict.detail).not.toContain("add that heading to the cited comment");
    }
  });

  it("gives the two states different reasons and details that differ by more than the id", () => {
    const onThread = evalArc({
      comments: [lean, headinglessTable, typedRecord(TABLE_ID)],
    });
    const offThread = evalArc({
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
    const verdict = evalArc({
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
      expect(evalArc({ comments: [lean, headinglessTable, record] }), label).toEqual({
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
      assertArc({
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
      expect(evalArc({ comments: [lean, live, typedRecord(id)] }), String(id)).toEqual({
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
    expect(evalArc({ comments: [dominatePointer] })).toEqual({
      status: "not-in-arc",
    });
  });

  it("keeps leftover mechanism-shaped without cancel as missing-record", () => {
    expect(
      evalArc({
        labels: ["design-critique:mechanism-shaped"],
        comments: [leftoverCritic],
      }),
    ).toMatchObject({ status: "blocked", reason: "missing-record" });
  });

  it("treats cancel as terminal refuse even with leftover critic", () => {
    const verdict = evalArc({
      labels: ["design-critique:mechanism-shaped"],
      comments: [leftoverCritic, cancel],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "cancelled" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(cancel.id));
    }
  });

  it("ignores a critic quoting cancelled after a complete record", () => {
    const criticCancel: ThreadComment = {
      id: SYNTHESIS_ID + 3,
      body:
        "model: grok-4.5\nrole: critic\n\n" +
        "design-critique: cancelled, because this is an example of the refuse line\n",
    };
    const verdict = evalArc({
      labels: ["design-critique:triage-ready"],
      comments: [lean, table, synthesis, criticCancel],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "later-arc-in-flight" });
    expect(verdict).not.toMatchObject({ reason: "cancelled" });
  });

  it("ignores a fenced cancelled example on a parent comment", () => {
    const fencedCancel: ThreadComment = {
      id: SYNTHESIS_ID + 4,
      body:
        "model: grok-4.6\nrole: parent\n\n" +
        "```\ndesign-critique: cancelled, because example\n```\n",
    };
    expect(
      evalArc({
        labels: ["design-critique:triage-ready"],
        comments: [lean, table, synthesis, fencedCancel],
      }),
    ).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("does not treat halt as cancel", () => {
    const halted: ThreadComment = {
      id: 5499000002,
      body: "model: grok-4.6\nrole: parent\n\ndesign-critique: halted, because same-fingerprint\n",
    };
    expect(evalArc({ comments: [halted] })).toEqual({
      status: "not-in-arc",
    });
  });

  it("refuses a complete set-level anchor as set-level-body", () => {
    const verdict = evalArc({
      labels: ["design-critique:triage-ready"],
      comments: [setLevelCharter, lean, table, synthesis],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "set-level-body" });
  });

  it("does not let a Spec-path Bound-remedy list bypass set-level-body", () => {
    const specPathLean: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** next-build is not this body.\n\nSpec-path:\n\n## Bound remedy\n\n1. leftover story\n",
    };
    expect(
      evalArc({
        labels: ["design-critique:ingest-ready"],
        comments: [setLevelCharter, specPathLean, table, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "set-level-body" });
  });

  it("lets a later non-set-level target shape clear set-level-body", () => {
    expect(
      evalArc({
        labels: ["design-critique:triage-ready"],
        comments: [setLevelCharter, lean, table, synthesis, recutShape],
      }),
    ).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("still completes a single-issue bound record", () => {
    expect(
      evalArc({
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
      evalArc({
        comments: [leftoverCritic, cancel, recutLean],
      }),
    ).toMatchObject({ status: "blocked", reason: "missing-record" });
  });

  it("completes a recut single-issue arc after cancel", () => {
    expect(
      evalArc({
        comments: [leftoverCritic, cancel, recutShape, recutLean, recutSynthesis],
      }),
    ).toEqual({
      status: "complete",
      synthesisCommentId: recutSynthesis.id,
      citedLeanId: recutLean.id,
      citedTableId: null,
    });
  });

  it("ignores a fenced target-shape example on a parent comment", () => {
    const fenced: ThreadComment = {
      id: SYNTHESIS_ID + 1,
      body: "model: grok-4.6\nrole: parent\n\n```\ntarget shape: single issue premise\n```\n",
    };
    expect(
      evalArc({
        labels: ["design-critique:triage-ready"],
        comments: [setLevelCharter, lean, table, synthesis, fenced],
      }),
    ).toMatchObject({ status: "blocked", reason: "set-level-body" });
  });

  it("ignores a critic quoting target shape", () => {
    const criticQuote: ThreadComment = {
      id: SYNTHESIS_ID + 2,
      body: "model: grok-4.5\nrole: critic\n\ntarget shape: single issue premise\n",
    };
    expect(
      evalArc({
        labels: ["design-critique:triage-ready"],
        comments: [setLevelCharter, lean, table, synthesis, criticQuote],
      }),
    ).toMatchObject({ status: "blocked", reason: "set-level-body" });
  });

  it("does not complete a post-cancel synthesis that cites the superseded lean", () => {
    const staleSynthesis: ThreadComment = {
      id: 5499000400,
      body:
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `successor lean ${LEAN_ID}\n`,
    };
    expect(
      evalArc({
        comments: [lean, table, synthesis, leftoverCritic, cancel, recutLean, staleSynthesis],
      }),
    ).toMatchObject({ status: "blocked" });
  });

  it("throws cancelled through the ingest assertion", () => {
    expect(() =>
      assertArc({
        issueNumber: 3918,
        comments: [cancel],
      }),
    ).toThrow(DesignCritiqueIngestBlockedError);
    try {
      assertArc({ issueNumber: 3918, comments: [cancel] });
    } catch (error) {
      expect(error).toBeInstanceOf(DesignCritiqueIngestBlockedError);
      expect((error as DesignCritiqueIngestBlockedError).reason).toBe("cancelled");
    }
  });
});

describe("Target-digest admission (#4243)", () => {
  const restBody = "## Summary\n\nNo trailing newline";
  const digest = hashIssueBodyBytes(restBody);

  it("leaves a legacy lean without a digest unpinned", () => {
    expect(
      evaluateTargetDigestAdmission({ citedLeanBody: lean.body, liveIssueBody: restBody }),
    ).toEqual({ status: "unpinned" });
  });

  it("matches the live REST body bytes and refuses a trailing-newline loader", () => {
    const cited = `**Lean:** pin.\n\nTarget-digest: sha256:${digest}\n`;
    expect(extractOperativeTargetDigest(cited)).toBe(digest);
    expect(
      evaluateTargetDigestAdmission({ citedLeanBody: cited, liveIssueBody: restBody }),
    ).toEqual({
      status: "match",
      digest,
    });
    const loader = `${restBody}\n`;
    expect(hashIssueBodyBytes(loader)).not.toBe(digest);
    expect(
      evaluateTargetDigestAdmission({ citedLeanBody: cited, liveIssueBody: loader }),
    ).toMatchObject({ status: "blocked", reason: "stale-target" });
  });

  it("refuses whitespace, checkbox, and CRLF edits after the pin", () => {
    const cited = `**Lean:** pin.\n\nTarget-digest: sha256:${digest}\n`;
    for (const edited of [`${restBody} `, `${restBody}\r\n`, `${restBody}\n- [x] done`]) {
      expect(
        evaluateTargetDigestAdmission({ citedLeanBody: cited, liveIssueBody: edited }),
        JSON.stringify(edited),
      ).toMatchObject({ status: "blocked", reason: "stale-target" });
    }
  });

  it("does not treat a title as part of the digest", () => {
    expect(hashIssueBodyBytes(restBody)).toBe(digest);
  });

  it("refuses a digest value with trailing text after the 64 hex digits", () => {
    const cited = `**Lean:** pin.\n\nTarget-digest: sha256:${digest} trailing-text\n`;
    expect(extractOperativeTargetDigest(cited)).toBeNull();
    expect(
      evaluateTargetDigestAdmission({ citedLeanBody: cited, liveIssueBody: restBody }),
    ).toMatchObject({ status: "blocked", reason: "stale-target" });
  });
});

describe("applyIngestReadyRemainingSet Target-digest admission (#4995)", () => {
  class FakeLabelClient implements LabelClient {
    labels: string[];
    applyCalls: Array<{ add: readonly string[]; remove: readonly string[] }> = [];

    constructor(labels: string[]) {
      this.labels = [...labels];
    }

    fetchLabels(_repo: string, _issueNumber: number): string[] {
      return [...this.labels];
    }

    apply(
      _repo: string,
      _issueNumber: number,
      add: readonly string[],
      remove: readonly string[],
    ): void {
      this.applyCalls.push({ add: [...add], remove: [...remove] });
      const next = new Set(this.labels);
      for (const name of remove) next.delete(name);
      for (const name of add) next.add(name);
      this.labels = [...next];
    }
  }

  const completeThread = (leanBody: string): ThreadComment[] => [
    { id: LEAN_ID, body: withPlainEnglish(leanBody) },
    table,
    synthesis,
  ];

  it("frozen mismatch fixture reports stale-target with zero writes", () => {
    const liveBody = "## Summary\n\nNo trailing newline";
    const pinned = hashIssueBodyBytes(`${liveBody}\n`);
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped"]);
    const result = applyIngestReadyRemainingSet(
      client,
      "deftai/directive",
      4988,
      completeThread(`**Lean:** pin.\n\nTarget-digest: sha256:${pinned}\n`),
      liveBody,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.verdict).toMatchObject({ status: "blocked", reason: "stale-target" });
      expect(result.digestAdmission).toMatchObject({ status: "blocked", reason: "stale-target" });
    }
    expect(client.applyCalls).toHaveLength(0);
  });

  it("exact match permits the ready transition", () => {
    const liveBody = "## Summary\n\nExact match body";
    const digest = hashIssueBodyBytes(liveBody);
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped"]);
    const result = applyIngestReadyRemainingSet(
      client,
      "deftai/directive",
      4995,
      completeThread(`**Lean:** pin.\n\nTarget-digest: sha256:${digest}\n`),
      liveBody,
    );
    expect(result.ok).toBe(true);
    expect(client.applyCalls).toHaveLength(1);
  });

  it("unpinned complete record still writes (preserve #4243 / #4700)", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = applyIngestReadyRemainingSet(
      client,
      "deftai/directive",
      3637,
      completeThread("**Lean:** legacy unpinned.\n"),
      "## any body",
    );
    expect(result.ok).toBe(true);
    expect(client.applyCalls).toHaveLength(1);
  });

  it("refuses ingest-ready remaining-set when cited lean lacks plain English (#5415)", () => {
    const client = new FakeLabelClient(["bug"]);
    const leanBare: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** no summary on this lean.\n",
    };
    const result = applyIngestReadyRemainingSet(
      client,
      "deftai/directive",
      5415,
      [leanBare, table, synthesis],
      "## any body",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.verdict).toMatchObject({
        status: "blocked",
        reason: "missing-plain-english",
      });
    }
    expect(client.applyCalls).toHaveLength(0);
  });
});

describe("pain coverage (#4496)", () => {
  const STOP1_ID = 5654639130;
  const LEAN_4378 = 5654755223;
  const TABLE_4378 = 5654759568;
  const SYNTHESIS_4378 = 5654759686;

  const table4378: ThreadComment = {
    id: TABLE_4378,
    body: "## Verified-claims table\n\n| # | Claim | Method | Status |\n",
  };

  const synthesis4378: ThreadComment = {
    id: SYNTHESIS_4378,
    body:
      "model: grok-4.6\nrole: parent\n\n" +
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      `Citing successor lean ${LEAN_4378} and verified-claims table ${TABLE_4378}.\n`,
  };

  const leftoverLean: ThreadComment = {
    id: LEAN_4378,
    body:
      "**Lean:** take map over round 1 panel.\n\nSpec-path:\n\n## Bound remedy\n\n" +
      "1. Personal always-wins stays operator-authored.\n" +
      "2. Reuse existing step protocol.\n" +
      "3. Version-stamp bug: use the live version source.\n",
  };

  function stop1(body: string, id = STOP1_ID): ThreadComment {
    return { id, body };
  }

  it("still completes a record with no Stop 1 write-back", () => {
    expect(evalArc({ comments: [lean, table, synthesis] })).toMatchObject({
      status: "complete",
    });
  });

  it("fails closed when Stop 1 is missing pain:", () => {
    const warrant = stop1(
      "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: warranted, because USER.md onboarding is still a chat loop.\n",
    );
    const verdict = evalArc({
      issueNumber: 4378,
      comments: [warrant, leftoverLean, table4378, synthesis4378],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-pain" });
    expect(() =>
      assertArc({
        issueNumber: 4378,
        comments: [warrant, leftoverLean, table4378, synthesis4378],
      }),
    ).toThrow(DesignCritiqueIngestBlockedError);
  });

  it("refuses the annotated #4378 leftover Bound-remedy window", () => {
    const warrant = stop1(
      "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: warranted, because USER.md onboarding is still a chat loop.\n\n" +
        "pain: P1\npain: P2\npain: P3\npain: P4\n",
    );
    const verdict = evalArc({
      issueNumber: 4378,
      labels: ["design-critique:ingest-ready"],
      comments: [warrant, leftoverLean, table4378, synthesis4378],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("P1");
      expect(verdict.detail).toContain("P4");
    }
  });

  it("does not restore recut-needed as a block reason", () => {
    expect(evalArc({ comments: [lean, table, synthesis] }).status).toBe("complete");
    expect(COMPLETED_ARC_BLOCK_REASONS).not.toContain("recut-needed");
    expect(COMPLETED_ARC_BLOCK_REASONS).not.toContain("reframe-needed");
  });

  it("completes when every named pain is cited as relieves", () => {
    const warrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because coverage gap.\n\npain: P1\npain: P2\n",
    );
    const covered: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** bind relief.\n\nrelieves: P1\nrelieves: P2\n",
    };
    expect(
      evalArc({
        issueNumber: 4496,
        comments: [warrant, covered, table, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "unresolved-pain-audit" });
    const critic: ThreadComment = {
      id: LEAN_ID + 1,
      body:
        "role: critic\n\naudit-targets: pain-P1 pain-P2\n" +
        "finding-classes: none\nharvest-changed: false\n",
    };
    expect(
      evalArc({
        issueNumber: 4496,
        comments: [warrant, covered, table, critic, synthesis],
      }),
    ).toMatchObject({
      status: "complete",
      citedLeanId: LEAN_ID,
    });
  });

  it("does not let a path-1 empty-disagreement line complete while residual holds", () => {
    const warrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because leftover warrant.\n\npain: P1\n",
    );
    const leanResidual: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** forbids only.\n\ndoes-not-relieve: P1\n",
    };
    expect(
      evalArc({
        issueNumber: 4496,
        comments: [warrant, leanResidual, table, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
  });

  it("treats same-number operator-deferred as leftover, not ingest clearance", () => {
    const warrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because leftover warrant.\n\npain: P1\n",
    );
    const deferredSame: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** defer on this number.\n\noperator-deferred: P1 #4496\n",
    };
    expect(
      evalArc({
        issueNumber: 4496,
        comments: [warrant, deferredSame, table, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
  });

  it("keeps operator-deferred to a different issue unresolved until a critic targets it", () => {
    const warrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because leftover warrant.\n\npain: P1\n",
    );
    const deferredOther: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** later slice.\n\noperator-deferred: P1 #4377\n",
    };
    expect(
      evalArc({
        issueNumber: 4496,
        comments: [warrant, deferredOther, table, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "unresolved-pain-audit" });

    const staleCritic: ThreadComment = {
      id: CRITIC_ID,
      body: "role: critic\n\naudit-targets: pain-P1\n",
    };
    expect(
      evalArc({
        issueNumber: 4496,
        comments: [warrant, deferredOther, table, staleCritic, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "unresolved-pain-audit" });
    const critic: ThreadComment = {
      id: LEAN_ID + 1,
      body:
        "role: critic\n\naudit-targets: pain-P1\n" +
        "finding-classes: none\nharvest-changed: false\n",
    };
    expect(
      evalArc({
        issueNumber: 4496,
        comments: [warrant, deferredOther, table, critic, synthesis],
      }),
    ).toMatchObject({ status: "complete" });
  });

  it("fails closed on duplicate and unknown pain ids", () => {
    const dup = stop1(
      "role: parent\n\ndesign-critique: warranted, because x.\n\npain: P1\npain: P1\n",
    );
    expect(
      evalArc({
        comments: [dup, leftoverLean, table4378, synthesis4378],
      }),
    ).toMatchObject({ status: "blocked", reason: "malformed-pain" });

    const warrant = stop1("role: parent\n\ndesign-critique: warranted, because x.\n\npain: P1\n");
    const unknown: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** cites a ghost.\n\nrelieves: P9\n",
    };
    expect(
      evalArc({
        comments: [warrant, unknown, table, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "malformed-pain" });
  });

  it("does not let a quoted Stop 1 pain list create the denominator", () => {
    const warrant = stop1("role: parent\n\ndesign-critique: warranted, because x.\n\n> pain: P1\n");
    expect(
      evalArc({
        comments: [warrant, leftoverLean, table4378, synthesis4378],
      }),
    ).toMatchObject({ status: "blocked", reason: "missing-pain" });
  });

  it("does not let a quoted relieves cite discharge residual", () => {
    const warrant = stop1("role: parent\n\ndesign-critique: warranted, because x.\n\npain: P1\n");
    const quoted: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** example only.\n\n> relieves: P1\n",
    };
    expect(
      evalArc({
        comments: [warrant, quoted, table, synthesis],
      }),
    ).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
  });

  it("takes a later Stop 1 as the superseding warrant", () => {
    const oldWarrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because old.\n\npain: P1\n",
      STOP1_ID,
    );
    const newWarrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because recut warrant.\n\npain: P2\n",
      STOP1_ID + 1,
    );
    const covered: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** relieves the new denominator.\n\nrelieves: P2\n",
    };
    const critic: ThreadComment = {
      id: LEAN_ID + 1,
      body:
        "role: critic\n\naudit-targets: pain-P2\n" +
        "finding-classes: none\nharvest-changed: false\n",
    };
    expect(
      evalArc({
        comments: [oldWarrant, newWarrant, covered, table, critic, synthesis],
      }),
    ).toMatchObject({ status: "complete" });
  });

  it("refuses a malformed pain: prose line", () => {
    const warrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because x.\n\npain: prose P1\n",
    );
    expect(
      evalArc({
        comments: [warrant, leftoverLean, table4378, synthesis4378],
      }),
    ).toMatchObject({ status: "blocked", reason: "malformed-pain" });
  });
});

describe("later-arc suffix in-flight after matching complete record (#4590)", () => {
  const stop1P1: ThreadComment = {
    id: 5442800001,
    body:
      "model: grok-4.6\nrole: triage\n\n" +
      "design-critique: warranted, because later-arc gap.\n\npain: P1\n",
  };
  const standingLean: ThreadComment = {
    id: LEAN_ID,
    body:
      "**Lean:** standing map.\n\nSpec-path:\n\n## Bound remedy\n\n" +
      "1. refuse later-arc ingest.\n\nrelieves: P1\n",
  };
  const painAuditCritic: ThreadComment = {
    id: LEAN_ID + 1,
    body:
      "model: grok-4.6\nrole: critic\n\naudit-targets: pain-P1\n" +
      "finding-classes: none\nharvest-changed: false\n",
  };
  const bound = [lean, table, synthesis];
  const boundWithPain = [stop1P1, standingLean, table, painAuditCritic, synthesis];
  const laterMechanism: ThreadComment = {
    id: SYNTHESIS_ID + 10,
    body: "model: grok-4.6\nrole: triage\n\nmechanism-shaped: true\n",
  };
  const laterDeposit: ThreadComment = {
    id: SYNTHESIS_ID + 20,
    body: "model: grok-4.6\nrole: parent\n\npanel-deposit\nround: 1\nsiblings: 3\ninput-ceiling: 5390001612\n",
  };
  const laterCritic: ThreadComment = {
    id: SYNTHESIS_ID + 30,
    body: "model: grok-4.6\nrole: critic\n\n## Finding 1\nlater-arc finding\n",
  };

  function suffixAfter(originId: number, comments: readonly ThreadComment[]): ThreadComment[] {
    return comments.filter((comment) => comment.id > originId);
  }

  it("keeps bound-only complete; whole-thread in-flight is not the close", () => {
    expect(isInFlightCritiqueThread(bound)).toBe(true);
    expect(isInFlightCritiqueThread(suffixAfter(SYNTHESIS_ID, bound))).toBe(false);
    expect(evalArc({ comments: bound })).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: TABLE_ID,
    });
  });

  it("does not treat a first-arc pain-audit critic as suffix (origin is synthesisCommentId)", () => {
    expect(isInFlightCritiqueThread(suffixAfter(LEAN_ID, boundWithPain))).toBe(true);
    expect(isInFlightCritiqueThread(suffixAfter(SYNTHESIS_ID, boundWithPain))).toBe(false);
    expect(evalArc({ comments: boundWithPain, issueNumber: 4590 })).toMatchObject({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
    });
  });

  it("refuses later mechanism-shaped: true while the bound lean still stands", () => {
    const comments = [...bound, laterMechanism];
    expect(isInFlightCritiqueThread(suffixAfter(SYNTHESIS_ID, comments))).toBe(true);
    expect(evalArc({ comments })).toMatchObject({
      status: "blocked",
      reason: "later-arc-in-flight",
    });
  });

  it("refuses a later panel-deposit", () => {
    const comments = [...bound, laterMechanism, laterDeposit];
    expect(evalArc({ comments })).toMatchObject({
      status: "blocked",
      reason: "later-arc-in-flight",
    });
  });

  it("refuses a later role: critic", () => {
    const comments = [...bound, laterMechanism, laterDeposit, laterCritic];
    const verdict = evalArc({ comments });
    expect(verdict).toMatchObject({ status: "blocked", reason: "later-arc-in-flight" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(SYNTHESIS_ID));
      expect(verdict.detail).toContain("later-arc completion");
      expect(verdict.detail).not.toContain("cite the latest");
    }
  });

  it("refuses a later critic with no new Stop 1", () => {
    const comments = [...bound, laterCritic];
    expect(evalArc({ comments })).toMatchObject({
      status: "blocked",
      reason: "later-arc-in-flight",
    });
  });

  it("keeps malformed-pain when a later Stop 1 names new pain P2", () => {
    const laterStop1: ThreadComment = {
      id: SYNTHESIS_ID + 11,
      body:
        "model: grok-4.6\nrole: triage\n\n" +
        "design-critique: warranted, because later-arc P2.\n\npain: P2\n",
    };
    const comments = [...boundWithPain, laterStop1, laterDeposit, laterCritic];
    expect(evalArc({ comments, issueNumber: 4590 })).toMatchObject({
      status: "blocked",
      reason: "malformed-pain",
    });
  });

  it("keeps missing-pain when a later Stop 1 has no pain list", () => {
    const laterStop1: ThreadComment = {
      id: SYNTHESIS_ID + 11,
      body:
        "model: grok-4.6\nrole: triage\n\n" +
        "design-critique: warranted, because later-arc with no pain list.\n",
    };
    const comments = [...boundWithPain, laterStop1];
    expect(evalArc({ comments, issueNumber: 4590 })).toMatchObject({
      status: "blocked",
      reason: "missing-pain",
    });
  });

  it("still refuses after a second same-lean synthesis (earliest origin, not latest)", () => {
    const laterSynthesis: ThreadComment = {
      id: SYNTHESIS_ID + 40,
      body:
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
    };
    const comments = [...bound, laterMechanism, laterDeposit, laterCritic, laterSynthesis];
    expect(isInFlightCritiqueThread(suffixAfter(laterSynthesis.id, comments))).toBe(false);
    expect(isInFlightCritiqueThread(suffixAfter(SYNTHESIS_ID, comments))).toBe(true);
    const verdict = evalArc({ comments });
    expect(verdict).toMatchObject({ status: "blocked", reason: "later-arc-in-flight" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(String(SYNTHESIS_ID));
      expect(verdict.detail).not.toContain(String(laterSynthesis.id));
    }
  });

  it("completes rebound with a new successor-lean heading plus a citing record", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 50,
      body: "**Lean:** later-arc recut of the standing map.\n",
    };
    const recutSynthesis: ThreadComment = {
      id: SYNTHESIS_ID + 60,
      body:
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `successor lean ${recutLean.id}\n`,
    };
    const comments = [
      ...bound,
      laterMechanism,
      laterDeposit,
      laterCritic,
      recutLean,
      recutSynthesis,
    ];
    expect(isInFlightCritiqueThread(suffixAfter(recutSynthesis.id, comments))).toBe(false);
    expect(evalArc({ comments })).toEqual({
      status: "complete",
      synthesisCommentId: recutSynthesis.id,
      citedLeanId: recutLean.id,
      citedTableId: null,
    });
  });

  it("keeps missing-record for a recut lean with no new citing record", () => {
    const recutLean: ThreadComment = {
      id: SYNTHESIS_ID + 50,
      body: "**Lean:** later-arc recut of the standing map.\n",
    };
    const comments = [...bound, recutLean];
    expect(evalArc({ comments })).toMatchObject({
      status: "blocked",
      reason: "missing-record",
    });
  });

  it("does not widen isInFlightCritiqueThread for later warranted without mechanism-shaped", () => {
    const laterWarrant: ThreadComment = {
      id: SYNTHESIS_ID + 12,
      body:
        "model: grok-4.6\nrole: triage\n\n" +
        "design-critique: warranted, because leftover warrant.\n\npain: P1\n",
    };
    const comments = [...boundWithPain, laterWarrant];
    expect(isInFlightCritiqueThread(suffixAfter(SYNTHESIS_ID, comments))).toBe(false);
    expect(evalArc({ comments, issueNumber: 4590 })).toMatchObject({
      status: "complete",
      citedLeanId: LEAN_ID,
    });
  });

  it("throws later-arc-in-flight through the ingest assertion", () => {
    const comments = [...bound, laterCritic];
    expect(() => assertArc({ issueNumber: 4590, comments })).toThrow(
      DesignCritiqueIngestBlockedError,
    );
    try {
      assertArc({ issueNumber: 4590, comments });
    } catch (error) {
      expect(error).toBeInstanceOf(DesignCritiqueIngestBlockedError);
      expect((error as DesignCritiqueIngestBlockedError).reason).toBe("later-arc-in-flight");
    }
  });

  it("publishes later-arc-in-flight and does not merge it into missing-record", () => {
    expect(COMPLETED_ARC_BLOCK_REASONS).toContain("later-arc-in-flight");
    expect(COMPLETED_ARC_BLOCK_REASONS).toContain("missing-record");
    const comments = [...bound, laterMechanism];
    expect(evalArc({ comments })).toMatchObject({
      reason: "later-arc-in-flight",
    });
    expect(evalArc({ comments })).not.toMatchObject({
      reason: "missing-record",
    });
  });
});

describe("plain-English presence on cited lean + synthesis (#5415)", () => {
  const summary =
    "## In plain English\n\n" +
    "The problem was missing ordinary-language summaries at ingest-ready.\n\n" +
    "The accepted design adds a presence-only gate on the cited artifacts.\n\n";

  const leanOk: ThreadComment = {
    id: LEAN_ID,
    body: `${summary}**Lean:** Prefer-A Bound for presence gate.\n`,
  };

  const synthOk = (id: number, leanId: number, includeSummary = true): ThreadComment => ({
    id,
    body:
      (includeSummary ? summary : "") +
      "model: grok-4.6\nrole: parent\n\n" +
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      `Bound contract: successor lean ${leanId}.\n`,
  });

  it("publishes missing-plain-english as a closed reason", () => {
    expect(COMPLETED_ARC_BLOCK_REASONS).toContain("missing-plain-english");
  });

  it("completes when both cited lean and synthesis carry operative non-empty summaries", () => {
    expect(
      evaluateCompletedArcRecord({
        comments: [leanOk, synthOk(SYNTHESIS_ID, LEAN_ID)],
      }),
    ).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: null,
    });
  });

  it("blocks when the cited lean lacks the heading and names lean resolution", () => {
    const leanBare: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** Prefer-A Bound without summary.\n",
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [leanBare, synthOk(SYNTHESIS_ID, LEAN_ID)],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-plain-english" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(`cited lean ${String(LEAN_ID)}`);
      expect(verdict.detail).toContain("Lean: token matched");
      expect(verdict.detail).not.toContain("synthesis");
    }
  });

  it("blocks when the synthesis lacks the heading", () => {
    const verdict = evaluateCompletedArcRecord({
      comments: [leanOk, synthOk(SYNTHESIS_ID, LEAN_ID, false)],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-plain-english" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(`synthesis ${String(SYNTHESIS_ID)}`);
      expect(verdict.detail).not.toContain("cited lean");
    }
  });

  it("blocks a trim-empty slice (bare heading then Lean:)", () => {
    const leanEmpty: ThreadComment = {
      id: LEAN_ID,
      body: "## In plain English\n\n**Lean:** Prefer-A Bound.\n",
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [leanEmpty, synthOk(SYNTHESIS_ID, LEAN_ID)],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-plain-english" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("empty body slice");
    }
  });

  it("blocks metadata-only slices (model:/role: are not a summary)", () => {
    const synthMetaOnly: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "## In plain English\n\n" +
        "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `Bound contract: successor lean ${String(LEAN_ID)}.\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      comments: [leanOk, synthMetaOnly],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-plain-english" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(`synthesis ${String(SYNTHESIS_ID)}`);
      expect(verdict.detail).toContain("empty body slice");
    }
  });

  it("keeps ordinary-language Role:/Model: prose as a non-empty summary", () => {
    const synthProseRole: ThreadComment = {
      id: SYNTHESIS_ID,
      body:
        "## In plain English\n\n" +
        "Role: the operator confirms the accepted design.\n\n" +
        "design-critique: synthesis accepted, because agents agreed\n\n" +
        `Bound contract: successor lean ${String(LEAN_ID)}.\n`,
    };
    expect(
      evaluateCompletedArcRecord({
        comments: [leanOk, synthProseRole],
      }),
    ).toEqual({
      status: "complete",
      synthesisCommentId: SYNTHESIS_ID,
      citedLeanId: LEAN_ID,
      citedTableId: null,
    });
  });

  it("rejects prefix near-miss and fenced headings as non-operative", () => {
    const leanPrefix: ThreadComment = {
      id: LEAN_ID,
      body: "## In plain Englishness\n\nNot the token.\n\n**Lean:** Prefer-A Bound.\n",
    };
    expect(
      evaluateCompletedArcRecord({
        comments: [leanPrefix, synthOk(SYNTHESIS_ID, LEAN_ID)],
      }),
    ).toMatchObject({ status: "blocked", reason: "missing-plain-english" });

    const leanFenced: ThreadComment = {
      id: LEAN_ID,
      body: "```\n## In plain English\n\nFenced only.\n```\n\n**Lean:** Prefer-A Bound.\n",
    };
    expect(
      evaluateCompletedArcRecord({
        comments: [leanFenced, synthOk(SYNTHESIS_ID, LEAN_ID)],
      }),
    ).toMatchObject({ status: "blocked", reason: "missing-plain-english" });
  });

  it("selects the newer synthesis and blocks when that newer one lacks the summary", () => {
    const older = synthOk(SYNTHESIS_ID, LEAN_ID, true);
    const newerMissing = synthOk(SYNTHESIS_ID + 10, LEAN_ID, false);
    const verdict = evaluateCompletedArcRecord({
      comments: [leanOk, older, newerMissing],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-plain-english" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain(`synthesis ${String(SYNTHESIS_ID + 10)}`);
      expect(verdict.detail).not.toContain(`synthesis ${String(SYNTHESIS_ID)} lacks`);
    }
  });

  it("does not mask an earlier pain reason with missing-plain-english", () => {
    const stop1: ThreadComment = {
      id: 5600000001,
      body:
        "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: warranted, because order honesty.\n\npain: P1\n",
    };
    const leanUncited: ThreadComment = {
      id: LEAN_ID,
      body: `${summary}**Lean:** Prefer-A Bound.\n\nSpec-path: next-build.\n`,
    };
    const verdict = evaluateCompletedArcRecord({
      issueNumber: 5415,
      comments: [stop1, leanUncited, synthOk(SYNTHESIS_ID, LEAN_ID)],
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "unrelieved-pain" });
  });

  it("pins the first operative heading when duplicates appear", () => {
    const leanDup: ThreadComment = {
      id: LEAN_ID,
      body:
        "## In plain English\n\nFirst summary wins.\n\n" +
        "## In plain English\n\nSecond heading is after the slice end.\n\n" +
        "**Lean:** Prefer-A Bound.\n",
    };
    expect(
      evaluateCompletedArcRecord({
        comments: [leanDup, synthOk(SYNTHESIS_ID, LEAN_ID)],
      }),
    ).toMatchObject({ status: "complete", citedLeanId: LEAN_ID });
  });
});
