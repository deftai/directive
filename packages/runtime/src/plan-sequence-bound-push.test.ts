/**
 * #6205 clause.17: a disposable consumer fixture with the bound pre-push gate
 * enrolled (`requireBoundPrePrPush: true`). Completing a story admits the
 * next story's push; an unplanned fix push is refused before an approved
 * insert and admitted after it. Every push goes through the real pre-PR
 * controller (plan_sequence phase observed from `verify:plan-sequence`) and
 * the real pre-push gate. The approval grant is minted through the core mint
 * seam, never a terminal mint.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPlanSequenceApprovalGrant } from "@deftai/directive-core/plan-sequence";
import {
  completeRun,
  computeControllerObservedHash,
  controllerPublisher,
  digestApprovedCriteria,
  FileBackedPrePrStore,
  observeCommandPhase,
  PRE_PR_PHASES,
  resetDefaultPrePrStore,
  setDefaultPrePrStore,
  startControllerRun,
  submitReviewerReport,
} from "@deftai/directive-core/pre-pr-controller";
import { evaluatePrePush, parsePrePushStdin } from "@deftai/directive-core/preflight";
import { runTransition } from "@deftai/directive-core/scope";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as planSequenceMain } from "./plan-sequence.js";
import { main as verifyPlanSequenceMain } from "./verify-plan-sequence.js";

const ZERO = "0000000000000000000000000000000000000000";
const bases: string[] = [];

afterEach(() => {
  resetDefaultPrePrStore();
  vi.restoreAllMocks();
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function write(root: string, rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function quiet<T>(fn: () => T): T {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return fn();
  } finally {
    vi.restoreAllMocks();
  }
}

/** Consumer clone with a bare origin, the bound gate enrolled and a two-story plan. */
function consumerFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "ps-bound-push-"));
  bases.push(base);
  const bare = join(base, "origin.git");
  const root = join(base, "consumer");
  mkdirSync(bare);
  mkdirSync(root);
  git(bare, ["init", "-q", "--bare", "-b", "master"]);
  git(root, ["init", "-q", "-b", "master"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["remote", "add", "origin", bare]);
  write(
    root,
    "xbrief/PROJECT-DEFINITION.xbrief.json",
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "consumer",
        status: "running",
        "x-directive/policy": { requireBoundPrePrPush: true },
      },
    }),
  );
  write(root, ".gitignore", ".deft/\n");
  write(root, "src/base.ts", "export const base = 1;\n");
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    write(root, `xbrief/${folder}/.keep`, "");
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  git(root, ["push", "-q", "-u", "origin", "master"]);
  const plan = JSON.stringify({
    sequence_id: "consumer-plan",
    sequence_kind: "delivery",
    authorized_by: "operator",
    entries: [
      { id: "101", kind: "issue", issue: 101 },
      { id: "102", kind: "issue", issue: 102 },
    ],
  });
  expect(
    quiet(() =>
      planSequenceMain([
        "set",
        "--project-root",
        root,
        "--from-json",
        plan,
        "--expected-generation",
        "0",
      ]),
    ),
  ).toBe(0);
  return root;
}

/** Feature branch from origin/master with one product file committed. */
function featureCommit(root: string, branch: string, rel: string): string {
  git(root, ["checkout", "-q", "-B", branch, "origin/master"]);
  write(root, rel, `export const value = "${branch}";\n`);
  git(root, ["add", rel]);
  git(root, ["commit", "-q", "-m", branch]);
  return git(root, ["rev-parse", "HEAD"]);
}

/**
 * One real pre-PR controller run whose plan_sequence phase is the observed
 * exit code of `verify:plan-sequence`, then the real pre-push gate.
 */
function prePrThenPush(
  root: string,
  branch: string,
  rel: string,
  target: string,
): { planExit: number; controller: boolean; push: number; pushMessage: string } {
  const store = new FileBackedPrePrStore(root);
  setDefaultPrePrStore(store);
  const head = git(root, ["rev-parse", "HEAD"]);
  const base = git(root, ["merge-base", head, "origin/master"]);
  const criteria = digestApprovedCriteria({
    sourceRevisionSha: base,
    scopePaths: [rel],
    acceptanceText: "fixture",
    generation: 1,
  });
  const runId = `ppr_${branch.replace(/[^a-z0-9]/gi, "_")}_${head.slice(0, 8)}`;
  const started = startControllerRun(store, {
    repo: "acme/app",
    baseSha: base,
    headSha: head,
    treeHash: git(root, ["rev-parse", "HEAD^{tree}"]),
    prBodyHash: "body",
    prNodeId: null,
    criteria,
    skillVersion: "0.1",
    policyVersion: "1",
    approvedRevisionSha: base,
    runId,
  });
  expect(started.ok).toBe(true);
  const record = store.getById(runId);
  if (record === null) throw new Error("run not stored");
  const planExit = quiet(() =>
    verifyPlanSequenceMain(["--project-root", root, "--target-kind", "issue", "--target", target]),
  );
  const observed = computeControllerObservedHash({ reviewedFiles: [rel], cwd: root }) ?? "";
  for (const spec of PRE_PR_PHASES) {
    if (!spec.required) continue;
    if (spec.kind === "command-observable") {
      observeCommandPhase(
        store,
        runId,
        {
          phaseId: spec.id,
          command: spec.command ?? "",
          exitCode: spec.id === "plan_sequence" ? planExit : 0,
          inputHash: record.inputHash,
          skipReason: null,
          // #6336: lint_iteration records both CI gate results.
          ...(spec.id === "lint_iteration"
            ? {
                gateChecks: [
                  { gate: "verify:class-checks" as const, exitCode: 0, message: "clean" },
                  { gate: "verify:evaluator-surface" as const, exitCode: 0, message: "skip" },
                ],
              }
            : {}),
        },
        { projectRoot: root },
      );
    } else {
      submitReviewerReport(store, runId, {
        phaseId: spec.id,
        reviewedFileManifest: [rel],
        suppliedContentsHash: observed,
        criteriaDigest: criteria.digest,
        reviewerReportRef: "fixture",
        controllerObservedHash: observed,
      });
    }
  }
  const completed = completeRun(store, controllerPublisher(), runId, undefined, {
    projectRoot: root,
    skipNamedMergeGate: true,
    // #6888: completeRun requires the controller-owned verify:ac result; no-target keeps
    // this fixture's binding as before (no disposition).
    verifyAcResult: { kind: "no-target", output: "" },
  });
  const stdin = `refs/heads/${branch} ${head} refs/heads/${branch} ${ZERO}\n`;
  const [push, pushMessage] = evaluatePrePush(parsePrePushStdin(stdin), {
    projectRoot: root,
    enrolledBoundPrePr: true,
    rawStdin: stdin,
  });
  return { planExit, controller: completed.ok, push, pushMessage };
}

describe("bound pre-push consumer fixture (#6205 clause.17)", () => {
  it("complete admits the next story; an unplanned fix is refused until an approved insert", () => {
    const root = consumerFixture();

    // Story 101 is current; its push is admitted.
    featureCommit(root, "story-101", "src/story101.ts");
    expect(prePrThenPush(root, "story-101", "src/story101.ts", "101")).toMatchObject({
      planExit: 0,
      controller: true,
      push: 0,
    });

    // The next story's push is refused while 101 is still open.
    featureCommit(root, "story-102", "src/story102.ts");
    const early = prePrThenPush(root, "story-102", "src/story102.ts", "102");
    expect(early.planExit).toBe(1);
    expect(early.controller).toBe(false);
    expect(early.push).toBe(1);
    expect(early.pushMessage).toContain("no completed pre-PR pass bound to this HEAD");

    // scope:complete on story 101 moves the plan on (one named line).
    git(root, ["checkout", "-q", "master"]);
    write(
      root,
      "xbrief/active/2026-11-16-101-story.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Story 101",
          status: "running",
          items: [],
          references: [
            { uri: "https://github.com/acme/app/issues/101", type: "x-xbrief/github-issue" },
          ],
        },
      }),
    );
    // Offline fixture: no forge, so the completion records a non-delivery disposition.
    const completed = runTransition(
      "complete",
      join(root, "xbrief/active/2026-11-16-101-story.xbrief.json"),
      undefined,
      { nonDeliveryDisposition: "accepted_not_delivered" },
    );
    expect(completed.ok, completed.message).toBe(true);
    expect(completed.message).toContain("plan-sequence: advanced (current issue:102 index=1");

    // The next story's push is now admitted.
    git(root, ["checkout", "-q", "story-102"]);
    expect(prePrThenPush(root, "story-102", "src/story102.ts", "102")).toMatchObject({
      planExit: 0,
      controller: true,
      push: 0,
    });

    // An unplanned fix is refused before insert.
    featureCommit(root, "fix-900", "src/fix900.ts");
    const refused = prePrThenPush(root, "fix-900", "src/fix900.ts", "900");
    expect(refused).toMatchObject({ planExit: 1, controller: false, push: 1 });

    // Insert without approval is refused under the bound gate.
    const insertArgv = [
      "insert",
      "--project-root",
      root,
      "--kind",
      "issue",
      "--id",
      "900",
      "--issue",
      "900",
      "--repo",
      "acme/app",
      "--expected-generation",
      "2",
    ];
    expect(quiet(() => planSequenceMain(insertArgv))).toBe(1);

    // The operator approves the insert (core mint seam), and the fix is admitted.
    const minted = mintPlanSequenceApprovalGrant({
      projectRoot: root,
      target: "insert:issue:900",
      sequenceId: "consumer-plan",
      generation: 2,
      position: 1,
      issue: 900,
      repo: "acme/app",
    });
    expect(minted.ok).toBe(true);
    expect(quiet(() => planSequenceMain(insertArgv))).toBe(0);
    expect(prePrThenPush(root, "fix-900", "src/fix900.ts", "900")).toMatchObject({
      planExit: 0,
      controller: true,
      push: 0,
    });
  });
});
