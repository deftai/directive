import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateCompletedArcRecord,
  evaluateTargetDigestAdmission,
  hashIssueBodyBytes,
  type ThreadComment,
} from "./completed-arc-record.js";
import {
  extractChipCommandArgv,
  formatStaleIngestReadyDiagnostic,
  INGEST_READY_CHIP,
  mechanismShapedChipCommand,
  PAIN_COVERAGE_REQUIREMENT,
} from "./stale-ingest-ready-diagnostic.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "issue-4290-through-5656093589.json");

const LEAN_ID = 5442939496;
const TABLE_ID = 5443106967;
const SYNTHESIS_ID = 5443114746;
const STOP1_ID = 5654639130;

const STANDING = ["bug", "agent-experience", INGEST_READY_CHIP] as const;
const SCANNED_B = "deftai/directive";

type FrozenFixture = {
  readonly repo: string;
  readonly number: number;
  readonly body: string;
  readonly labels: readonly string[];
  readonly inclusiveCommentCeiling: number;
  readonly comments: readonly ThreadComment[];
};

function loadFrozen4290(): FrozenFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FrozenFixture;
}

const table: ThreadComment = {
  id: TABLE_ID,
  body: "## Verified-claims table\n\n| Verified claim | Result |\n",
};

const PE =
  "## In plain English\n\n" +
  "The problem was standing ingest-ready without live clearance.\n\n" +
  "The accepted design maps blocked reasons to recovery diagnostics.\n\n";

const completeLean: ThreadComment = {
  id: LEAN_ID,
  body: `${PE}**Lean:** operator amend of 5442883752. Chips stay convenience.\n`,
};

const completeSynthesis: ThreadComment = {
  id: SYNTHESIS_ID,
  body:
    "model: grok-4.6\nrole: parent\n\n" +
    PE +
    "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
    `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
};

const completeComments: ThreadComment[] = [completeLean, table, completeSynthesis];

function stop1(body: string, id = STOP1_ID): ThreadComment {
  return { id, body };
}

function mapping(input: {
  repo?: string;
  issueNumber?: number;
  labels?: readonly string[];
  comments: readonly ThreadComment[];
}): ReturnType<typeof formatStaleIngestReadyDiagnostic> {
  const issueNumber = input.issueNumber ?? 4290;
  const verdict = evaluateCompletedArcRecord({ comments: input.comments, issueNumber });
  return formatStaleIngestReadyDiagnostic({
    repo: input.repo ?? SCANNED_B,
    issueNumber,
    labels: input.labels ?? STANDING,
    verdict,
  });
}

describe("frozen #4290 snapshot through 5656093589", () => {
  it("evaluates missing-pain and never fetches live GitHub", () => {
    const frozen = loadFrozen4290();
    expect(frozen.inclusiveCommentCeiling).toBe(5656093589);
    expect(frozen.comments[frozen.comments.length - 1]?.id).toBe(5656093589);
    expect(frozen.labels).toContain(INGEST_READY_CHIP);
    const verdict = evaluateCompletedArcRecord({
      comments: frozen.comments,
      issueNumber: frozen.number,
    });
    expect(verdict).toMatchObject({ status: "blocked", reason: "missing-pain" });
  });
});

describe("shared diagnostic mapping", () => {
  it("prints full later-arc recovery and chip command for missing-pain only", () => {
    const frozen = loadFrozen4290();
    const diagnostic = mapping({ comments: frozen.comments, repo: SCANNED_B, issueNumber: 4290 });
    expect(diagnostic.reason).toBe("missing-pain");
    expect(diagnostic.text).toContain(PAIN_COVERAGE_REQUIREMENT);
    expect(diagnostic.text).toContain("new Stop 1");
    expect(diagnostic.text).toContain(mechanismShapedChipCommand(SCANNED_B, 4290));
    expect(diagnostic.text).toContain(`${SCANNED_B}#4290`);
    expect(diagnostic.text).toContain("Standing design-critique:ingest-ready");
    expect(diagnostic.recoveryCommand).toBe(mechanismShapedChipCommand(SCANNED_B, 4290));
    expect(extractChipCommandArgv(diagnostic.text)).toEqual([
      "--repo",
      SCANNED_B,
      "--issue",
      "4290",
      "--chip",
      "mechanism-shaped",
    ]);
  });

  it("sanitizes newlines in the recovery command before the recovery bullet", () => {
    const frozen = loadFrozen4290();
    const repo = "deftai/directive\n--chip evil";
    const diagnostic = mapping({ comments: frozen.comments, repo, issueNumber: 4290 });
    const bullet = diagnostic.text.split("\n").find((line) => line.includes("Operator-directed:"));
    const sanitized =
      "task scm:issue:design-critique-chip -- --repo deftai/directive --chip evil --issue 4290 --chip mechanism-shaped";
    expect(diagnostic.recoveryCommand).toBe(sanitized);
    expect(bullet).toBe(`2. Operator-directed: ${sanitized}`);
    expect(extractChipCommandArgv(diagnostic.text)).toBeNull();
  });

  it("keeps evaluator detail for malformed-pain without a chip command or restart", () => {
    const warrant = stop1(
      "role: parent\n\ndesign-critique: warranted, because x.\n\npain: P1\npain: P1\n",
    );
    const diagnostic = mapping({
      comments: [warrant, completeLean, table, completeSynthesis],
    });
    expect(diagnostic.reason).toBe("malformed-pain");
    expect(diagnostic.text).toContain(PAIN_COVERAGE_REQUIREMENT);
    expect(diagnostic.text).toContain("malformed-pain");
    expect(diagnostic.recoveryCommand).toBeNull();
    expect(extractChipCommandArgv(diagnostic.text)).toBeNull();
    expect(diagnostic.text).not.toContain("new Stop 1");
    expect(diagnostic.text).not.toContain("mechanism-shaped");
  });

  it("keeps evaluator detail for lean-side malformed-pain without a restart", () => {
    const warrant = stop1("role: parent\n\ndesign-critique: warranted, because x.\n\npain: P1\n");
    const unknown: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** cites a ghost.\n\nrelieves: P9\n",
    };
    const diagnostic = mapping({ comments: [warrant, unknown, table, completeSynthesis] });
    expect(diagnostic.reason).toBe("malformed-pain");
    expect(diagnostic.text).toContain(PAIN_COVERAGE_REQUIREMENT);
    expect(extractChipCommandArgv(diagnostic.text)).toBeNull();
    expect(diagnostic.text).not.toContain("new Stop 1");
  });

  it("prints #4496 for unrelieved-pain without a chip command", () => {
    const warrant = stop1("role: parent\n\ndesign-critique: warranted, because x.\n\npain: P1\n");
    const leftover: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** forbids only.\n\ndoes-not-relieve: P1\n",
    };
    const diagnostic = mapping({ comments: [warrant, leftover, table, completeSynthesis] });
    expect(diagnostic.reason).toBe("unrelieved-pain");
    expect(diagnostic.text).toContain(PAIN_COVERAGE_REQUIREMENT);
    expect(extractChipCommandArgv(diagnostic.text)).toBeNull();
    expect(diagnostic.text).not.toContain("new Stop 1");
  });

  it("prints #4496 for unresolved-pain-audit without a chip command", () => {
    const warrant = stop1("role: parent\n\ndesign-critique: warranted, because x.\n\npain: P1\n");
    const covered: ThreadComment = {
      id: LEAN_ID,
      body: "**Lean:** bind relief.\n\nrelieves: P1\n",
    };
    const diagnostic = mapping({ comments: [warrant, covered, table, completeSynthesis] });
    expect(diagnostic.reason).toBe("unresolved-pain-audit");
    expect(diagnostic.text).toContain(PAIN_COVERAGE_REQUIREMENT);
    expect(extractChipCommandArgv(diagnostic.text)).toBeNull();
  });

  it("omits #4496 for cancelled, later-arc-in-flight, not-in-arc, and missing-record", () => {
    const cancelled: ThreadComment = {
      id: SYNTHESIS_ID + 10,
      body: "role: parent\n\ndesign-critique: cancelled, because portfolio member is dominated\n",
    };
    const cancelDiag = mapping({ comments: [completeLean, table, completeSynthesis, cancelled] });
    expect(cancelDiag.reason).toBe("cancelled");
    expect(cancelDiag.text).not.toContain("#4496");
    expect(extractChipCommandArgv(cancelDiag.text)).toBeNull();

    const laterCritic: ThreadComment = {
      id: SYNTHESIS_ID + 1,
      body: "role: critic\n\n## Finding 1\n",
    };
    const inFlight = mapping({ comments: [...completeComments, laterCritic] });
    expect(inFlight.reason).toBe("later-arc-in-flight");
    expect(inFlight.text).not.toContain("#4496");
    expect(extractChipCommandArgv(inFlight.text)).toBeNull();

    const empty = mapping({ comments: [] });
    expect(empty.reason).toBe("not-in-arc");
    expect(empty.text).not.toContain("#4496");
    expect(empty.text).toContain("does not establish a completed record");

    const missing = mapping({
      comments: [{ id: 1, body: "role: critic\n\n## Finding 1\n" }],
    });
    expect(missing.reason).toBe("missing-record");
    expect(missing.text).not.toContain("#4496");
  });

  it("reports exact-byte stale-target and a trailing-newline diagnostic only", () => {
    const body = "issue body bytes";
    const digest = hashIssueBodyBytes(body);
    const newlineDigest = hashIssueBodyBytes(`${body}\n`);
    const cited = `**Lean:** pin.\n\nTarget-digest: sha256:${newlineDigest}\n`;
    const admission = evaluateTargetDigestAdmission({
      citedLeanBody: cited,
      liveIssueBody: body,
    });
    expect(admission).toMatchObject({ status: "blocked", reason: "stale-target" });
    const diagnostic = formatStaleIngestReadyDiagnostic({
      repo: SCANNED_B,
      issueNumber: 4290,
      labels: STANDING,
      verdict: {
        status: "complete",
        synthesisCommentId: SYNTHESIS_ID,
        citedLeanId: LEAN_ID,
        citedTableId: TABLE_ID,
      },
      digestAdmission: admission,
      liveIssueBody: body,
      citedLeanBody: cited,
    });
    expect(diagnostic.reason).toBe("stale-target");
    expect(diagnostic.text).toContain("Exact-byte Target-digest mismatch");
    expect(diagnostic.text).toContain("trailing-newline diagnostic only");
    expect(diagnostic.text).toContain("does not assert body drift");
    expect(diagnostic.text).not.toContain("#4496");
    expect(extractChipCommandArgv(diagnostic.text)).toBeNull();
    expect(digest).not.toBe(newlineDigest);
  });

  it("identifies unknown fetch failures and never calls them stale or complete", () => {
    const diagnostic = formatStaleIngestReadyDiagnostic({
      repo: SCANNED_B,
      issueNumber: 4290,
      labels: STANDING,
      verdict: { status: "unknown", detail: "page 2 failed: HTTP 502" },
    });
    expect(diagnostic.kind).toBe("unknown");
    expect(diagnostic.reason).toBe("unknown");
    expect(diagnostic.text).toContain("unknown");
    expect(diagnostic.text).not.toContain("stale-target");
    expect(diagnostic.text).not.toContain(": complete");
    expect(extractChipCommandArgv(diagnostic.text)).toBeNull();
  });
});

describe("missing-pain later-arc recovery through to complete", () => {
  it("reaches complete without editing the frozen Stop 1", () => {
    const frozen = loadFrozen4290();
    const oldStop1 = frozen.comments.find((comment) =>
      /design-critique:\s*warranted/i.test(comment.body),
    );
    expect(oldStop1).toBeDefined();
    const newStop1: ThreadComment = {
      id: 9000000001,
      body: "role: parent\n\ndesign-critique: warranted, because later-arc pain coverage.\n\npain: P1\n",
    };
    const newLean: ThreadComment = {
      id: 9000000002,
      body: `${PE}**Lean:** later-arc relief.\n\nrelieves: P1\n`,
    };
    const critic: ThreadComment = {
      id: 9000000003,
      body:
        "role: critic\n\naudit-targets: pain-P1\n" +
        "finding-classes: none\nharvest-changed: false\n",
    };
    const synthesis: ThreadComment = {
      id: 9000000004,
      body:
        "model: grok-4.6\nrole: parent\n\n" +
        PE +
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        "Bound contract: successor lean 9000000002.\n",
    };
    const recovered = [...frozen.comments, newStop1, newLean, critic, synthesis];
    expect(recovered.find((comment) => comment.id === oldStop1?.id)?.body).toBe(oldStop1?.body);
    expect(evaluateCompletedArcRecord({ comments: recovered, issueNumber: 4290 })).toMatchObject({
      status: "complete",
      citedLeanId: 9000000002,
    });
  });
});
