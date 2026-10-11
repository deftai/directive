/**
 * Wave 2c package-relative wiring owner tests (R9 / AC13.1 / AC9.*).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALLATION_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import { runSetup } from "./setup.js";

const TEMPS: string[] = [];
const RUNTIME_PREFIX = "node_modules/@deftai/directive-runtime/";
const HOOK_BIN = `node ${RUNTIME_PREFIX}dist/hook-bin.js`;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-2c-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("runSetup package-relative wiring (Wave 2c / R9)", () => {
  it("AGENTS managed section references main.md + AC9.7 recovery", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain(`${RUNTIME_PREFIX}main.md`);
    expect(agents).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(agents).not.toContain(".deft/core/");
  });

  it("writes skill pointers under .agents/skills to runtime skills/ (AC9.6)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const skill = readFileSync(join(root, ".agents", "skills", "deft", "SKILL.md"), "utf8");
    expect(skill).toContain(RUNTIME_PREFIX);
    expect(skill).toContain("SKILL.md");
    expect(skill).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(skill).not.toContain(".deft/core/");
    expect(skill).not.toMatch(/\d+\.\d+\.\d+/); // no version in pointer
    const setupSkill = readFileSync(
      join(root, ".agents", "skills", "deft-directive-setup", "SKILL.md"),
      "utf8",
    );
    expect(setupSkill).toContain(`${RUNTIME_PREFIX}skills/deft-directive-setup/SKILL.md`);
  });

  it("writes host hooks as node …/hook-bin.js (AC9.1)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    for (const rel of [
      ".claude/settings.json",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".grok/hooks/deft.json",
    ]) {
      const body = readFileSync(join(root, rel), "utf8");
      expect(body).toContain(HOOK_BIN);
      expect(body).not.toMatch(/(^|[\s"`'])deft-hook([\s"`']|$)/);
    }
  });

  it("rewrites existing bare deft-hook entries (AC9.2)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "deft-hook --host claude --event session.start",
                    timeout: 5,
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: "Write|Edit",
                hooks: [
                  {
                    type: "command",
                    command: "deft-hook --host claude --event tool.before",
                    timeout: 30,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    // user-owned entry must be preserved
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              { command: "echo user-owned", timeout: 1 },
              { command: "deft-hook --host cursor --event session.start", timeout: 5 },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    runSetup({ operation: "install", from: "none", root });

    const claude = readFileSync(join(root, ".claude", "settings.json"), "utf8");
    expect(claude).toContain(`${HOOK_BIN} --host claude --event session.start`);
    expect(claude).not.toMatch(/(^|[\s"`'])deft-hook([\s"`']|$)/);

    const cursor = readFileSync(join(root, ".cursor", "hooks.json"), "utf8");
    expect(cursor).toContain("echo user-owned");
    expect(cursor).toContain(`${HOOK_BIN} --host cursor --event session.start`);
    expect(cursor).not.toMatch(/(^|[\s"`'])deft-hook([\s"`']|$)/);
  });

  it("wires Taskfile include to runtime Taskfile.yml (AC9.9)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const taskfile = readFileSync(join(root, "Taskfile.yml"), "utf8");
    expect(taskfile).toContain(`taskfile: ./${RUNTIME_PREFIX}Taskfile.yml`);
    expect(taskfile).not.toContain(".deft/core/");
  });

  it("writes package-relative git hooks (AC9.9)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const preCommit = readFileSync(join(root, ".githooks", "pre-commit"), "utf8");
    const helper = readFileSync(join(root, ".githooks", "_directive-run.sh"), "utf8");
    expect(helper).toContain(`${RUNTIME_PREFIX}dist/bin.js`);
    expect(helper).toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(preCommit).toContain("_directive-run.sh");
    expect(helper).not.toContain(".deft/core/");
  });

  it("never creates .deft/core on install (AC13.1)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
  });

  it("second repair is idempotent with full wiring inventory", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const second = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(second.conflicts).toEqual([]);
    expect(second.created).toEqual([]);
    expect(second.modified).toEqual([]);
  });
});
