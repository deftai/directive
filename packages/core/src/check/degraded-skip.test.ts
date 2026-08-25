import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";

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

function writeConsumerFramework(): { framework: string; project: string } {
  const framework = mkdtempSync(join(tmpdir(), "deft-3335-fw-"));
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
  scope-provenance:
    cmds: [echo ok]
  consumer-check-contract:
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
  return { framework, project: join(tmpdir(), "consumer-project-3335") };
}

describe("degraded skip report in check (#3282)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 (config) with skip report when task is missing — never green", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const started: string[] = [];
    const code = dispatchCachedTaskCheck("/fw", "/fw", {
      noCache: true,
      emitRunSummary: false,
      preflight: {
        status: "degraded",
        ok: false,
        degraded: true,
        findings: [
          {
            tool: "task",
            present: false,
            cause: "go-task binary not found on PATH",
            remedy: "Install go-task",
          },
        ],
        lines: ["[deft preflight] toolchain status: degraded"],
        // Sentinel expands to the live gate composition (#3282).
        skipGateIds: ["*"],
      },
      onGateStart: (id) => started.push(id),
      gateSpawnFn: () => {
        throw new Error("gates must not run when fully degraded");
      },
    });
    expect(code).toBe(2);
    expect(started).toEqual([]);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toMatch(/degraded mode/);
    expect(msg).toMatch(/skipped \d+ gate/);
    expect(msg).toMatch(/go-task binary not found/);
    expect(msg).toMatch(/exit 2/);
    expect(msg).not.toMatch(/exit 0 \(degraded\)/);
  });

  it("runs CLI-native gates via global CLI when go-task is absent (#3335)", () => {
    const { framework, project } = writeConsumerFramework();
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawned: Array<{ gateId: string; bin: string; args: readonly string[] }> = [];
    const code = dispatchCachedTaskCheck(framework, project, {
      noCache: true,
      emitRunSummary: false,
      cliBin: "deft",
      preflight: {
        status: "ok",
        ok: true,
        degraded: false,
        findings: [
          {
            tool: "task",
            present: false,
            cause: "go-task absent; CLI-native gates dispatch via global deft/directive (#3335)",
            remedy: null,
            impact: "none",
          },
        ],
        lines: ["[deft preflight] task: absent (impact: none)"],
        skipGateIds: [],
      },
      gateSpawnFn: (gateId, bin, args) => {
        spawned.push({ gateId, bin, args });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    expect(spawned.length).toBeGreaterThan(0);
    const ac = spawned.find((s) => s.gateId === "verify:ac");
    expect(ac?.bin).toBe("deft");
    expect(ac?.args).toEqual(["verify:ac", "--soft-missing-xbrief"]);
    expect(ac?.args).not.toContain("--taskfile");
    expect(spawned.every((s) => s.bin === "deft")).toBe(true);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).not.toMatch(/Install go-task|taskfile\.dev/i);
    expect(msg).not.toMatch(/skipping gate verify:ac/);
  });

  it("prints named cause when a gate fails", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchCachedTaskCheck("/fw-named", "/fw-named", {
      noCache: true,
      emitRunSummary: false,
      preflight: null,
      gateSpawnFn: (gateId) => {
        if (gateId === "verify:branch") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "branch protection refused default branch\n",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(1);
    const msg = errWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toMatch(/gate verify:branch failed/);
    expect(msg).toMatch(/cause:/);
    expect(msg).toMatch(/remedy:/);
  });
});
