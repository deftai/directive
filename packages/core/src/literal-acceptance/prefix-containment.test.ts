/**
 * npm --prefix real-path containment at verify:ac (GHSA-mq3j-2229-p7xx).
 *
 * The grammar checks the --prefix spelling; run time checks its real path like
 * the record cwd, so a junction or symlink cannot move the run outside.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLiteralAcceptanceCommand, runLiteralAcceptanceCommands } from "./run.js";

const never = (): never => {
  throw new Error("runner must not be called");
};

function rootWithEscape(): string {
  const root = mkdtempSync(join(tmpdir(), "literal-ac-prefix-"));
  mkdirSync(join(root, "web"));
  const outside = mkdtempSync(join(tmpdir(), "literal-ac-prefix-target-"));
  symlinkSync(outside, join(root, "escape"), "junction");
  return root;
}

describe("npm --prefix containment (GHSA-mq3j-2229-p7xx)", () => {
  it("refuses a --prefix that resolves outside the repository and spawns nothing", () => {
    const root = rootWithEscape();
    for (const command of ["npm test --prefix escape", "npm run check --prefix=escape -- --run"]) {
      const result = runLiteralAcceptanceCommands([{ command, source: "explicit" }], {
        projectRoot: root,
        runner: never,
      });
      expect(result.code, command).toBe(2);
      expect(result.message, command).toContain("nothing was spawned");
      expect(result.runs[0]?.detail, command).toMatch(/--prefix "escape".*resolves outside/);
    }
  });

  it("refuses an escaping --prefix in the single-command runner too", () => {
    const root = rootWithEscape();
    const run = runLiteralAcceptanceCommand(
      { command: "npm test --prefix escape", source: "explicit" },
      { projectRoot: root, runner: never },
    );
    expect(run.exitCode).toBe(2);
    expect(run.detail).toMatch(/--prefix "escape"/);
  });

  it("resolves --prefix against the record cwd", () => {
    const root = rootWithEscape();
    mkdirSync(join(root, "web", "inner"));
    const ran: string[] = [];
    const result = runLiteralAcceptanceCommands(
      [{ command: "npm test --prefix inner", source: "explicit", cwd: "web" }],
      {
        projectRoot: root,
        runner: (input) => {
          ran.push(input.command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(ran).toEqual(["npm test --prefix inner"]);
  });

  it("refuses a missing --prefix directory", () => {
    const root = rootWithEscape();
    const result = runLiteralAcceptanceCommands(
      [{ command: "npm test --prefix missing", source: "explicit" }],
      { projectRoot: root, runner: never },
    );
    expect(result.code).toBe(2);
    expect(result.runs[0]?.detail).toMatch(/--prefix "missing".*missing or has no real path/);
  });
});
