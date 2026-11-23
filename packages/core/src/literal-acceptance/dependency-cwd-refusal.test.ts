/**
 * Dependency and dot-folder refusals for the acceptance cwd and npm --prefix (#7223).
 *
 * Acceptance commands run only from the repository's own directories. The
 * grammar refuses a `node_modules` or leading-dot segment in the record cwd and
 * in an npm `--prefix` value; run time refuses a real path with a `node_modules`
 * segment below the project root, for the cwd and the `--prefix` directory.
 * Every case uses fixture paths and a runner that must not be called.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatAcceptanceActivationWarnings,
  resolveAcceptanceCommandRecords,
} from "../product-first-done-gate/evaluate.js";
import {
  evaluateAcceptanceCwdContainment,
  runLiteralAcceptanceCommand,
  runLiteralAcceptanceCommands,
} from "./run.js";
import {
  ACCEPTANCE_CWD_DEPENDENCY_REFUSAL_ID,
  dependencyOrDotSegment,
  evaluateAcceptanceCwdGrammar,
  evaluateCommandSafety,
} from "./safety.js";

const never = (): never => {
  throw new Error("runner must not be called");
};

/** A fixture root with an installed-dependency folder and a junction into it. */
function rootWithDependencyLink(): string {
  const root = mkdtempSync(join(tmpdir(), "literal-ac-7223-"));
  mkdirSync(join(root, "web"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  symlinkSync(join(root, "node_modules", "pkg"), join(root, "linked"), "junction");
  return root;
}

describe("dependencyOrDotSegment (#7223)", () => {
  it("names the first node_modules or leading-dot segment", () => {
    expect(dependencyOrDotSegment("node_modules/pkg")).toBe("node_modules");
    expect(dependencyOrDotSegment("web/Node_Modules/pkg")).toBe("Node_Modules");
    expect(dependencyOrDotSegment("web\\node_modules\\pkg")).toBe("node_modules");
    expect(dependencyOrDotSegment(".cache/pkg")).toBe(".cache");
    expect(dependencyOrDotSegment("../web")).toBe("..");
    expect(dependencyOrDotSegment("web/.hidden")).toBe(".hidden");
  });

  it("passes the repository's own paths and a lone dot segment", () => {
    expect(dependencyOrDotSegment("web")).toBeNull();
    expect(dependencyOrDotSegment("packages/core")).toBeNull();
    expect(dependencyOrDotSegment("./web")).toBeNull();
    expect(dependencyOrDotSegment("my_node_modules_docs")).toBeNull();
  });
});

describe("record cwd grammar refusal (#7223)", () => {
  it("refuses a cwd with a node_modules or leading-dot segment", () => {
    for (const cwd of [
      "node_modules/pkg",
      "web/node_modules/pkg",
      ".cache",
      "web/.hidden",
      "../web",
    ]) {
      const verdict = evaluateAcceptanceCwdGrammar(cwd);
      expect(verdict.ok, cwd).toBe(false);
      expect(verdict.refused, cwd).toBe(true);
      expect(verdict.reason, cwd).toMatch(/never from installed dependencies/);
    }
  });

  it("keeps other cwds as they were: plain paths pass, other grammar misses only warn", () => {
    expect(evaluateAcceptanceCwdGrammar("web")).toEqual({ ok: true, reason: null });
    const warned = evaluateAcceptanceCwdGrammar("/abs/web");
    expect(warned.ok).toBe(false);
    expect(warned.refused).toBeUndefined();
  });

  it("blocks the record before any run and names the declared gate at activation", () => {
    const plan = {
      metadata: {
        literal_acceptance_commands: [
          {
            command: "npx vitest run src/app.test.ts",
            cwd: "node_modules/pkg",
            source: "explicit",
          },
        ],
      },
    };
    const records = resolveAcceptanceCommandRecords(plan);
    expect(records.commands).toHaveLength(0);
    expect(records.blocking).toHaveLength(1);
    expect(records.blocking[0]?.reason).toContain(
      `deft gate ${ACCEPTANCE_CWD_DEPENDENCY_REFUSAL_ID} `,
    );
    const lines = formatAcceptanceActivationWarnings(records);
    expect(lines.join("\n")).toContain(ACCEPTANCE_CWD_DEPENDENCY_REFUSAL_ID);
  });
});

describe("npm --prefix grammar refusal (#7223)", () => {
  it("refuses a --prefix value with a node_modules or leading-dot segment", () => {
    for (const command of [
      "npm test --prefix node_modules/pkg",
      "npm run check --prefix=node_modules/pkg -- --run",
      "npm test --prefix web/node_modules/pkg",
      "npm test --prefix .hidden",
      "npm test --prefix web/.cache",
    ]) {
      const verdict = evaluateCommandSafety(command);
      expect(verdict.ok, command).toBe(false);
      expect(verdict.reason, command).toMatch(/"--prefix" segment .* is refused/);
    }
  });

  it("still admits a --prefix inside the repository's own directories", () => {
    expect(evaluateCommandSafety("npm test --prefix web").ok).toBe(true);
    expect(evaluateCommandSafety("npm run check --prefix=packages/core -- --run").ok).toBe(true);
  });
});

describe("run-time real-path refusal (#7223)", () => {
  it("refuses a cwd whose real path is inside node_modules", () => {
    const root = rootWithDependencyLink();
    const direct = evaluateAcceptanceCwdContainment(root, join(root, "node_modules", "pkg"));
    expect(direct.ok).toBe(false);
    expect(direct.reason).toMatch(/inside installed dependencies/);
    const linked = evaluateAcceptanceCwdContainment(root, join(root, "linked"));
    expect(linked.ok).toBe(false);
    expect(linked.reason).toMatch(/inside installed dependencies/);
    expect(evaluateAcceptanceCwdContainment(root, join(root, "web")).ok).toBe(true);
  });

  it("does not count node_modules above the project root", () => {
    const parent = mkdtempSync(join(tmpdir(), "literal-ac-7223-parent-"));
    const root = join(parent, "node_modules", "repo");
    mkdirSync(join(root, "web"), { recursive: true });
    expect(evaluateAcceptanceCwdContainment(root, join(root, "web")).ok).toBe(true);
  });

  it("refuses a linked cwd into node_modules and spawns nothing", () => {
    const root = rootWithDependencyLink();
    const result = runLiteralAcceptanceCommands(
      [{ command: "npx vitest run src/app.test.ts", cwd: "linked", source: "explicit" }],
      { projectRoot: root, runner: never },
    );
    expect(result.code).toBe(2);
    expect(result.message).toContain("nothing was spawned");
    expect(result.runs[0]?.detail).toMatch(/inside installed dependencies/);
  });

  it("refuses a linked --prefix into node_modules in both runners", () => {
    const root = rootWithDependencyLink();
    const result = runLiteralAcceptanceCommands(
      [{ command: "npm test --prefix linked", source: "explicit" }],
      { projectRoot: root, runner: never },
    );
    expect(result.code).toBe(2);
    expect(result.runs[0]?.detail).toMatch(/--prefix "linked".*inside installed dependencies/);
    const single = runLiteralAcceptanceCommand(
      { command: "npm test --prefix linked", source: "explicit" },
      { projectRoot: root, runner: never },
    );
    expect(single.exitCode).toBe(2);
    expect(single.detail).toMatch(/--prefix "linked"/);
  });
});
