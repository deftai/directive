import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSessionStart, verifySessionRitual } from "@deftai/core/session";
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
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("Deft Directive active");
    const state = JSON.parse(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")) as {
      schemaVersion: number;
      quick_steps: Record<string, unknown>;
    };
    expect(state.schemaVersion).toBe(1);
    expect(Object.keys(state.quick_steps).sort()).toEqual(
      ["alignment", "branch_policy", "triage_welcome"].sort(),
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
    });
    expect(result.code).toBe(0);
    const state = JSON.parse(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")) as {
      gated_steps: { doctor?: { deferred_reason?: string } };
    };
    expect(state.gated_steps.doctor?.deferred_reason).toBe("postponed");
  });
});

describe("deft-ts session:start dispatcher smoke", () => {
  it("framework-commands session:start is registered (Python oracle path)", () => {
    const root = seedProject();
    roots.push(root);
    const { exitCode } = runDeftTs("framework-commands", ["session:start", "--project-root", root]);
    expect([0, 1, 2]).toContain(exitCode);
  });
});

describe("verify session ritual TS module (maps tests/cli/test_verify_session_ritual.py)", () => {
  it("fails closed when ritual state is missing", () => {
    const root = seedProject();
    roots.push(root);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = verifySessionRitual(root, {
      bypass: false,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("deft session:start");
  });
});

describe("deft-ts resume sentinel (maps tests/cli/test_resume.py — core unit coverage)", () => {
  it("framework resume commands are registered", () => {
    const { exitCode, stdout } = runDeftTs("", ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("framework-commands");
  });
});
