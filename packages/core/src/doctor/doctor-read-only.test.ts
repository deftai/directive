/**
 * Doctor is read-only and honest after an upgrade (AC12.1, #6622, #5967
 * items 1–3, #6618 Part C): `--fix` / `--repair` / `--repair-taskfile` never
 * write the Taskfile, the runtime Taskfile include is recognised, ignore-line
 * advice names what setup actually writes, and pnpm's own dangling links are
 * a warning.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIRECTIVE_GITIGNORE_LINES } from "../install-health/owned-paths.js";
import {
  checkDanglingNodeModulesLinks,
  checkGitignoreCoverage,
  checkPrePrSecretTracked,
  isDoctorAdvisoryFail,
} from "./checks.js";
import {
  recoveryLadderFields,
  recoveryLadderProse,
  TASKFILE_INCLUDE_SNIPPET,
} from "./constants.js";
import { cmdDoctor } from "./main.js";
import { classifyTaskfileInclude, formatMissingIncludeSnippet } from "./taskfile.js";

const TEMPS: string[] = [];
afterEach(() => {
  while (TEMPS.length > 0) {
    const t = TEMPS.pop();
    if (t) rmSync(t, { recursive: true, force: true });
  }
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-honesty-"));
  TEMPS.push(dir);
  return dir;
}

describe("doctor --fix writes no Taskfile (AC12.1, #6622)", () => {
  for (const flag of ["--fix", "--repair", "--repair-taskfile"]) {
    it(`${flag} on a project with no Taskfile.yml leaves it missing`, () => {
      const root = temp();
      const writeText = vi.fn();
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        cmdDoctor([flag, "--full", "--project-root", root], {
          whichFn: () => "/bin/x",
          isTty: () => true,
          readYn: () => true,
          writeText,
        });
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      expect(writeText).not.toHaveBeenCalled();
      expect(existsSync(join(root, "Taskfile.yml"))).toBe(false);
    });
  }
});

function pinned(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", devDependencies: { "@deftai/directive-runtime": "1.2.3" } })}\n`,
  );
}

function taskfile(root: string, target: string): void {
  writeFileSync(
    join(root, "Taskfile.yml"),
    `version: '3'\n\nincludes:\n  deft:\n    taskfile: ${target}\n    optional: true\n`,
  );
}

describe("Taskfile include (#5967 item 1)", () => {
  it("accepts the runtime include setup writes", () => {
    const root = temp();
    taskfile(root, "./node_modules/@deftai/directive-runtime/Taskfile.yml");
    expect(classifyTaskfileInclude(root)).toBe("ok");
  });

  it("reports a .deft/core or deft/ include as legacy, not ok", () => {
    const root = temp();
    taskfile(root, "./.deft/core/Taskfile.yml");
    expect(classifyTaskfileInclude(root)).toBe("legacy-include");
    taskfile(root, "./deft/Taskfile.yml");
    expect(classifyTaskfileInclude(root)).toBe("legacy-include");
  });

  it("snippets teach the runtime include and never .deft/core", () => {
    for (const text of [TASKFILE_INCLUDE_SNIPPET, formatMissingIncludeSnippet()]) {
      expect(text).toContain("node_modules/@deftai/directive-runtime/Taskfile.yml");
      expect(text).not.toContain(".deft/core");
    }
  });
});

describe("recovery ladder (AC9.7)", () => {
  it("never names the global install + repair pair", () => {
    for (const primary of ["agents-refresh", "update"] as const) {
      const prose = recoveryLadderProse(primary);
      expect(prose).not.toContain("npm i -g @deftai/directive, then");
      expect(prose).toContain("`npm install` (or `pnpm install --frozen-lockfile`)");
      expect(prose).toContain("Wiring: `directive install --repair`");
      expect(recoveryLadderFields(primary).suggested_fix_npx).not.toContain("npm i -g");
    }
  });
});

describe("gitignore coverage (#5967 item 2 / #6618 Part C)", () => {
  it("with a runtime pin and only the AC8.5 lines, passes", () => {
    const root = temp();
    pinned(root);
    writeFileSync(join(root, ".gitignore"), `${DIRECTIVE_GITIGNORE_LINES.join("\n")}\n`);
    const result = checkGitignoreCoverage(root);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("Information:");
  });

  it("names install --repair for a missing AC8.5 line, never update or --allow-dirty-no-stage", () => {
    const root = temp();
    pinned(root);
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    const result = checkGitignoreCoverage(root);
    expect(result.status).toBe("fail");
    expect(isDoctorAdvisoryFail(result.name, result.data)).toBe(true);
    expect(result.detail).toContain("Run `directive install --repair` to add them.");
    expect(result.detail).toContain(".deft/pre-pr-execution-private/");
    expect(result.detail).not.toContain("node_modules/,");
    expect(result.detail).not.toMatch(/directive update|allow-dirty-no-stage/);
    expect(JSON.stringify(result.data)).not.toMatch(/directive update|allow-dirty-no-stage/);
    expect(result.data?.suggested_fix).toBe("directive install --repair");
  });

  it("old-layout project (no runtime pin) names directive upgrade", () => {
    const root = temp();
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    const result = checkGitignoreCoverage(root);
    expect(result.status).toBe("fail");
    expect(result.data?.suggested_fix).toBe("directive upgrade");
    expect(result.detail).not.toMatch(/directive update|allow-dirty-no-stage/);
  });

  it("tracked pre-PR secret advice names repair, not update", () => {
    const result = checkPrePrSecretTracked("/tmp/x", { isPathTracked: () => true });
    expect(result.detail).toContain("directive install --repair");
    expect(result.detail).not.toMatch(/directive update|allow-dirty-no-stage/);
  });
});

describe("dangling node_modules links (#5967 item 3)", () => {
  it("a dangling link under node_modules/.pnpm/node_modules is a warning", () => {
    const root = temp();
    const dir = join(root, "node_modules", ".pnpm", "node_modules");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(root, "nowhere"), join(dir, "foo"), "junction");
    const result = checkDanglingNodeModulesLinks(root, { packageManager: "pnpm" });
    expect(result.status).toBe("fail");
    expect(isDoctorAdvisoryFail(result.name, result.data)).toBe(true);
    expect(result.detail).not.toContain("Broken install");
  });

  it("a dangling Directive package link still fails", () => {
    const root = temp();
    const dir = join(root, "node_modules", "@deftai");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(root, "nowhere"), join(dir, "directive-runtime"), "junction");
    const result = checkDanglingNodeModulesLinks(root, { packageManager: "pnpm" });
    expect(result.status).toBe("fail");
    expect(isDoctorAdvisoryFail(result.name, result.data)).toBe(false);
    expect(result.detail).toContain("Broken install");
  });
});
