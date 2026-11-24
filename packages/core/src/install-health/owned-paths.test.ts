/**
 * Read-only ownership API (#6615 / AC11.10): listDirectiveOwnedPaths and
 * classifyDirectiveOwnedChange. Fixtures only.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyDirectiveOwnedChange,
  DIRECTIVE_GITIGNORE_DEFT_BLOCK_START,
  DIRECTIVE_GITIGNORE_LINES,
  directiveGitignoreOrderedBlock,
  directiveOwnedPathMatches,
  gitignoreOrderedPrefixLength,
  inspectDirectiveOwnedPaths,
  isDirectiveHookCommand,
  listDirectiveOwnedPaths,
  MINIMAL_TASKFILE,
} from "./owned-paths.js";
import { MANAGED_SECTION_CLOSE } from "./ownership.js";

const temps: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-owned-paths-"));
  temps.push(root);
  return root;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      chmodSync(dir, 0o755);
      chmodSync(join(dir, ".deft"), 0o755);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeRecord(root: string, ownership: unknown[]): void {
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "GENERATION.json"),
    `${JSON.stringify(
      { schemaVersion: 1, runtimeVersion: "0.130.0", packageManager: "npm", ownership },
      null,
      2,
    )}\n`,
  );
}

function covers(root: string, rel: string): boolean {
  return listDirectiveOwnedPaths(root).some((p) => directiveOwnedPathMatches(p, rel));
}

const OUTER = (dir: string, sha = "1a2b3c4d") => `${dir}/deft-hook-${sha}.mjs`;
const outerCmd = (dir: string, host: string, event: string) =>
  `node ${OUTER(dir)} --host ${host} --event ${event}`;

const MANAGED = `<!-- deft:managed-section v2 sha=abc refreshed=x session=y -->\nmanaged body\n${MANAGED_SECTION_CLOSE}`;

describe("listDirectiveOwnedPaths (AC2 / AC5)", () => {
  it("lists every Directive path class, readiness markers not committed", () => {
    const root = tempProject();
    const paths = listDirectiveOwnedPaths(root);
    for (const rel of [
      OUTER(".claude"),
      OUTER(".codex"),
      OUTER(".cursor/hooks"),
      OUTER(".grok/hooks"),
      ".claude/settings.json",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".grok/hooks/deft.json",
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".githooks/_directive-run.sh",
      ".deft/GENERATION.json",
      ".deft/directive/data-schema.json",
      "AGENTS.md",
      ".claude/skills/deft-directive-build/SKILL.md",
      ".agents/skills/deft/SKILL.md",
      ".gitignore",
      ".gitattributes",
      ".prettierignore",
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "Taskfile.yml",
    ]) {
      expect(covers(root, rel), rel).toBe(true);
    }
    const kinds = new Map(paths.filter((p) => !p.pattern).map((p) => [p.path, p.kind]));
    expect(kinds.get("AGENTS.md")).toBe("marked-section");
    expect(kinds.get(".gitignore")).toBe("managed-lines");
    expect(kinds.get("package.json")).toBe("dependency-entry");
    expect(kinds.get(".claude/settings.json")).toBe("structured-entry");
    const readiness = paths.find((p) =>
      directiveOwnedPathMatches(p, ".deft/directive/wiring-ready.0.130.0.json"),
    );
    expect(readiness?.mustCommit).toBe(false);
    expect(paths.filter((p) => !p.mustCommit)).toHaveLength(1);
    expect(paths.some((p) => p.path.includes("pnpm-workspace"))).toBe(false);
    expect(covers(root, ".cursor/hooks/consumer-custom.mjs")).toBe(false);
    expect(covers(root, "src/app.ts")).toBe(false);
  });

  it("lists slash wrappers from the managed inventory", () => {
    const root = tempProject();
    const slash = listDirectiveOwnedPaths(root).filter((p) => p.path.includes("/commands/"));
    expect(slash.length).toBeGreaterThan(0);
  });

  it("reads record entries and ignores ones outside the known classes", () => {
    const root = tempProject();
    writeRecord(root, [
      { path: ".claude/deft-hook-1a2b3c4d.mjs", kind: "whole-file", fingerprint: "f" },
      { path: "src/app.ts", kind: "whole-file", fingerprint: "f" },
      { path: "AGENTS.md", kind: "whole-file", fingerprint: "f" },
      { path: "xbrief", kind: "retained", fingerprint: "f" },
    ]);
    const inspection = inspectDirectiveOwnedPaths(root);
    expect(inspection.record).toBe("valid");
    expect(inspection.paths.some((p) => p.path === "src/app.ts")).toBe(false);
    expect(inspection.paths.find((p) => p.path === ".claude/deft-hook-1a2b3c4d.mjs")?.source).toBe(
      "record",
    );
    expect(inspection.paths.find((p) => p.path === "AGENTS.md")?.kind).toBe("marked-section");
    expect(inspection.ignoredRecordEntries).toEqual([
      { path: "src/app.ts", kind: "whole-file", reason: "outside-known-classes" },
      { path: "AGENTS.md", kind: "whole-file", reason: "kind-mismatch" },
    ]);
    expect(classifyDirectiveOwnedChange("src/app.ts", "a", "b")).toBe("not-owned");
  });

  it("an unreadable record adds nothing and is reported", () => {
    const root = tempProject();
    writeRecord(root, [{ path: "x", kind: "managed-lines", fingerprint: "f" }]);
    const inspection = inspectDirectiveOwnedPaths(root);
    expect(inspection.record).toBe("unreadable");
    expect(inspection.paths.every((p) => p.source === "known")).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "performs no writes (AC3): works on a read-only project directory",
    () => {
      const root = tempProject();
      writeRecord(root, [{ path: ".githooks/pre-commit", kind: "whole-file", fingerprint: "f" }]);
      chmodSync(join(root, ".deft"), 0o555);
      chmodSync(root, 0o555);
      const before = readdirSync(root).concat(readdirSync(join(root, ".deft")));
      expect(listDirectiveOwnedPaths(root).length).toBeGreaterThan(0);
      expect(classifyDirectiveOwnedChange("AGENTS.md", null, MANAGED)).toBe("directive-only");
      expect(readdirSync(root).concat(readdirSync(join(root, ".deft")))).toEqual(before);
    },
  );
});

describe("classifyDirectiveOwnedChange (AC4)", () => {
  it("whole files and the .mjs outer pass on path alone", () => {
    expect(classifyDirectiveOwnedChange(OUTER(".claude"), null, "x")).toBe("directive-only");
    expect(classifyDirectiveOwnedChange(OUTER(".grok/hooks", "00000000"), "old", null)).toBe(
      "directive-only",
    );
    expect(classifyDirectiveOwnedChange(".githooks/pre-push", "a", "b")).toBe("directive-only");
    expect(classifyDirectiveOwnedChange(".deft\\GENERATION.json", "a", "b")).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange(".deft/directive/wiring-ready.1.0.0.json", null, "{}"),
    ).toBe("directive-only");
    expect(classifyDirectiveOwnedChange(".cursor/hooks/consumer-custom.mjs", null, "x")).toBe(
      "not-owned",
    );
    expect(classifyDirectiveOwnedChange("src/deft-hook-1a2b3c4d.mjs", null, "x")).toBe("not-owned");
  });

  it("retired files pass only when deleted; retained data is not owned", () => {
    expect(classifyDirectiveOwnedChange(".grok/hooks/deft-pretooluse-wrapper.sh", "x", null)).toBe(
      "directive-only",
    );
    expect(classifyDirectiveOwnedChange(".githooks/_deft-run.sh", null, "x")).toBe("mixed");
    expect(classifyDirectiveOwnedChange(".deft-version", "1", "2")).toBe("mixed");
    expect(classifyDirectiveOwnedChange("xbrief", "a", "b")).toBe("not-owned");
    expect(classifyDirectiveOwnedChange(".deft/settings.json", "a", "b")).toBe("not-owned");
    expect(classifyDirectiveOwnedChange(".deft/hook-gate-off.json", null, "{}")).toBe("not-owned");
  });

  it("AGENTS.md: managed block changes only vs user edits outside the block", () => {
    const before = `# My project\n\nHello.\n\n${MANAGED}\n`;
    const refreshed = before.replace("managed body", "new managed body");
    expect(classifyDirectiveOwnedChange("AGENTS.md", before, refreshed)).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange("AGENTS.md", before, refreshed.replace("Hello.", "Hi!")),
    ).toBe("mixed");
    expect(classifyDirectiveOwnedChange("AGENTS.md", "# Mine\n", `# Mine\n\n${MANAGED}\n`)).toBe(
      "directive-only",
    );
    expect(classifyDirectiveOwnedChange("AGENTS.md", null, `${MANAGED}\n`)).toBe("directive-only");
    expect(classifyDirectiveOwnedChange("AGENTS.md", null, `# Mine\n\n${MANAGED}\n`)).toBe("mixed");
  });

  it("AGENTS.md: a new file with setup's scaffold header is Directive-only (#5771)", () => {
    const header = [
      "# Project",
      "",
      "One-line project description (edit me).",
      "",
      "## Session orientation",
      "",
      "Scoped work → `xbrief/` lifecycle; ranked queue → `deft triage:queue`; tracked bugs → GitHub issues; identity → `xbrief/PROJECT-DEFINITION.xbrief.json`.",
    ].join("\n");
    expect(classifyDirectiveOwnedChange("AGENTS.md", null, `${header}\n\n${MANAGED}\n`)).toBe(
      "directive-only",
    );
  });

  it("host configs: Directive hooks only vs a user hook added", () => {
    const directive = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: outerCmd(".claude", "claude", "tool.before") }],
          },
        ],
      },
    };
    const userOnly = { permissions: { allow: ["Read"] } };
    const before = JSON.stringify(userOnly);
    const after = JSON.stringify({ ...userOnly, ...directive });
    expect(classifyDirectiveOwnedChange(".claude/settings.json", before, after)).toBe(
      "directive-only",
    );
    expect(
      classifyDirectiveOwnedChange(".claude/settings.json", null, JSON.stringify(directive)),
    ).toBe("directive-only");
    const withUserHook = {
      ...userOnly,
      hooks: {
        PreToolUse: [
          ...directive.hooks.PreToolUse,
          { matcher: "Edit", hooks: [{ type: "command", command: "node scripts/mine.mjs" }] },
        ],
      },
    };
    expect(
      classifyDirectiveOwnedChange(".claude/settings.json", before, JSON.stringify(withUserHook)),
    ).toBe("mixed");
    // A user command slipped into a Directive group still counts.
    const smuggled = structuredClone(directive);
    smuggled.hooks.PreToolUse[0]?.hooks.push({ type: "command", command: "curl evil" });
    expect(
      classifyDirectiveOwnedChange(
        ".claude/settings.json",
        before,
        JSON.stringify({ ...userOnly, ...smuggled }),
      ),
    ).toBe("mixed");
    expect(classifyDirectiveOwnedChange(".claude/settings.json", before, "{not json")).toBe(
      "mixed",
    );
  });

  it("host configs: Cursor flat entries and the version key; legacy forms migrate", () => {
    const legacy = {
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor" },
        ],
      },
    };
    const current = {
      version: 1,
      hooks: { beforeShellExecution: [{ command: outerCmd(".cursor/hooks", "cursor", "shell") }] },
    };
    expect(
      classifyDirectiveOwnedChange(
        ".cursor/hooks.json",
        JSON.stringify(legacy),
        JSON.stringify(current),
      ),
    ).toBe("directive-only");
    expect(classifyDirectiveOwnedChange(".cursor/hooks.json", null, JSON.stringify(current))).toBe(
      "directive-only",
    );
    const userRunsOuterElsewhere = {
      version: 1,
      hooks: { beforeShellExecution: [{ command: "node src/deft-hook-1a2b3c4d.mjs" }] },
    };
    expect(
      classifyDirectiveOwnedChange(
        ".cursor/hooks.json",
        null,
        JSON.stringify(userRunsOuterElsewhere),
      ),
    ).toBe("mixed");
  });

  it("isDirectiveHookCommand recognises Directive forms only", () => {
    expect(isDirectiveHookCommand(outerCmd(".grok/hooks", "grok", "tool.before"))).toBe(true);
    expect(isDirectiveHookCommand("deft-hook --host claude --event x")).toBe(true);
    expect(isDirectiveHookCommand("deft hook:dispatch --host claude")).toBe(true);
    expect(isDirectiveHookCommand("./.grok/hooks/deft-pretooluse-wrapper.sh")).toBe(true);
    expect(isDirectiveHookCommand("echo deft-hook")).toBe(false);
    expect(isDirectiveHookCommand("node scripts/hook-bin.js")).toBe(false);
  });

  it("Taskfile.yml: deft include only vs other changes; new minimal file", () => {
    const before = "version: '3'\n\ntasks:\n  build:\n    cmds: [make]\n";
    const appended = `${before}\n# Added by Directive setup (Wave 2c)\nincludes:\n  deft:\n    taskfile: ./node_modules/@deftai/directive-runtime/Taskfile.yml\n    optional: true\n`;
    expect(classifyDirectiveOwnedChange("Taskfile.yml", before, appended)).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange("Taskfile.yml", before, appended.replace("make", "make all")),
    ).toBe("mixed");
    expect(classifyDirectiveOwnedChange("Taskfile.yml", null, MINIMAL_TASKFILE)).toBe(
      "directive-only",
    );
    const legacy =
      "version: '3'\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n";
    expect(
      classifyDirectiveOwnedChange(
        "Taskfile.yml",
        legacy,
        legacy.replace(".deft/core/", "node_modules/@deftai/directive-runtime/"),
      ),
    ).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange("Taskfile.yml", null, `${MINIMAL_TASKFILE}tasks: {}\n`),
    ).toBe("mixed");
  });

  it("gitignore block: `.deft/*` first, `!` lines after it, temp ignores after their folder (#6795)", () => {
    const block = directiveGitignoreOrderedBlock();
    expect(block[0]).toBe(DIRECTIVE_GITIGNORE_DEFT_BLOCK_START);
    for (const kept of [
      "!.deft/plan-sequence.json",
      "!.deft/GENERATION.json",
      "!.deft/approved-scope/",
      "!.deft/approved-scope/**",
      "!.deft/intent-constraint/",
      "!.deft/intent-constraint/**",
    ]) {
      expect(block.indexOf(kept)).toBeGreaterThan(0);
    }
    expect(block.indexOf(".deft/approved-scope/*.bak")).toBeGreaterThan(
      block.indexOf("!.deft/approved-scope/**"),
    );
    expect(block.indexOf(".deft/intent-constraint/*.next.tmp")).toBeGreaterThan(
      block.indexOf("!.deft/intent-constraint/**"),
    );
    expect(DIRECTIVE_GITIGNORE_LINES).toContain(".deft-cache/");
    expect(block).not.toContain(".deft-cache/");
  });

  it("gitignore block: `.deft/directive/` kept trackable, wiring-ready re-ignored after it (#6842)", () => {
    const block = directiveGitignoreOrderedBlock();
    // The new lines close the block, so a 0.130.1 file gets only them appended.
    expect(block.slice(-3)).toEqual([
      "!.deft/directive/",
      "!.deft/directive/**",
      ".deft/directive/wiring-ready.*.json",
    ]);
    // One copy only: an earlier copy before `.deft/*` would not apply.
    expect(
      DIRECTIVE_GITIGNORE_LINES.filter((l) => l === ".deft/directive/wiring-ready.*.json"),
    ).toHaveLength(1);
    expect(
      classifyDirectiveOwnedChange(
        ".gitignore",
        "dist/\n",
        "dist/\n!.deft/directive/\n!.deft/directive/**\n.deft/directive/wiring-ready.*.json\n",
      ),
    ).toBe("directive-only");
  });

  it("gitignoreOrderedPrefixLength stops at the first missing or out-of-order line (#6795)", () => {
    const block = [".deft/*", "!a", "!b"];
    expect(gitignoreOrderedPrefixLength([], block)).toBe(0);
    expect(gitignoreOrderedPrefixLength(["x", ".deft/*", "y", "!a", "!b"], block)).toBe(3);
    expect(gitignoreOrderedPrefixLength(["!a", ".deft/*", "!b"], block)).toBe(1);
    expect(gitignoreOrderedPrefixLength([".deft/*", "!b"], block)).toBe(1);
  });

  it("managed lines: the `!` lines and `.deft/*` are Directive lines for uninstall (#6795)", () => {
    expect(
      classifyDirectiveOwnedChange(
        ".gitignore",
        "dist/\n",
        "dist/\n.deft/*\n!.deft/approved-scope/\n!.deft/approved-scope/**\n.deft-cache/\n",
      ),
    ).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange(".gitignore", "dist/\n", "dist/\n!.deft/my-own-file.json\n"),
    ).toBe("mixed");
  });

  it("managed lines: .gitignore / .gitattributes / .prettierignore", () => {
    expect(
      classifyDirectiveOwnedChange(
        ".gitignore",
        "dist/\n",
        `dist/\n${DIRECTIVE_GITIGNORE_LINES.join("\n")}\n`,
      ),
    ).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange(
        ".gitignore",
        null,
        `${DIRECTIVE_GITIGNORE_LINES.join("\r\n")}\r\n`,
      ),
    ).toBe("directive-only");
    expect(classifyDirectiveOwnedChange(".gitignore", "dist/\n", "dist/\n.env\n")).toBe("mixed");
    const attrsBefore = "*.png binary\n.deft/core/** text eol=lf\n";
    const attrsAfter =
      "*.png binary\n\n# Deft managed wiring: pin Directive-deposited host/command/hook/skill paths\n# to LF so Windows core.autocrlf checkouts stay ownership-comparable (#5995).\n.githooks/** text=auto eol=lf\nAGENTS.md text=auto eol=lf\n";
    expect(classifyDirectiveOwnedChange(".gitattributes", attrsBefore, attrsAfter)).toBe(
      "directive-only",
    );
    expect(
      classifyDirectiveOwnedChange(".gitattributes", attrsBefore, `${attrsAfter}*.md -diff\n`),
    ).toBe("mixed");
    expect(classifyDirectiveOwnedChange(".prettierignore", null, ".deft/core/\n")).toBe(
      "directive-only",
    );
  });

  it("managed lines: removing retired .deft/core lines and adding the hook-file line are Directive-only (#5961 / #6167)", () => {
    const oldBlock =
      "*.png binary\n# Deft framework: the vendored payload is packaged framework code, not\n# consumer source. text=auto + eol=lf normalizes text only; binaries keep\n# byte identity. Mark generated + vendored (#1430, #2118, #5245).\n.deft/core/** text=auto eol=lf\n.deft/core/** linguist-vendored=true\n.githooks/** text=auto eol=lf\n";
    const stripped =
      "*.png binary\n# Deft managed wiring: pin Directive-deposited host/command/hook/skill paths\n# to LF so Windows core.autocrlf checkouts stay ownership-comparable (#5995).\n.githooks/** text=auto eol=lf\n.claude/deft-hook-*.mjs text=auto eol=lf\n";
    expect(classifyDirectiveOwnedChange(".gitattributes", oldBlock, stripped)).toBe(
      "directive-only",
    );
    expect(
      classifyDirectiveOwnedChange(
        ".prettierignore",
        "dist/\n\n# Deft framework: the vendored payload is outside the consumer Prettier gate (#2534).\n.deft/core/\n",
        "dist/\n\n# Deft managed wiring: Directive's committed hook files are not formatted (AC13.3).\n**/deft-hook-*.mjs\n",
      ),
    ).toBe("directive-only");
    expect(classifyDirectiveOwnedChange(".prettierignore", "dist/\n", "build/\n")).toBe("mixed");
  });

  it("package.json: new from install, pin bump, extra user script", () => {
    const fresh = JSON.stringify(
      { private: true, devDependencies: { "@deftai/directive-runtime": "0.130.0" } },
      null,
      2,
    );
    expect(classifyDirectiveOwnedChange("package.json", null, fresh)).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange(
        "package.json",
        null,
        JSON.stringify({ devDependencies: { "@deftai/directive-runtime": "0.130.0" } }),
      ),
    ).toBe("directive-only");
    const base = { name: "app", scripts: { test: "vitest" }, dependencies: { lodash: "4" } };
    const withPin = { ...base, devDependencies: { "@deftai/directive-runtime": "0.130.0" } };
    expect(
      classifyDirectiveOwnedChange("package.json", JSON.stringify(base), JSON.stringify(withPin)),
    ).toBe("directive-only");
    const bumped = { ...base, devDependencies: { "@deftai/directive-runtime": "0.131.0" } };
    expect(
      classifyDirectiveOwnedChange("package.json", JSON.stringify(withPin), JSON.stringify(bumped)),
    ).toBe("directive-only");
    const extraScript = { ...bumped, scripts: { ...base.scripts, lint: "biome check" } };
    expect(
      classifyDirectiveOwnedChange(
        "package.json",
        JSON.stringify(withPin),
        JSON.stringify(extraScript),
      ),
    ).toBe("mixed");
    expect(classifyDirectiveOwnedChange("package.json", null, JSON.stringify({ name: "x" }))).toBe(
      "mixed",
    );
    expect(classifyDirectiveOwnedChange("package.json", "{", "{}")).toBe("mixed");
  });

  it("pnpm-lock.yaml: pin follow-through vs a user dependency", () => {
    const lock = (runtime: string) =>
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      lodash:",
        "        specifier: ^4.17.21",
        "        version: 4.17.21",
        "    devDependencies:",
        "      '@deftai/directive-runtime':",
        `        specifier: ${runtime}`,
        `        version: ${runtime}`,
        "",
        "packages:",
        "",
        "  lodash@4.17.21:",
        "    resolution: {integrity: sha512-abc}",
        "",
        `  '@deftai/directive-runtime@${runtime}':`,
        "    resolution: {integrity: sha512-def}",
        "",
      ].join("\n");
    expect(classifyDirectiveOwnedChange("pnpm-lock.yaml", lock("0.130.0"), lock("0.131.0"))).toBe(
      "directive-only",
    );
    const userDep = lock("0.131.0").replace(
      "    devDependencies:",
      "      zod:\n        specifier: ^3.0.0\n        version: 3.0.0\n    devDependencies:",
    );
    expect(classifyDirectiveOwnedChange("pnpm-lock.yaml", lock("0.130.0"), userDep)).toBe("mixed");
  });

  it("new lockfiles hold only the Directive pin (#5771 first install)", () => {
    const npmLock = JSON.stringify({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { "@deftai/directive-runtime": "0.130.0" } },
        "node_modules/@deftai/directive-runtime": { version: "0.130.0" },
      },
    });
    expect(classifyDirectiveOwnedChange("package-lock.json", null, npmLock)).toBe("directive-only");
    const npmLockWithUser = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { lodash: "4" } } },
    });
    expect(classifyDirectiveOwnedChange("package-lock.json", null, npmLockWithUser)).toBe("mixed");
    const pnpmNew = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      '@deftai/directive-runtime':",
      "        specifier: 0.130.0",
      "        version: 0.130.0",
      "",
    ].join("\n");
    expect(classifyDirectiveOwnedChange("pnpm-lock.yaml", null, pnpmNew)).toBe("directive-only");
  });

  it("managed lines: reordering user rules is a user change", () => {
    expect(
      classifyDirectiveOwnedChange(
        ".gitignore",
        "*.log\n!important.log\n",
        "!important.log\n*.log\n",
      ),
    ).toBe("mixed");
  });

  it("Taskfile.yml: a user tasks.deft or a custom includes.deft target is not Directive's", () => {
    const userTask = "version: '3'\ntasks:\n  deft:\n    cmds: [echo one]\n";
    expect(
      classifyDirectiveOwnedChange("Taskfile.yml", userTask, userTask.replace("one", "two")),
    ).toBe("mixed");
    const custom = "version: '3'\nincludes:\n  deft:\n    taskfile: ./my/Taskfile.yml\n";
    expect(
      classifyDirectiveOwnedChange("Taskfile.yml", custom, custom.replace("./my/", "./other/")),
    ).toBe("mixed");
  });

  it("host configs: a Directive command chained with a user command is not Directive's", () => {
    const entry = (command: string) =>
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } });
    const plain = outerCmd(".claude", "claude", "tool.before");
    expect(isDirectiveHookCommand(`${plain} && node scripts/check.mjs`)).toBe(false);
    expect(isDirectiveHookCommand(`${plain}; curl evil`)).toBe(false);
    expect(isDirectiveHookCommand(`${plain}\nnode scripts/check.mjs`)).toBe(false);
    expect(isDirectiveHookCommand(`${plain}\r\nrm -rf x`)).toBe(false);
    expect(isDirectiveHookCommand(`${plain} rm -rf x`)).toBe(false);
    expect(
      classifyDirectiveOwnedChange(
        ".claude/settings.json",
        entry(`${plain} && node scripts/a.mjs`),
        entry(`${plain} && node scripts/b.mjs`),
      ),
    ).toBe("mixed");
  });

  it("package-lock.json: an app version change is not Directive's", () => {
    const lock = (appVersion: string, runtime: string) =>
      JSON.stringify({
        name: "app",
        version: appVersion,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "app",
            version: appVersion,
            devDependencies: { "@deftai/directive-runtime": runtime },
          },
          "node_modules/@deftai/directive-runtime": { version: runtime },
        },
      });
    expect(
      classifyDirectiveOwnedChange(
        "package-lock.json",
        lock("1.0.0", "0.130.0"),
        lock("1.0.0", "0.131.0"),
      ),
    ).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange(
        "package-lock.json",
        lock("1.0.0", "0.130.0"),
        lock("1.1.0", "0.130.0"),
      ),
    ).toBe("mixed");
  });

  it("package-lock.json: a folder-derived top-level name is not the app's (#7233)", () => {
    const lock = (
      folder: string,
      runtime: string,
      app?: { readonly name?: string; readonly version?: string },
    ) =>
      JSON.stringify({
        name: folder,
        ...(app?.version === undefined ? {} : { version: app.version }),
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            ...(app?.name === undefined ? {} : { name: app.name }),
            ...(app?.version === undefined ? {} : { version: app.version }),
            devDependencies: { "@deftai/directive-runtime": runtime },
          },
          "node_modules/@deftai/directive-runtime": { version: runtime },
        },
      });
    expect(
      classifyDirectiveOwnedChange(
        "package-lock.json",
        lock("consumer", "0.131.3"),
        lock("consumer-worktree", "0.131.4"),
      ),
    ).toBe("directive-only");
    expect(
      classifyDirectiveOwnedChange(
        "package-lock.json",
        lock("app", "0.131.3", { name: "app" }),
        lock("renamed", "0.131.4", { name: "renamed" }),
      ),
    ).toBe("mixed");
    expect(
      classifyDirectiveOwnedChange(
        "package-lock.json",
        lock("consumer", "0.131.3", { version: "1.0.0" }),
        lock("consumer-worktree", "0.131.4", { version: "1.1.0" }),
      ),
    ).toBe("mixed");
    const v1 = (name: string) =>
      JSON.stringify({
        name,
        lockfileVersion: 1,
        dependencies: { "@deftai/directive-runtime": { version: "0.131.3" } },
      });
    expect(classifyDirectiveOwnedChange("package-lock.json", v1("app"), v1("renamed"))).toBe(
      "mixed",
    );
  });

  it("unknown paths are not owned", () => {
    expect(classifyDirectiveOwnedChange("README.md", "a", "b")).toBe("not-owned");
    expect(classifyDirectiveOwnedChange("pnpm-workspace.yaml", "a", "b")).toBe("not-owned");
  });
});
