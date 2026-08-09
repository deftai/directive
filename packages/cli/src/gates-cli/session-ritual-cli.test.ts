import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSessionStart, verifySessionRitual } from "@deftai/directive-core/session";
import { afterAll, describe, expect, it } from "vitest";
import { runDeftTs, seedProject } from "./_helpers.js";

const roots: string[] = [];
afterAll(() => {
  roots.length = 0;
});

function fakeGit(head: string, worktree: string) {
  return (_r: string, args: readonly string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("session:start TS module (maps tests/cli/test_session_start.py)", () => {
  it("records quick-tier ritual state", () => {
    const root = seedProject({ sessionRitualStalenessHours: 4 });
    roots.push(root);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = runSessionStart(root, {
      now: new Date("2026-06-09T01:00:00Z"),
      runGit: fakeGit(head, resolve(root)),
      // Headless: tools readiness is constant; stub for CI sandboxes.
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("Deft Directive active");
    const state = JSON.parse(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")) as {
      schemaVersion: number;
      quick_steps: Record<string, unknown>;
    };
    expect(state.schemaVersion).toBe(1);
    // #3214/#3156: verify_tools is a quick-step on cold ritual-state.
    expect(Object.keys(state.quick_steps).sort()).toEqual(
      ["alignment", "branch_policy", "triage_welcome", "verify_tools"].sort(),
    );
  });

  it("records explicit deferrals", () => {
    const root = seedProject();
    roots.push(root);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = runSessionStart(root, {
      deferrals: { doctor: "postponed" },
      now: new Date("2026-06-09T01:00:00Z"),
      runGit: fakeGit(head, resolve(root)),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const state = JSON.parse(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")) as {
      gated_steps: { doctor?: { deferred_reason?: string } };
    };
    expect(state.gated_steps.doctor?.deferred_reason).toBe("postponed");
  });
});

describe("deft-ts session:start dispatcher smoke", () => {
  it("native session:start records ritual state without framework-commands bridge (#2032)", () => {
    const root = seedProject();
    roots.push(root);
    const { exitCode, stdout, stderr } = runDeftTs("session:start", [
      "--project-root",
      root,
      "--no-history",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Deft Directive active");
    expect(stdout).toContain("[deft] session ritual recorded at");
    expect(stderr).toBe("");
    const statePath = join(root, ".deft", "ritual-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      quick_steps: Record<string, unknown>;
    };
    // #3214/#3156: verify_tools is persisted on quick_steps (real tool probe in CLI path).
    expect(Object.keys(state.quick_steps).sort()).toEqual(
      ["alignment", "branch_policy", "triage_welcome", "verify_tools"].sort(),
    );
  });

  it("session:start alias resolves to session-start handler", () => {
    const root = seedProject();
    roots.push(root);
    const { exitCode } = runDeftTs("session:start", ["--project-root", root, "--no-history"]);
    expect(exitCode).toBe(0);
    expect(existsSync(join(root, ".deft", "ritual-state.json"))).toBe(true);
  });

  it("verify:session-ritual quick tier passes after native session:start", () => {
    const root = seedProject({ sessionRitualStalenessHours: 4 });
    roots.push(root);
    const start = runDeftTs("session:start", ["--project-root", root, "--no-history"]);
    expect(start.exitCode).toBe(0);
    const verify = runDeftTs("verify:session-ritual", ["--project-root", root, "--tier=quick"]);
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout + verify.stderr).toMatch(/session ritual/i);
  });
});

describe("verify session ritual TS module (maps tests/cli/test_verify_session_ritual.py)", () => {
  it("fails closed when ritual state is missing at gated mutation boundary", () => {
    const root = seedProject();
    roots.push(root);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = verifySessionRitual(root, {
      tier: "gated",
      bypass: false,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("deft session:start");
  });

  it("passes without ritual state in read-only quick posture (#2180)", () => {
    const root = seedProject();
    roots.push(root);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = verifySessionRitual(root, {
      tier: "quick",
      posture: "read-only",
      bypass: false,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("read-only posture");
  });
});

describe("deft-ts resume sentinel (maps tests/cli/test_resume.py — core unit coverage)", () => {
  it("framework resume commands are registered", () => {
    const { exitCode, stdout } = runDeftTs("", ["commands"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("build");
  });
});
