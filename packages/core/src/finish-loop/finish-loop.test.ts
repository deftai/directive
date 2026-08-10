/**
 * Unit tests for finish-loop grant gate, progress, queue, and loops (#871).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintHumanOriginGrant } from "../authz/actions.js";
import {
  FINISH_LOOP_OPERATIONS,
  mintFinishLoopTemplateGrant,
  resolveFinishLoopTemplate,
} from "../authz/templates.js";
import { EXIT_CLEAN, EXIT_NEW_P0_P1 } from "../pr-watch/constants.js";
import type { WatchResult } from "../pr-watch/types.js";
import { runDirectiveFinishLoop } from "./directive-finish-loop.js";
import { evaluateFinishLoopGrant, grantCoversFinishLoopOps } from "./grant-gate.js";
import { runPrFinishLoop } from "./pr-finish-loop.js";
import { appendFinishLoopProgress, finishLoopProgressPath, makeProgressLine } from "./progress.js";
import { scanFinishLoopQueue } from "./queue.js";
import { EXIT_ACTION_REQUIRED, EXIT_BLOCKED, EXIT_OK } from "./types.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "finish-loop-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function cleanWatch(pr: number): WatchResult {
  return {
    prNumber: pr,
    verdict: "CLEAN",
    exitCode: EXIT_CLEAN,
    elapsedSeconds: 1,
    pollCount: 1,
    probe: {
      found: true,
      headSha: "abc",
      lastReviewedSha: "abc",
      shaMatch: true,
      confidence: 5,
      p0Count: 0,
      p1Count: 0,
      hasBlocking: false,
      errored: false,
      ciFailures: 0,
      ciFailedChecks: [],
      ciReadyState: "success",
      ciCapacityStalledChecks: [],
      terminalCheckRun: true,
      isClean: true,
      cleanGateHoldout: null,
      error: null,
    },
  };
}

function p0Watch(pr: number): WatchResult {
  return {
    ...cleanWatch(pr),
    verdict: "NEW_P0_P1",
    exitCode: EXIT_NEW_P0_P1,
    probe: {
      ...cleanWatch(pr).probe,
      p0Count: 1,
      hasBlocking: true,
      isClean: false,
      cleanGateHoldout: "p0",
    },
  };
}

describe("finish-loop template mint (#871)", () => {
  it("resolveFinishLoopTemplate covers edit/push/pr/merge with 8h default", () => {
    const r = resolveFinishLoopTemplate({
      now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(r.operations).toEqual([...FINISH_LOOP_OPERATIONS]);
    expect(r.surfaces).toEqual([]);
    expect(r.expiresAt).toBe("2026-07-30T08:00:00Z");
    expect(r.template).toBe("finish-loop");
  });

  it("mintFinishLoopTemplateGrant is operator-cli and excludes release ops", () => {
    const root = tmpRoot();
    const g = mintFinishLoopTemplateGrant({
      projectRoot: root,
      actor: "scott",
      now: new Date("2026-07-30T12:00:00Z"),
    });
    expect(g.origin.kind).toBe("operator-cli");
    expect(g.scope.operations).toEqual(["edit", "push", "pr", "merge"]);
    expect(g.scope.operations).not.toContain("release-publish");
    expect(g.origin.eventRef).toBe("template:finish-loop");
    expect(grantCoversFinishLoopOps(g).covered).toBe(true);
  });

  it("agent-authored grant never authorizes finish-loop", () => {
    const root = tmpRoot();
    const human = mintFinishLoopTemplateGrant({ projectRoot: root });
    // Forge agent-origin file by overwriting origin after mint is not possible
    // via public API — mint a partial grant and pass synthetic.
    const agentGrant = {
      ...human,
      origin: {
        kind: "agent-authored",
        actor: "bot",
        mintedAt: human.origin.mintedAt,
        mintedVia: "self",
        eventRef: null,
      },
    };
    const d = evaluateFinishLoopGrant({
      projectRoot: root,
      grants: [agentGrant],
      now: new Date("2026-07-30T12:00:00Z"),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-grant-origin-reject");
  });
});

describe("evaluateFinishLoopGrant", () => {
  it("fails closed without grants", () => {
    const root = tmpRoot();
    const d = evaluateFinishLoopGrant({ projectRoot: root });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-grant-missing");
    expect(d.reason).toMatch(/authz:grant.*finish-loop/);
  });

  it("allows when finish-loop template grant present", () => {
    const root = tmpRoot();
    const g = mintFinishLoopTemplateGrant({ projectRoot: root });
    const d = evaluateFinishLoopGrant({ projectRoot: root });
    expect(d.allowed).toBe(true);
    expect(d.grantId).toBe(g.id);
  });

  it("rejects partial ops grant for full set", () => {
    const root = tmpRoot();
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit", "push"],
      actor: "op",
    });
    const d = evaluateFinishLoopGrant({ projectRoot: root });
    expect(d.allowed).toBe(false);
    expect(d.missingOps).toEqual(expect.arrayContaining(["pr", "merge"]));
  });

  it("env bypass DEFT_ALLOW_FINISH_LOOP=1", () => {
    const root = tmpRoot();
    const d = evaluateFinishLoopGrant({
      projectRoot: root,
      env: { DEFT_ALLOW_FINISH_LOOP: "1" },
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("finish-loop-env-bypass");
  });

  it("expired grant fails closed", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({
      projectRoot: root,
      expiresAt: "2020-01-01T00:00:00Z",
    });
    const d = evaluateFinishLoopGrant({
      projectRoot: root,
      now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-grant-expired");
  });
});

describe("progress log", () => {
  it("appends finish-loop-progress.jsonl", () => {
    const root = tmpRoot();
    const path = appendFinishLoopProgress(
      root,
      makeProgressLine({
        phase: "gate",
        iteration: 1,
        haltReason: null,
        message: "hello",
        prNumber: null,
        grantId: "g1",
        queueCount: 0,
        exitCode: 0,
      }),
    );
    expect(path).toBe(finishLoopProgressPath(root));
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"schemaVersion":1');
    expect(text).toContain("hello");
  });
});

describe("scanFinishLoopQueue", () => {
  it("lists active and pending xbrief stories", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "a.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "pending", "b.xbrief.json"), "{}");
    writeFileSync(join(root, "xbrief", "active", "PROJECT-DEFINITION.xbrief.json"), "{}");
    const q = scanFinishLoopQueue(root);
    expect(q.map((e) => e.name).sort()).toEqual(["a.xbrief.json", "b.xbrief.json"]);
  });

  it("empty when no lifecycle folders", () => {
    const root = tmpRoot();
    expect(scanFinishLoopQueue(root)).toEqual([]);
  });
});

describe("runPrFinishLoop", () => {
  it("BLOCKED without grant", () => {
    const root = tmpRoot();
    const r = runPrFinishLoop({
      projectRoot: root,
      prNumber: 1,
      watchFn: () => cleanWatch(1),
      writeProgress: true,
    });
    expect(r.exitCode).toBe(EXIT_BLOCKED);
    expect(r.haltReason).toBe("grant-missing");
    expect(readFileSync(finishLoopProgressPath(root), "utf8")).toMatch(/BLOCKED/);
  });

  it("CLEAN via injected watch when granted", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({ projectRoot: root });
    const r = runPrFinishLoop({
      projectRoot: root,
      prNumber: 42,
      watchFn: () => cleanWatch(42),
      fetchPrHeadShaFn: () => "abc",
      writeProgress: false,
    });
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.haltReason).toBe("clean");
    expect(r.watchVerdict).toBe("CLEAN");
  });

  it("NEW_P0_P1 returns ACTION_REQUIRED", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({ projectRoot: root });
    const r = runPrFinishLoop({
      projectRoot: root,
      prNumber: 7,
      watchFn: () => p0Watch(7),
      writeProgress: false,
    });
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED);
    expect(r.haltReason).toBe("address-findings");
  });

  it("requireHumanMerge blocks bot merge after CLEAN", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({ projectRoot: root });
    const r = runPrFinishLoop({
      projectRoot: root,
      prNumber: 9,
      merge: true,
      watchFn: () => cleanWatch(9),
      fetchPrHeadShaFn: () => "abc",
      agentMergeFn: () => ({
        exitCode: 1 as const,
        allowed: false,
        message: "requireHumanMerge is true",
        policy: {
          requireHumanMerge: true,
          source: "typed",
          error: null,
          deprecationWarning: null,
          autoDeployOnMerge: false,
        },
      }),
      writeProgress: false,
    });
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED);
    expect(r.haltReason).toBe("require-human-merge");
    expect(r.mergeAttempted).toBe(false);
  });

  it("stale merge approval after CLEAN fails closed and disables auto-merge path (#3235)", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({ projectRoot: root });
    let disableSeen = false;
    const r = runPrFinishLoop({
      projectRoot: root,
      prNumber: 525,
      merge: true,
      watchFn: () => cleanWatch(525),
      fetchPrHeadShaFn: () => "abc",
      mergeApprovalHeadFn: (input) => {
        expect(input.currentHeadSha).toBe("abc");
        disableSeen = true;
        return {
          status: "stale",
          allowed: false,
          approved_head_sha: "727ab9306ef3b179eee94f6d6df5aef178ae18aa",
          current_head_sha: "abc",
          pr_number: 525,
          require_human_merge: true,
          auto_merge_disabled: true,
          message: "stale approval #3235",
          recovery: "re-approve with --head-sha abc",
        };
      },
      writeProgress: false,
    });
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED);
    expect(r.haltReason).toBe("stale-merge-approval");
    expect(r.mergeSkippedReason).toBe("stale-merge-approval");
    expect(r.mergeAttempted).toBe(false);
    expect(r.message).toContain("#3235");
    expect(disableSeen).toBe(true);
  });

  it("merge succeeds when policy allows and mergeFn returns 0", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({ projectRoot: root });
    let pinned: string | null | undefined;
    const r = runPrFinishLoop({
      projectRoot: root,
      prNumber: 3,
      merge: true,
      watchFn: () => cleanWatch(3),
      agentMergeFn: () => ({
        exitCode: 0 as const,
        allowed: true,
        message: "ok",
        policy: {
          requireHumanMerge: false,
          source: "env-bypass",
          error: null,
          deprecationWarning: null,
          autoDeployOnMerge: false,
        },
      }),
      fetchPrHeadShaFn: () => "abc",
      mergeFn: (_pr, _repo, opts) => {
        pinned = opts?.matchHeadCommit;
        return 0;
      },
      writeProgress: false,
    });
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.haltReason).toBe("merged");
    expect(r.mergeAttempted).toBe(true);
    expect(pinned).toBe("abc");
  });
});

describe("runDirectiveFinishLoop", () => {
  it("BLOCKED without grant", () => {
    const root = tmpRoot();
    const r = runDirectiveFinishLoop({ projectRoot: root, writeProgress: false });
    expect(r.exitCode).toBe(EXIT_BLOCKED);
    expect(r.haltReason).toBe("grant-missing");
  });

  it("empty queue → OK and progress line", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({ projectRoot: root });
    const r = runDirectiveFinishLoop({ projectRoot: root, writeProgress: true });
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.haltReason).toBe("empty-queue");
    expect(r.queueCount).toBe(0);
    const text = readFileSync(r.progressPath, "utf8");
    expect(text).toMatch(/empty-queue|empty scope queue/);
  });

  it("non-empty queue → AGENT_STEP", () => {
    const root = tmpRoot();
    mintFinishLoopTemplateGrant({ projectRoot: root });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "story.xbrief.json"), "{}");
    const r = runDirectiveFinishLoop({ projectRoot: root, writeProgress: false });
    expect(r.exitCode).toBe(EXIT_ACTION_REQUIRED);
    expect(r.haltReason).toBe("agent-implement");
    expect(r.queueCount).toBe(1);
    expect(r.message).toMatch(/AGENT_STEP/);
  });

  it("env bypass + empty queue works without grant files", () => {
    const root = tmpRoot();
    const r = runDirectiveFinishLoop({
      projectRoot: root,
      env: { DEFT_ALLOW_FINISH_LOOP: "1" },
      writeProgress: false,
    });
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.haltReason).toBe("empty-queue");
  });
});
