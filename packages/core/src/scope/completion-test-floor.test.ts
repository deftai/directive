/**
 * #7047: the scope:complete walk runs the project's declared test command as a
 * transient floor where the #4870 zero-verified refusal would fire on a
 * clause-bearing brief with no effective acceptance command. Each test names
 * the clause it covers.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCOPE_COMPLETE_ZERO_VERIFIED_NOTICE } from "../check/rapid-zero-verified.js";
import { resolveDeclaredTestCommand } from "../consumer-test-lane/evaluate.js";
import type { LiteralAcceptanceCommand } from "../literal-acceptance/types.js";
import {
  evaluateVerifyAcFromPath,
  evaluateVerifyAcFromPlan,
} from "../product-first-done-gate/evaluate.js";
import { ENV_RUN_SUMMARY_PATH } from "../run-summary/index.js";
import {
  DECLARED_TEST_FLOOR_NONE,
  evaluateScopeCompleteAcceptanceWalk,
} from "./acceptance-evidence.js";

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function tempRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "completion-floor-"));
  bases.push(base);
  return base;
}

/** A root whose package.json declares `scripts.test` (npm: no lockfile). */
function rootWithScriptsTest(): string {
  const root = tempRoot();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "floor-fixture", scripts: { test: "vitest run" } }),
  );
  return root;
}

/** A root whose PROJECT-DEFINITION declares `plan.policy.testCommand`. */
function rootWithPolicyTestCommand(testCommand: unknown): string {
  const root = tempRoot();
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { policy: { testCommand } } }),
  );
  return root;
}

const proseClauses = [
  { id: 1, text: "the floor runs where the refusal fired", artifact_path: null, ambiguous: false },
  { id: 2, text: "the refusal names the grant command", artifact_path: null, ambiguous: false },
];

function clausePlan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "github.issue.7047",
    title: "clause-bearing brief with no commands",
    acceptance: {
      commands: [],
      none_stated: true,
      source_rung: "derived",
      ambiguity_attestation: "none_found",
      clauses: proseClauses,
    },
    metadata: { swarm: { file_scope: ["src/a.ts"] } },
    items: [],
    ...extra,
  };
}

interface Recorder {
  readonly commands: string[];
  readonly runner: (input: { readonly command: string; readonly cwd: string }) => {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
}

function recorder(exitCode = 0, stdout = "", stderr = ""): Recorder {
  const commands: string[] = [];
  return {
    commands,
    runner: (input) => {
      commands.push(input.command);
      return { exitCode, stdout, stderr };
    },
  };
}

function walkOptions(projectRoot: string, runner: Recorder["runner"]) {
  return {
    projectRoot,
    captureFromNarratives: false,
    hasSuiteFloor: true,
    bankOnPass: false,
    reuseMode: "never" as const,
    runner,
    // scope:complete passes the consumer test lane's resolver (transition.ts).
    resolveDeclaredTestCommand,
  };
}

describe("completion test floor (#7047)", () => {
  it("clauses 3, 4 and 7: a green declared test command completes through the ordinary walk and writes nothing to the brief", () => {
    const root = rootWithScriptsTest();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const briefPath = join(root, "xbrief", "active", "story.xbrief.json");
    const plan = clausePlan();
    writeFileSync(briefPath, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2));
    const before = readFileSync(briefPath, "utf8");
    const snapshot = JSON.stringify(plan);
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, {
      ...walkOptions(root, rec.runner),
      xbriefPath: briefPath,
    });
    expect(walk.ok).toBe(true);
    expect(walk.predicate).toBe("executable-pass");
    expect(rec.commands).toEqual(["npm test"]);
    expect(walk.message).toContain("declared test command passed");
    expect(walk.message).toContain("`npm test`");
    expect(walk.message).toContain("source package.json scripts.test");
    expect(walk.message).toContain(`cwd ${root}`);
    expect(walk.message).not.toMatch(/clauses verified/);
    expect(readFileSync(briefPath, "utf8")).toBe(before);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("clause 2: plan.policy.testCommand wins over scripts.test and keeps its argv split", () => {
    const root = rootWithPolicyTestCommand(["pnpm", "exec", "vitest", "run"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(clausePlan(), walkOptions(root, rec.runner));
    expect(walk.ok).toBe(true);
    expect(rec.commands).toEqual(["pnpm exec vitest run"]);
    expect(walk.message).toContain("source plan.policy.testCommand");
  });

  it("clause 2: an argument that holds whitespace is refused, not re-split, and never runs", () => {
    const root = rootWithPolicyTestCommand(["npx", "vitest run"]);
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(clausePlan(), walkOptions(root, rec.runner));
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual([]);
    expect(walk.message).toContain("declared test command refused:");
    expect(walk.message).toContain("argv split cannot be kept");
  });

  it("clause 2: an argument the shell would change (a backslash filter) is refused and never runs", () => {
    const root = rootWithPolicyTestCommand(["npx", "vitest", "run", "-t", "\\bcheckout\\b"]);
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(clausePlan(), walkOptions(root, rec.runner));
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual([]);
    expect(walk.message).toContain("would not reach the shell unchanged");
  });

  it("clause 10: a failed run refuses with the command, source, cwd, exit, last output lines and the grant command", () => {
    const root = rootWithScriptsTest();
    const rec = recorder(1, "running 3 tests\nTests 1 failed\n", "npm ERR! Test failed\n");
    const walk = evaluateScopeCompleteAcceptanceWalk(clausePlan(), walkOptions(root, rec.runner));
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual(["npm test"]);
    expect(walk.message).toContain(SCOPE_COMPLETE_ZERO_VERIFIED_NOTICE.trim());
    expect(walk.message).toContain("declared test command failed: `npm test`");
    expect(walk.message).toContain("source package.json scripts.test");
    expect(walk.message).toContain(`cwd ${root}`);
    expect(walk.message).toContain("exit 1");
    expect(walk.message).toContain("Tests 1 failed");
    expect(walk.message).toContain("npm ERR! Test failed");
    expect(walk.message).toContain("2 clause(s) neither verified nor granted");
    expect(walk.message).toContain(
      "deft authz:grant -- --template acceptance-disposition --plan-ref github.issue.7047 --story-ids clause.1,clause.2",
    );
  });

  it("clauses 5 and 9: a declared command the allowlist refuses never runs and the refusal names the safety reason", () => {
    const root = rootWithPolicyTestCommand("make test");
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(clausePlan(), walkOptions(root, rec.runner));
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual([]);
    // The clause 5 outcome shape, with the safety reason filled in from the allowlist.
    const shape = "declared test command refused: <safety reason>";
    const reasonLine = walk.message
      .split("\n")
      .find((line) => line.startsWith(shape.replace("<safety reason>", "")));
    expect(reasonLine).toBeDefined();
    const reason = (reasonLine ?? "").slice(shape.indexOf("<safety reason>"));
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(reason).toMatch(/make/);
    expect(walk.message).toContain("nothing was run");
    expect(walk.message).toContain("--story-ids clause.1,clause.2");
  });

  it("clause 10: no declared test command refuses with that outcome, the clause list and the grant command", () => {
    const root = tempRoot();
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(clausePlan(), walkOptions(root, rec.runner));
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual([]);
    expect(walk.message).toContain(DECLARED_TEST_FLOOR_NONE);
    expect(walk.message).toContain("no declared test command (set `plan.policy.testCommand`");
    expect(walk.message).toContain("  - clause 1:");
    expect(walk.message).toContain("  - clause 2:");
    expect(walk.message).toContain("--template acceptance-disposition");
  });

  it("clause 8: a caller that passes no resolver runs no floor and refuses as before", () => {
    const root = rootWithScriptsTest();
    const rec = recorder(0);
    const { resolveDeclaredTestCommand: _omit, ...noResolver } = walkOptions(root, rec.runner);
    const walk = evaluateScopeCompleteAcceptanceWalk(clausePlan(), noResolver);
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual([]);
    expect(walk.message).not.toContain("declared test command");
    expect(walk.message).toContain("--template acceptance-disposition");
  });

  it("clauses 5 and 11: a delivered completion of a clause-bearing brief prints the clause list and grant command, not the #5403 text", () => {
    const root = tempRoot();
    const plan = clausePlan();
    (plan.metadata as Record<string, unknown>).completionProvenance = {
      mergeCommit: "abcdef1",
      deliveryBranch: "master",
      disposition: "delivered",
      prNumber: 99,
    };
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, walkOptions(root, recorder(0).runner));
    expect(walk.ok).toBe(false);
    expect(walk.message).not.toContain("Historical ship-closeout (#5403)");
    expect(walk.message).not.toContain("covers clause-less pre-schema briefs only");
    expect(walk.message).toContain("2 clause(s) neither verified nor granted");
    expect(walk.message).toContain("--template acceptance-disposition");
  });

  it("clauses 1 and 8: a brief with stated commands behaves as today and the floor never runs", () => {
    const root = rootWithScriptsTest();
    const plan = clausePlan();
    (plan.acceptance as Record<string, unknown>).commands = [{ command: "pnpm --version" }];
    (plan.acceptance as Record<string, unknown>).none_stated = false;
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, walkOptions(root, rec.runner));
    expect(walk.ok).toBe(true);
    expect(rec.commands).toEqual(["pnpm --version"]);
    expect(walk.message).not.toContain("declared test command");
  });

  it("clauses 1 and 8: a failing stated command still refuses as today and the floor never runs", () => {
    const root = rootWithScriptsTest();
    const plan = clausePlan();
    (plan.acceptance as Record<string, unknown>).commands = [{ command: "pnpm --version" }];
    (plan.acceptance as Record<string, unknown>).none_stated = false;
    const rec = recorder(1);
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, walkOptions(root, rec.runner));
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual(["pnpm --version"]);
    expect(walk.message).not.toContain("declared test command");
  });

  it("clause 8: a brief whose clauses already verify completes as today without the floor", () => {
    const root = rootWithScriptsTest();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    const plan = clausePlan();
    (plan.acceptance as Record<string, unknown>).clauses = [
      { id: 1, text: "src/a.ts exists", artifact_path: "src/a.ts", ambiguous: false },
    ];
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(plan, walkOptions(root, rec.runner));
    expect(walk.ok).toBe(true);
    expect(rec.commands).toEqual([]);
    expect(walk.message).not.toContain("declared test command");
  });

  it("clause 6 and 12: a banked floor run is reused only by a walk whose contract includes the floor record", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const plan = clausePlan();
    const briefPath = join(root, "xbrief", "active", "story.xbrief.json");
    writeFileSync(briefPath, JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2));
    const floor: LiteralAcceptanceCommand = {
      command: "npm test",
      cwd: null,
      expectedStdout: null,
      expectedExitCode: 0,
      source: "metadata",
      sourceSpan: "project_floor (package.json scripts.test)",
    };
    const rec = recorder(0);
    const env = {
      DEFT_SESSION_ID: "sess-7047-floor-bank",
      [ENV_RUN_SUMMARY_PATH]: join(root, "summary.jsonl"),
    };
    const shared = {
      projectRoot: root,
      captureFromNarratives: false,
      hasSuiteFloor: true,
      runner: rec.runner,
      env,
    };
    const banked = evaluateVerifyAcFromPath(briefPath, { ...shared, completionFloorRecord: floor });
    expect(banked.ok).toBe(true);
    expect(rec.commands).toEqual(["npm test"]);

    const withFloor = evaluateVerifyAcFromPlan(plan, {
      ...shared,
      reuseMode: "bank",
      completionFloorRecord: floor,
    });
    expect(withFloor.servedFrom).toBe("bank");
    expect(rec.commands).toEqual(["npm test"]);

    const withoutFloor = evaluateVerifyAcFromPlan(plan, { ...shared, reuseMode: "bank" });
    expect(withoutFloor.servedFrom).not.toBe("bank");
    expect(withoutFloor.runs).toEqual([]);
  });
});

describe("a clause whose every literal is set aside (#7170)", () => {
  function setAsidePlan(): Record<string, unknown> {
    return {
      id: "github.issue.7170",
      title: "every literal negated",
      acceptance: {
        commands: [],
        none_stated: true,
        source_rung: "derived",
        ambiguity_attestation: "none_found",
        clauses: [
          {
            id: 1,
            text: "The docs view never shows 'apikey:…' to readers.",
            artifact_path: "src/view.tsx",
            ambiguous: false,
          },
        ],
      },
      metadata: { swarm: { file_scope: ["src/view.tsx"] } },
      items: [],
    };
  }

  function withView(root: string): string {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "view.tsx"), 'if (a.startsWith("apikey:")) a = name;\n');
    return root;
  }

  it("refuses with the zero-verified notice when no test command is declared", () => {
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(
      setAsidePlan(),
      walkOptions(withView(tempRoot()), rec.runner),
    );
    expect(walk.ok).toBe(false);
    expect(rec.commands).toEqual([]);
    expect(walk.message).toContain(SCOPE_COMPLETE_ZERO_VERIFIED_NOTICE.trim());
    expect(walk.message).toContain(DECLARED_TEST_FLOOR_NONE);
  });

  it("completes through the #7047 floor when a declared test command passes", () => {
    const rec = recorder(0);
    const walk = evaluateScopeCompleteAcceptanceWalk(
      setAsidePlan(),
      walkOptions(withView(rootWithScriptsTest()), rec.runner),
    );
    expect(walk.ok).toBe(true);
    expect(walk.predicate).toBe("executable-pass");
    expect(rec.commands).toEqual(["npm test"]);
  });
});
