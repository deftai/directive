/**
 * Ingest of a Spec-path lean whose items continue on indented lines (#7001
 * item 9), on the shape of #6904 lean 7070710091: item 8 carries sub-items
 * (a) to (f) on indented lines.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "../cache/scanner.js";
import { hashHarvestIdentity } from "../design-critique/pain-audit-follow-through-gate.js";
import type { CompletedProcess } from "../scm/call.js";
import { ISSUE_COMMENT_THREAD_KEY, ingestOne } from "./issue-ingest.js";
import { readSpecPathSourceRecord, resolveSpecPathLiveIdentities } from "./spec-path-source.js";

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/lean-6904-7070710091.md"),
  "utf8",
);

const PLAIN =
  "## In plain English\n\nThe problem was a lean ingest could not harvest.\n\n" +
  "The accepted design folds continuation lines into their item.\n\n";
const STOP1 = 7500000001;
const LEAN = 7500000002;
const AUDIT = 7500000003;
const TABLE = 7500000004;
const SYNTHESIS = 7500000005;
const VERIFY_CMD = "npx vitest run packages/core/src/release/ci-reuse.test.ts";
const RUN_CMD = "npx vitest run packages/core/src/release/run-timed-child.test.ts";

/** The #6904 Bound remedy, Acceptance Criteria and Reject sections, under a synthetic lean head. */
function leanBody(slices = ""): string {
  const start = FIXTURE.indexOf("## Bound remedy");
  const reject = FIXTURE.indexOf("## Reject");
  const takes = FIXTURE.indexOf("## Takes");
  const lists = FIXTURE.slice(start, reject).trimEnd();
  return (
    `${PLAIN}**Lean:** bind.\n\nSpec-path: Bound remedy on this lean\n\nrelieves: P1\n\n` +
    `${lists}\n- Verify: \`${VERIFY_CMD}\`\n- The targeted suite passes.\n  Run: \`${RUN_CMD}\`\n\n` +
    slices +
    FIXTURE.slice(reject, takes)
  );
}

function arc(lean: string): { id: number; body: string }[] {
  return [
    {
      id: STOP1,
      body: "role: parent\n\ndesign-critique: warranted, because harvest.\n\npain: P1\n",
    },
    { id: LEAN, body: lean },
    {
      id: AUDIT,
      body:
        "role: critic\n\naudit-targets: pain-P1\nfinding-classes: footnote\nharvest-changed: false\n" +
        `harvest-digest: sha256:${hashHarvestIdentity(lean)}\n`,
    },
    { id: TABLE, body: "## Verified-claims table\n" },
    {
      id: SYNTHESIS,
      body:
        `${PLAIN}design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n` +
        `Bound contract: successor lean ${LEAN}, verified-claims table ${TABLE}.\n`,
    },
  ];
}

function issue(number: number, body: string, thread: { id: number; body: string }[] = []) {
  return {
    number,
    title: `issue ${number}`,
    html_url: `https://github.com/o/r/issues/${number}`,
    body,
    labels: [{ name: "design-critique:ingest-ready" }],
    [ISSUE_COMMENT_THREAD_KEY]: thread,
  };
}

function completed(stdout: string): CompletedProcess {
  return { stdout, stderr: "", returncode: 0 } as CompletedProcess;
}

/** scmCall that serves one parent issue and its comment thread over REST. */
function parentScm(parent: number, thread: { id: number; body: string }[]) {
  return (_source: string, _verb: string, args: readonly string[]): CompletedProcess => {
    const path = args[0] ?? "";
    if (path === `repos/o/r/issues/${parent}`) {
      return completed(
        JSON.stringify({ number: parent, title: "parent", body: "Parent.", labels: [] }),
      );
    }
    if (path.startsWith(`repos/o/r/issues/${parent}/comments`)) {
      return completed(JSON.stringify(thread));
    }
    return completed("[]");
  };
}

function withRoot<T>(fn: (root: string, xbriefDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ingest-7001-"));
  const xbriefDir = join(root, "xbrief");
  mkdirSync(xbriefDir, { recursive: true });
  try {
    return fn(root, xbriefDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ingest(
  root: string,
  xbriefDir: string,
  input: Record<string, unknown>,
  scmCall: (source: string, verb: string, args: readonly string[]) => CompletedProcess = () =>
    completed("[]"),
) {
  return ingestOne(input, {
    vbriefDir: xbriefDir,
    status: "proposed",
    repoUrl: "https://github.com/o/r",
    cwd: root,
    scmCall,
    printIngestAdvisory: false,
  });
}

type Plan = {
  items: { title: string }[];
  acceptance: {
    clauses: { text: string }[];
    sentences: string[];
    admitted_source_sentences: string[];
  };
  metadata: { literal_acceptance_commands?: { command: string }[] };
};

function readPlan(path: string | null): Plan {
  return (JSON.parse(readFileSync(path as string, "utf8")) as { plan: Plan }).plan;
}

/** The live identities verify:ac re-harvests from the lean equal the written sentence identities. */
function expectLiveIdentitiesMatch(plan: Plan, thread: { id: number; body: string }[]): void {
  const record = readSpecPathSourceRecord(plan);
  if (record === null) throw new Error("no Spec-path source record");
  const live = resolveSpecPathLiveIdentities({ comments: thread, record });
  if (!live.ok) throw new Error(live.reason);
  expect(live.identities).toEqual(plan.acceptance.admitted_source_sentences);
  expect(live.identities).toEqual(plan.items.map((item) => item.title));
}

/** Item 8 of the fixture, folded: its first line plus (a) to (f), joined by one space. */
function foldedItem8(): string {
  const start = FIXTURE.indexOf("8. Tests.");
  const end = FIXTURE.indexOf("\n\n## Acceptance Criteria");
  return FIXTURE.slice(start + "8. ".length, end)
    .split("\n")
    .map((line) => line.trim())
    .join(" ");
}

function expectOneFoldedItem(plan: Plan): void {
  const item8 = scan(foldedItem8()).transformed_content;
  const once = (list: readonly string[]) => list.filter((text) => text === item8);
  expect(once(plan.items.map((item) => item.title))).toHaveLength(1);
  expect(once(plan.acceptance.clauses.map((clause) => clause.text))).toHaveLength(1);
  expect(once(plan.acceptance.sentences)).toHaveLength(1);
  expect(once(plan.acceptance.admitted_source_sentences)).toHaveLength(1);
  for (const marker of ["(a)", "(b)", "(c)", "(d)", "(e)", "(f)"]) {
    expect(item8).toContain(` ${marker} `);
  }
}

describe("issue:ingest folds indented continuation lines (#7001 item 9)", () => {
  it("unsliced: writes item 8 as one item, one clause and one sentence identity, and captures commands", () => {
    withRoot((root, xbriefDir) => {
      const thread = arc(leanBody());
      const [result, path] = ingest(root, xbriefDir, issue(7001, "Body prose.", thread));
      expect(result).toBe("created");
      const plan = readPlan(path);
      // 8 Bound remedy items, the 10 #6904 criteria and the 2 command criteria.
      expect(plan.items).toHaveLength(20);
      expectOneFoldedItem(plan);
      expect(plan.items.at(-1)?.title).toBe(
        scan(`The targeted suite passes. Run: \`${RUN_CMD}\``).transformed_content,
      );
      const commands = (plan.metadata.literal_acceptance_commands ?? []).map((row) => row.command);
      expect(commands).toEqual(expect.arrayContaining([VERIFY_CMD, RUN_CMD]));
      expect(readSpecPathSourceRecord(plan)).toMatchObject({ leanCommentId: LEAN, slice: null });
      expectLiveIdentitiesMatch(plan, thread);
    });
  });

  it("sliced: a slice issue takes item 8 folded as one item and captures its stated command", () => {
    withRoot((root, xbriefDir) => {
      const thread = arc(leanBody("## Slices\n- slice-a: B8, A11\n\n"));
      const [result, path] = ingest(
        root,
        xbriefDir,
        issue(7101, "Slice body.\n\ndeft-slice: 7001 slice-a\n"),
        parentScm(7001, thread),
      );
      expect(result).toBe("created");
      const plan = readPlan(path);
      expect(plan.items.map((item) => item.title)).toEqual([
        scan(foldedItem8()).transformed_content,
        scan(`Verify: \`${VERIFY_CMD}\``).transformed_content,
      ]);
      expectOneFoldedItem(plan);
      const commands = (plan.metadata.literal_acceptance_commands ?? []).map((row) => row.command);
      expect(commands).toContain(VERIFY_CMD);
      expect(readSpecPathSourceRecord(plan)).toMatchObject({ issue: 7001, slice: "slice-a" });
      expectLiveIdentitiesMatch(plan, thread);
    });
  });
});
