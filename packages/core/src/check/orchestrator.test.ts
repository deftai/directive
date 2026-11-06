import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSED_GATE_IDS } from "../presentation-coverage/gates.js";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";
import { isSuiteCheckGate } from "./gate-lists.js";
import {
  CITED_SKIP_BASELINE,
  dispatchTaskCheck,
  evaluateCitedSkipScan,
  formatCitedSkipListing,
  inventoryCitedSkipsInSource,
  isFrameworkRepoRoot,
  isFrameworkSourceContext,
  parseSkippedTestsBlock,
  resolveCheckTarget,
} from "./orchestrator.js";
import { recordProductMutationCompletion } from "./product-mutation-completion.js";
import { RAPID_ZERO_VERIFIED_CHECK_NOTICE } from "./rapid-zero-verified.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("isFrameworkSourceContext", () => {
  it("returns true when framework and project roots are the same path", () => {
    expect(isFrameworkSourceContext("/a/b/c", "/a/b/c")).toBe(true);
  });

  it("returns true when paths are equivalent after resolve", () => {
    // resolve('/a/b/../b/c') === '/a/b/c'
    expect(isFrameworkSourceContext("/a/b/c", "/a/b/../b/c")).toBe(true);
  });

  it("returns false when paths differ", () => {
    expect(isFrameworkSourceContext("/framework/root", "/consumer/project")).toBe(false);
  });

  it("returns false for subpath relationship", () => {
    expect(isFrameworkSourceContext("/project/.deft/core", "/project")).toBe(false);
  });

  it("returns true for a subdirectory of the framework source repo (#2220)", () => {
    expect(isFrameworkSourceContext(repoRoot, join(repoRoot, "packages", "core"))).toBe(true);
  });

  it("returns false when projectRoot is outside the framework repo", () => {
    expect(isFrameworkSourceContext(repoRoot, "/tmp/other-project")).toBe(false);
  });
});

describe("isFrameworkRepoRoot", () => {
  it("recognizes the real framework checkout", () => {
    expect(isFrameworkRepoRoot(repoRoot)).toBe(true);
  });

  it("rejects a bare consumer-style path", () => {
    expect(isFrameworkRepoRoot("/tmp/consumer/.deft/core")).toBe(false);
  });
});

describe("resolveCheckTarget", () => {
  it("returns check:framework-source when roots are equal", () => {
    expect(resolveCheckTarget("/same/path", "/same/path")).toBe("check:framework-source");
  });

  it("returns check:framework-source for a framework-repo subdirectory (#2220)", () => {
    expect(resolveCheckTarget(repoRoot, join(repoRoot, "packages", "core"))).toBe(
      "check:framework-source",
    );
  });

  it("returns check:consumer when roots differ", () => {
    expect(resolveCheckTarget("/framework", "/consumer")).toBe("check:consumer");
  });
});

describe("dispatchTaskCheck", () => {
  it("invokes task check:framework-source for framework-source context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const root = "/home/user/deft";
    const code = dispatchTaskCheck(root, root, { spawnFn, useTaskCache: false });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("check:framework-source");
    expect(calls[0]?.args).toContain("--taskfile");
  });

  it("invokes task check:consumer for consumer context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const framework = "/home/user/deft";
    const project = "/home/user/consumer-project";
    const code = dispatchTaskCheck(framework, project, { spawnFn, useTaskCache: false });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("check:consumer");
  });

  it("uses the correct cwd for framework-source context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const root = "/home/user/deft";
    dispatchTaskCheck(root, root, { spawnFn, useTaskCache: false });
    expect(calls[0]?.cwd).toBe(resolve(root));
  });

  it("uses projectRoot as cwd for consumer context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const framework = "/home/user/deft";
    const project = "/home/user/consumer";
    dispatchTaskCheck(framework, project, { spawnFn, useTaskCache: false });
    expect(calls[0]?.cwd).toBe(resolve(project));
  });

  it("allows scaffold-empty PD on the uncached path; refuses only with product-mutation (#5176)", () => {
    const scaffold = mkdtempSync(join(tmpdir(), "deft-5176-empty-pd-"));
    tempDirs.push(scaffold);
    mkdirSync(join(scaffold, "xbrief"), { recursive: true });
    const emptyPd = `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "demo", narratives: { Overview: "", "tech stack": "  " } },
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(scaffold, "xbrief", "PROJECT-DEFINITION.xbrief.json"), emptyPd, "utf8");

    const scaffoldCalls: unknown[] = [];
    const scaffoldSpawn = () => {
      scaffoldCalls.push("spawned");
      return { status: 0 };
    };
    const scaffoldCode = dispatchTaskCheck(scaffold, scaffold, {
      spawnFn: scaffoldSpawn,
      useTaskCache: false,
    });
    expect(scaffoldCode).toBe(0);
    expect(scaffoldCalls).toHaveLength(1);

    const mutated = mkdtempSync(join(tmpdir(), "deft-5176-mutated-pd-"));
    tempDirs.push(mutated);
    mkdirSync(join(mutated, "xbrief"), { recursive: true });
    writeFileSync(join(mutated, "xbrief", "PROJECT-DEFINITION.xbrief.json"), emptyPd, "utf8");
    recordProductMutationCompletion(mutated, new Date("2026-09-30T12:00:00Z"));

    const mutatedCalls: unknown[] = [];
    const mutatedSpawn = () => {
      mutatedCalls.push("spawned");
      return { status: 0 };
    };
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const mutatedCode = dispatchTaskCheck(mutated, mutated, {
      spawnFn: mutatedSpawn,
      useTaskCache: false,
    });
    expect(mutatedCode).toBe(1);
    expect(mutatedCalls).toHaveLength(0);
    const errText = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(errText).toMatch(/verify:persisted-planning-narratives/);
    expect(errText).toMatch(/project:write-narratives/);
    errWrite.mockRestore();
  });

  it("does not refuse missing PROJECT-DEFINITION on the uncached check path (#5176)", () => {
    const project = mkdtempSync(join(tmpdir(), "deft-5176-missing-pd-"));
    tempDirs.push(project);
    const calls: unknown[] = [];
    const spawnFn = () => {
      calls.push("spawned");
      return { status: 0 };
    };
    const code = dispatchTaskCheck(project, project, { spawnFn, useTaskCache: false });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("fails with deposit-repair guidance when consumer deposit lacks verify.yml (#3070)", () => {
    const framework = mkdtempSync(join(tmpdir(), "deft-3070-fw-"));
    tempDirs.push(framework);
    mkdirSync(join(framework, "tasks"), { recursive: true });
    writeFileSync(
      join(framework, "Taskfile.yml"),
      `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
    optional: true
  toolchain:
    taskfile: ./tasks/toolchain.yml
  vbrief:
    taskfile: ./tasks/vbrief.yml
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "toolchain.yml"),
      "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "vbrief.yml"),
      "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
      "utf8",
    );

    const calls: unknown[] = [];
    const spawnFn = () => {
      calls.push("spawned");
      return { status: 0 };
    };
    const project = join(tmpdir(), "consumer-project");
    const code = dispatchTaskCheck(framework, project, { spawnFn, useTaskCache: false });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("uses a custom task binary when provided via seams", () => {
    const calls: Array<{ cmd: string }> = [];
    const spawnFn = (cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd });
      return { status: 0 };
    };

    dispatchTaskCheck("/root", "/root", { taskBin: "my-task", spawnFn, useTaskCache: false });
    expect(calls[0]?.cmd).toBe("my-task");
  });

  it("returns 2 when the spawn throws an error", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: null, error: new Error("task not found") };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false });
    expect(code).toBe(2);
    errWrite.mockRestore();
  });

  it("returns 1 when task exits with null status and no error", () => {
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: null };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false });
    expect(code).toBe(1);
  });

  it("passes the framework-root Taskfile.yml path in --taskfile arg", () => {
    const calls: Array<{ args: string[] }> = [];
    const spawnFn = (_cmd: string, args: string[], _opts: { cwd: string; stdio: string }) => {
      calls.push({ args });
      return { status: 0 };
    };

    dispatchTaskCheck("/my/framework", "/my/consumer", { spawnFn, useTaskCache: false });
    const taskfileIdx = calls[0]?.args.indexOf("--taskfile") ?? -1;
    expect(taskfileIdx).toBeGreaterThan(-1);
    const taskfilePath = calls[0]?.args[taskfileIdx + 1];
    expect(taskfilePath).toBe(join(resolve("/my/framework"), "Taskfile.yml"));
  });

  it("forwards non-zero exit code from task subprocess", () => {
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: 42 };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false });
    expect(code).toBe(42);
  });

  it("forwards release self-auth env to the task child (#2386)", () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = (
      _cmd: string,
      _args: string[],
      opts: { cwd: string; stdio: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ env: opts.env });
      return { status: 0 };
    };

    const env = {
      FOO: "bar",
      DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "1",
      DEFT_RELEASE_PREFLIGHT: "1",
    };
    dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false, env });
    expect(calls[0]?.env?.FOO).toBe("bar");
    expect(calls[0]?.env?.DEFT_ALLOW_DEFAULT_BRANCH_COMMIT).toBe("1");
    expect(calls[0]?.env?.DEFT_RELEASE_PREFLIGHT).toBe("1");
  });

  it("returns 124 when the spawn hits the configured timeout (#2652)", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawnFn = (
      _cmd: string,
      _args: string[],
      _opts: { cwd: string; stdio: string; timeoutMs?: number },
    ) => ({ status: null, signal: "SIGTERM" as const });

    const code = dispatchTaskCheck("/root", "/root", {
      spawnFn,
      useTaskCache: false,
      timeoutMs: 60_000,
    });
    expect(code).toBe(124);
    errWrite.mockRestore();
  });

  it("uses the real defaultSpawn path when no spawnFn is provided (taskBin not found = error path)", () => {
    // When no spawnFn seam is given, dispatchTaskCheck calls the internal
    // defaultSpawn which wraps spawnSync. Using a non-existent binary causes
    // spawnSync to populate result.error (ENOENT), which maps to exit 2.
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchTaskCheck("/tmp/fake-fw", "/tmp/fake-fw", {
      taskBin: "/absolutely-nonexistent-binary-that-cannot-exist",
      useTaskCache: false,
    });
    expect(code).toBe(2);
    errWrite.mockRestore();
  });
});

describe("dispatchCachedTaskCheck fail-fast before suite (#3188)", () => {
  it("does not start ts:check-lane when an earlier fast gate fails", () => {
    const started: string[] = [];
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = dispatchCachedTaskCheck("/fw-root-3188", "/fw-root-3188", {
      noCache: true,
      // #3282: isolate fail-fast ordering from live toolchain preflight.
      preflight: null,
      emitRunSummary: false,
      onGateStart: (gateId) => {
        started.push(gateId);
      },
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:cache-fresh") {
          return { exitCode: 1, stdout: "", stderr: "forced stale cache\n" };
        }
        return {
          exitCode: 0,
          stdout:
            gateId === "verify:presentation-coverage"
              ? JSON.stringify({ code: 0, armed: false, coverage: [] })
              : "",
          stderr: "",
        };
      },
    });

    expect(code).toBe(1);
    expect(started).toContain("verify:cache-fresh");
    expect(started.some(isSuiteCheckGate)).toBe(false);
    expect(started).not.toContain("ts:check-lane");
    const skipMsg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(skipMsg).toMatch(/fast gate verify:cache-fresh failed/);
    expect(skipMsg).toMatch(/skipping remaining gates including suite \(#3188\)/);
    errWrite.mockRestore();
  });

  it("arms the suite supervisor timeout only when timeoutMs is set (#4230)", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const plans: Array<{ timeoutMs?: number; command: string; args: readonly string[] }> = [];
    const code = dispatchCachedTaskCheck("/fw-root-4230", "/fw-root-4230", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      timeoutMs: 50,
      gateSpawnFn: (gateId) => ({
        exitCode: 0,
        stdout:
          gateId === "verify:presentation-coverage"
            ? JSON.stringify({ code: 0, armed: false, coverage: [] })
            : "",
        stderr: "",
      }),
      superviseSuite: (plan) => {
        plans.push({ timeoutMs: plan.timeoutMs, command: plan.command, args: plan.args });
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          stdout: "ok",
          stderr: "",
          teePath: "",
          teeRel: "",
        };
      },
    });
    expect(code).toBe(0);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.timeoutMs).toBe(50);

    plans.length = 0;
    dispatchCachedTaskCheck("/fw-root-4230b", "/fw-root-4230b", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      gateSpawnFn: (gateId) => ({
        exitCode: 0,
        stdout:
          gateId === "verify:presentation-coverage"
            ? JSON.stringify({ code: 0, armed: false, coverage: [] })
            : "",
        stderr: "",
      }),
      superviseSuite: (plan) => {
        plans.push({ timeoutMs: plan.timeoutMs, command: plan.command, args: plan.args });
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          stdout: "ok",
          stderr: "",
          teePath: "",
          teeRel: "",
        };
      },
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.timeoutMs).toBeUndefined();
    errWrite.mockRestore();
  });

  it("does not start the consumer suite when an earlier fast gate fails", () => {
    // Minimal deposit that passes #3070 consumer-gate integrity so the
    // sequential runner reaches CONSUMER_CHECK_GATES. Declared consumer
    // tests (#4386) are the suite gate on that list.
    const framework = mkdtempSync(join(tmpdir(), "deft-3188-fw-"));
    tempDirs.push(framework);
    mkdirSync(join(framework, "tasks"), { recursive: true });
    writeFileSync(
      join(framework, "Taskfile.yml"),
      `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
  toolchain:
    taskfile: ./tasks/toolchain.yml
  vbrief:
    taskfile: ./tasks/vbrief.yml
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "verify.yml"),
      `version: '3'
tasks:
  ac:
    cmds: [echo ok]
  branch:
    cmds: [echo ok]
  cache-fresh:
    cmds: [echo ok]
  wip-cap:
    cmds: [echo ok]
  orphan-active:
    cmds: [echo ok]
  completed-write-guard:
    cmds: [echo ok]
  test-boundary:
    cmds: [echo ok]
  class-checks:
    cmds: [echo ok]
  scope-provenance:
    cmds: [echo ok]
  consumer-check-contract:
    cmds: [echo ok]
  evaluator-surface:
    cmds: [echo ok]
  observable-scope:
    cmds: [echo ok]
  intent-constraint:
    cmds: [echo ok]
  presentation-ceiling:
    cmds: [echo ok]
  durable-effect-acquisition:
    cmds: [echo ok]
  presentation-coverage:
    cmds: [echo ok]
  consumer-test-lane:
    cmds: [echo ok]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "toolchain.yml"),
      "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "vbrief.yml"),
      "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
      "utf8",
    );

    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const project = join(tmpdir(), "consumer-project-3188");
    const code = dispatchCachedTaskCheck(framework, project, {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:branch") {
          return { exitCode: 1, stdout: "", stderr: "branch fail\n" };
        }
        return {
          exitCode: 0,
          stdout:
            gateId === "verify:presentation-coverage"
              ? JSON.stringify({ code: 0, armed: false, coverage: [] })
              : "",
          stderr: "",
        };
      },
    });

    expect(code).toBe(1);
    const skipMsg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(skipMsg).toMatch(/skipping remaining gates including suite \(#3188\)/);
    errWrite.mockRestore();
  });

  it("logs suite start only after all fast gates pass", () => {
    const started: string[] = [];
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = dispatchCachedTaskCheck("/fw-root-3188-ok", "/fw-root-3188-ok", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      onGateStart: (gateId) => {
        started.push(gateId);
      },
      gateSpawnFn: (gateId) => ({
        exitCode: 0,
        stdout:
          gateId === "verify:presentation-coverage"
            ? JSON.stringify({ code: 0, armed: false, coverage: [] })
            : "",
        stderr: "",
      }),
    });

    expect(code).toBe(0);
    expect(started[started.length - 1]).toBe("ts:check-lane");
    const logs = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(logs).toMatch(/starting suite gate ts:check-lane after fast preflight \(#3188\)/);
    errWrite.mockRestore();
  });
});

describe("dispatchCachedTaskCheck empty verify:ac (#3334)", () => {
  it("records verify:ac soft_empty as skipped/degraded, not a green run", () => {
    const framework = mkdtempSync(join(tmpdir(), "deft-3334-fw-"));
    tempDirs.push(framework);
    mkdirSync(join(framework, "tasks"), { recursive: true });
    writeFileSync(
      join(framework, "Taskfile.yml"),
      `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
  toolchain:
    taskfile: ./tasks/toolchain.yml
  vbrief:
    taskfile: ./tasks/vbrief.yml
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "verify.yml"),
      `version: '3'
tasks:
  ac:
    cmds: [echo ok]
  branch:
    cmds: [echo ok]
  cache-fresh:
    cmds: [echo ok]
  wip-cap:
    cmds: [echo ok]
  orphan-active:
    cmds: [echo ok]
  completed-write-guard:
    cmds: [echo ok]
  test-boundary:
    cmds: [echo ok]
  class-checks:
    cmds: [echo ok]
  scope-provenance:
    cmds: [echo ok]
  consumer-check-contract:
    cmds: [echo ok]
  evaluator-surface:
    cmds: [echo ok]
  observable-scope:
    cmds: [echo ok]
  intent-constraint:
    cmds: [echo ok]
  presentation-ceiling:
    cmds: [echo ok]
  durable-effect-acquisition:
    cmds: [echo ok]
  presentation-coverage:
    cmds: [echo ok]
  consumer-test-lane:
    cmds: [echo ok]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "toolchain.yml"),
      "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "vbrief.yml"),
      "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
      "utf8",
    );

    const summary = join(framework, "summary.jsonl");
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const project = mkdtempSync(join(tmpdir(), "consumer-3334-"));
    tempDirs.push(project);
    const code = dispatchCachedTaskCheck(framework, project, {
      noCache: true,
      preflight: null,
      env: { DEFT_RUN_SUMMARY_PATH: summary },
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:ac") {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "verify:ac soft_empty (#3334) [rung=project_floor]: no acceptance stamped — floor is empty in this project.\n",
          };
        }
        return {
          exitCode: 0,
          stdout:
            gateId === "verify:presentation-coverage"
              ? JSON.stringify({ code: 0, armed: false, coverage: [] })
              : "",
          stderr: "",
        };
      },
    });

    expect(code).toBe(1);
    const logs = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(logs).toMatch(/soft_empty/);
    expect(logs).toMatch(/degraded \(#3334\)/);
    const text = readFileSync(summary, "utf8");
    const line = JSON.parse(text.trim().split(/\r?\n/)[0] ?? "{}") as {
      event: string;
      payload: {
        exit_code: number;
        degraded: boolean;
        gates: readonly { id: string; status: string; cause?: string }[];
      };
    };
    expect(line.event).toBe("check_invocation");
    expect(line.payload.exit_code).toBe(1);
    expect(line.payload.degraded).toBe(true);
    const ac = line.payload.gates.find((g) => g.id === "verify:ac");
    expect(ac?.status).toBe("skipped");
    expect(ac?.cause).toMatch(/no acceptance stamped/);
    errWrite.mockRestore();
  });
});

const ZERO_VERIFIED_AC =
  "verify:ac clause walk (#3323): 0 verified, 5 unverifiable, 0 failed\n" +
  "verify:ac passed (#3284) (0 verified, 5 unverifiable) [rung=derived]\n";

describe("dispatchCachedTaskCheck rapid zero-verified walk (#4866)", () => {
  function runMode(
    mode: "rapid" | "full" | "pressure",
    acStdout: string,
  ): {
    code: number;
    started: string[];
    logs: string;
    acGate: { status?: string; exit_code?: number } | undefined;
  } {
    const started: string[] = [];
    let acGate: { status?: string; exit_code?: number } | undefined;
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchCachedTaskCheck(`/fw-root-4866-${mode}`, `/fw-root-4866-${mode}`, {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      env: { DEFT_CHECK_MODE: mode },
      onGateStart: (gateId) => {
        started.push(gateId);
      },
      onCheckComplete: ({ gates }) => {
        acGate = gates.find((gate) => gate.id === "verify:ac");
      },
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:ac") {
          return { exitCode: 0, stdout: acStdout, stderr: "" };
        }
        return {
          exitCode: 0,
          stdout:
            gateId === "verify:presentation-coverage"
              ? JSON.stringify({ code: 0, armed: false, coverage: [] })
              : "",
          stderr: "",
        };
      },
    });
    const logs = errWrite.mock.calls.map((c) => String(c[0])).join("");
    errWrite.mockRestore();
    return { code, started, logs, acGate };
  }

  it("does not exit 0 when rapid verify:ac reports zero verified clauses", () => {
    const { code, started, logs, acGate } = runMode("rapid", ZERO_VERIFIED_AC);
    expect(code).not.toBe(0);
    expect(code).toBe(1);
    expect(started).toEqual(["verify:ac"]);
    expect(acGate?.status).toBe("run");
    expect(acGate?.exit_code).toBe(0);
    expect(logs).toContain(RAPID_ZERO_VERIFIED_CHECK_NOTICE);
    expect(logs).not.toMatch(/verify:ac failed/i);
  });

  it("still exits 0 in rapid mode when the walk reports a verified clause", () => {
    const { code, started, logs } = runMode(
      "rapid",
      "verify:ac passed (#3284) (1 verified, 4 unverifiable) [rung=derived]\n",
    );
    expect(code).toBe(0);
    expect(started).toEqual([
      "verify:ac",
      "verify:presentation-ceiling",
      "verify:durable-effect-acquisition",
      "verify:presentation-coverage",
    ]);
    expect(logs).not.toContain(RAPID_ZERO_VERIFIED_CHECK_NOTICE);
  });

  it("still exits 0 in rapid mode when the walk does not report a verified count", () => {
    const { code, started } = runMode("rapid", "verify:ac passed (#3284) [rung=derived]\n");
    expect(code).toBe(0);
    expect(started).toEqual([
      "verify:ac",
      "verify:presentation-ceiling",
      "verify:durable-effect-acquisition",
      "verify:presentation-coverage",
    ]);
  });

  it("does not fail full or pressure mode, and those modes still run later gates", () => {
    const full = runMode("full", ZERO_VERIFIED_AC);
    expect(full.code).toBe(0);
    expect(full.started).toContain("verify:ac");
    expect(full.started).toContain("verify:branch");
    expect(full.logs).not.toContain(RAPID_ZERO_VERIFIED_CHECK_NOTICE);

    const pressure = runMode("pressure", ZERO_VERIFIED_AC);
    expect(pressure.code).toBe(0);
    expect(pressure.started).toContain("verify:branch");
    expect(pressure.logs).not.toContain(RAPID_ZERO_VERIFIED_CHECK_NOTICE);
  });
});

describe("dispatchCachedTaskCheck Path B activation AC disposition (#5792)", () => {
  function writeMinimalFramework(framework: string): void {
    mkdirSync(join(framework, "tasks"), { recursive: true });
    writeFileSync(
      join(framework, "Taskfile.yml"),
      `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
  toolchain:
    taskfile: ./tasks/toolchain.yml
  vbrief:
    taskfile: ./tasks/vbrief.yml
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "verify.yml"),
      `version: '3'
tasks:
  ac:
    cmds: [echo ok]
  branch:
    cmds: [echo ok]
  cache-fresh:
    cmds: [echo ok]
  wip-cap:
    cmds: [echo ok]
  orphan-active:
    cmds: [echo ok]
  completed-write-guard:
    cmds: [echo ok]
  test-boundary:
    cmds: [echo ok]
  class-checks:
    cmds: [echo ok]
  scope-provenance:
    cmds: [echo ok]
  consumer-check-contract:
    cmds: [echo ok]
  evaluator-surface:
    cmds: [echo ok]
  observable-scope:
    cmds: [echo ok]
  intent-constraint:
    cmds: [echo ok]
  presentation-ceiling:
    cmds: [echo ok]
  durable-effect-acquisition:
    cmds: [echo ok]
  presentation-coverage:
    cmds: [echo ok]
  consumer-test-lane:
    cmds: [echo ok]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "toolchain.yml"),
      "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "vbrief.yml"),
      "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
      "utf8",
    );
  }

  it("defers verify:ac spawn on brief-land git inventory and continues hygiene", () => {
    const framework = mkdtempSync(join(tmpdir(), "deft-5792-fw-"));
    tempDirs.push(framework);
    writeMinimalFramework(framework);

    const project = mkdtempSync(join(tmpdir(), "consumer-5792-"));
    tempDirs.push(project);
    execFileSync("git", ["init", "-b", "master"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: project, stdio: "ignore" });
    writeFileSync(join(project, "README.md"), "base\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/deftai/directive.git"], {
      cwd: project,
      stdio: "ignore",
    });
    // Pin delivery tip before the activation land so inventory is non-empty.
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], {
      cwd: project,
      stdio: "ignore",
    });

    mkdirSync(join(project, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(project, "xbrief", "active", "story-5792.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5792",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    writeFileSync(join(project, "CHANGELOG.md"), "# Changelog\n", "utf8");
    execFileSync("git", ["add", "xbrief/active/story-5792.xbrief.json", "CHANGELOG.md"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync("git", ["commit", "-m", "Path B activation"], {
      cwd: project,
      stdio: "ignore",
    });

    const started: string[] = [];
    let acSpawned = 0;
    let acOutcome: { status?: string; cause?: string; exit_code?: number } | undefined;
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    dispatchCachedTaskCheck(framework, project, {
      noCache: true,
      preflight: null,
      onGateStart: (id) => started.push(id),
      onCheckComplete: ({ gates }) => {
        acOutcome = gates.find((g) => g.id === "verify:ac");
      },
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:ac") {
          acSpawned += 1;
          return {
            exitCode: 201,
            stdout: "",
            stderr: "verify:ac FAILED — must not spawn under activation disposition\n",
          };
        }
        return { exitCode: 0, stdout: `${gateId} ok\n`, stderr: "" };
      },
    });
    const logs = errWrite.mock.calls.map((c) => String(c[0])).join("");
    errWrite.mockRestore();
    expect(acSpawned).toBe(0);
    expect(started[0]).toBe("verify:ac");
    expect(started).toContain("verify:branch");
    expect(logs).toMatch(/path_b_activation_deferred \(#5792\)/);
    expect(acOutcome?.status).toBe("run");
    expect(acOutcome?.exit_code).toBe(0);
    expect(acOutcome?.cause).toBe("path_b_activation_deferred");
  });

  it("keeps full verify:ac when inventory includes product paths", () => {
    const framework = mkdtempSync(join(tmpdir(), "deft-5792-fw-prod-"));
    tempDirs.push(framework);
    writeMinimalFramework(framework);

    const project = mkdtempSync(join(tmpdir(), "consumer-5792-prod-"));
    tempDirs.push(project);
    execFileSync("git", ["init", "-b", "master"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "test"], { cwd: project, stdio: "ignore" });
    writeFileSync(join(project, "README.md"), "base\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/deftai/directive.git"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync("git", ["update-ref", "refs/remotes/origin/master", "HEAD"], {
      cwd: project,
      stdio: "ignore",
    });
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "record-reference.js"), "export {}\n", "utf8");
    execFileSync("git", ["add", "src/record-reference.js"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "product"], { cwd: project, stdio: "ignore" });

    let acSpawned = 0;
    const logs: string[] = [];
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    dispatchCachedTaskCheck(framework, project, {
      noCache: true,
      preflight: null,
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:ac") {
          acSpawned += 1;
          return { exitCode: 0, stdout: "verify:ac passed (#3284)\n", stderr: "" };
        }
        return { exitCode: 0, stdout: `${gateId} ok\n`, stderr: "" };
      },
    });
    errWrite.mockRestore();
    expect(acSpawned).toBe(1);
    expect(logs.join("")).not.toMatch(/path_b_activation_deferred \(#5792\)/);
  });
});

describe("armed coverage aggregate preserves real required outcomes (#5079)", () => {
  const report = (armed: boolean) =>
    JSON.stringify({
      code: 0,
      armed,
      uncoveredPaths: [],
      coverage: armed
        ? COMPOSED_GATE_IDS.map((gateId) => ({
            gateId,
            status: "evaluated",
            code: 0,
            analyzedPaths: [],
            cannotEvaluatePaths: [],
            message: "evaluated",
          }))
        : [],
    });
  it.each([
    1, 2,
  ])("preserves a prior required failure %s even after a green armed report", (failure) => {
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let coverageStarted = false;
    const code = dispatchCachedTaskCheck("/fw-5079", "/fw-5079", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      env: { DEFT_CHECK_MODE: "pressure" },
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:presentation-coverage") coverageStarted = true;
        return {
          exitCode: gateId === "verify:scope-provenance" ? failure : 0,
          stdout: gateId === "verify:presentation-coverage" ? report(true) : "",
          stderr: "",
        };
      },
    });
    expect(coverageStarted).toBe(true);
    expect(code).toBe(failure);
    expect(errors.mock.calls.flat().join("")).toContain(
      "preserves required verify:scope-provenance",
    );
    errors.mockRestore();
  });
  it("retains the existing off-ceiling pressure behavior", () => {
    const code = dispatchCachedTaskCheck("/fw-5079-off", "/fw-5079-off", {
      noCache: true,
      preflight: null,
      emitRunSummary: false,
      env: { DEFT_CHECK_MODE: "pressure" },
      gateSpawnFn: (gateId) => ({
        exitCode: gateId === "verify:scope-provenance" ? 1 : 0,
        stdout: gateId === "verify:presentation-coverage" ? report(false) : "",
        stderr: "",
      }),
    });
    expect(code).toBe(0);
  });
  it("accepts cold-build stdout before a complete armed report in rapid mode", () => {
    expect(
      dispatchCachedTaskCheck("/fw-5079-cold", "/fw-5079-cold", {
        noCache: true,
        preflight: null,
        emitRunSummary: false,
        env: { DEFT_CHECK_MODE: "rapid" },
        gateSpawnFn: (gateId) => ({
          exitCode: 0,
          stderr: "",
          stdout:
            gateId === "verify:presentation-coverage" ? `> build\n$ tsc -b\n${report(true)}\n` : "",
        }),
      }),
    ).toBe(0);
  });
  it("refuses a rapid green exit without required typed coverage", () => {
    expect(
      dispatchCachedTaskCheck("/fw-5079-rapid", "/fw-5079-rapid", {
        noCache: true,
        preflight: null,
        emitRunSummary: false,
        env: { DEFT_CHECK_MODE: "rapid" },
        gateSpawnFn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).toBe(2);
  });
});

describe("cited-skip scanner (#6071)", () => {
  it("accepts it.skip with citation when issue open and title listed", () => {
    const source = `// skip: deftai/directive#6066\nit.skip("waitMergeableAndMerge > monitor config error propagates to exit two", () => {});`;
    const sites = inventoryCitedSkipsInSource(source, "packages/core/src/demo.test.ts");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.issue).toBe(6066);
    expect(sites[0]?.title).toBe(
      "waitMergeableAndMerge > monitor config error propagates to exit two",
    );
    const titles = parseSkippedTestsBlock(
      "```skipped-tests:\n- waitMergeableAndMerge > monitor config error propagates to exit two\n```",
    );
    expect(titles).toContain("waitMergeableAndMerge > monitor config error propagates to exit two");
    void evaluateCitedSkipScan;
  });

  it("refuses describe.skip and does not treat skipIf as skip", () => {
    // Build fixture at runtime so tree inventory does not treat this file as a real skip.
    const source = [
      "describe",
      '.skip("suite", () => {});',
      "\n",
      'it.skipIf(process.platform === "win32")("symlink", () => {});',
    ].join("");
    const sites = inventoryCitedSkipsInSource(source, "x.test.ts");
    expect(sites.some((s) => s.kind === "describe.skip")).toBe(true);
    expect(sites.every((s) => s.kind !== "it.skip" || s.title !== "symlink")).toBe(true);
    expect(source).toContain("skipIf");
    expect(sites.some((s) => s.title === "symlink")).toBe(false);
  });

  it("refuses skip whose title is not in the issue skipped-tests block", () => {
    const titles = parseSkippedTestsBlock("```skipped-tests:\n- allowed title\n```");
    expect(titles).toEqual(["allowed title"]);
    expect(titles.includes("other title")).toBe(false);
  });

  it("lists sanctioned skips shape on every run", () => {
    const listing = formatCitedSkipListing([
      {
        file: "a.test.ts",
        kind: "it.skip",
        title: "t",
        dynamicTitle: false,
        issue: 1,
        line: 3,
      },
    ]);
    expect(listing).toContain("cited-skips:");
    expect(listing).toContain("a.test.ts:3");
  });

  it("pins four-site baseline including yoloSterile aliases", () => {
    expect(CITED_SKIP_BASELINE).toHaveLength(5);
    expect(CITED_SKIP_BASELINE.filter((b) => b.file.includes("legacy-bridge-leg")).length).toBe(2);
    expect(CITED_SKIP_BASELINE.filter((b) => b.dynamicTitle).length).toBe(2);
  });

  it("refuses a second matching skip after baseline slot is consumed", () => {
    const root = mkdtempSync(join(tmpdir(), "cited-skip-baseline-"));
    tempDirs.push(root);
    const rel = "packages/core/src/check/orchestrator.test.ts";
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      [
        'describe.skip("baseline slot one", () => {});',
        'describe.skip("extra unsanctioned suite", () => {});',
        "",
      ].join("\n"),
      "utf8",
    );
    const result = evaluateCitedSkipScan({ projectRoot: root, changedFiles: [rel] });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("extra unsanctioned suite") || f.includes("describe.skip"))).toBe(
      true,
    );
  });
});
