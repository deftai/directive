import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifySessionRitual } from "@deftai/core/session";
import { afterAll, describe, expect, it } from "vitest";
import { runDeftTs, seedProject } from "./_helpers.js";

const roots: string[] = [];
afterAll(() => {
  roots.length = 0;
});

describe("deft-ts session:start (maps tests/cli/test_session_start.py)", () => {
  it("records quick-tier ritual state via framework-commands", () => {
    const root = seedProject({ sessionRitualStalenessHours: 4 });
    roots.push(root);
    const { exitCode, stdout } = runDeftTs("framework-commands", [
      "session:start",
      "--project-root",
      root,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Deft Directive active");
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
    const { exitCode } = runDeftTs("framework-commands", [
      "session:start",
      "--project-root",
      root,
      "--defer",
      "doctor=postponed",
    ]);
    expect(exitCode).toBe(0);
    const state = JSON.parse(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")) as {
      gated_steps: { doctor?: { deferred_reason?: string } };
    };
    expect(state.gated_steps.doctor?.deferred_reason).toBe("postponed");
  });
});

describe("verify session ritual TS module (maps tests/cli/test_verify_session_ritual.py)", () => {
  it("fails closed when ritual state is missing", () => {
    const root = seedProject();
    roots.push(root);
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    const result = verifySessionRitual(root, {
      bypass: false,
      runGit: (_r, args) => {
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
          return { code: 0, stdout: head, stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { code: 0, stdout: resolve(root), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
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
