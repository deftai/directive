/**
 * Wave 2c package-relative wiring owner tests (R9 / AC13.1 / AC9.*).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLATION_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import {
  checkFullInSync,
  RUNTIME_PIN_PACKAGE,
} from "@deftai/directive-core/dist/install-health/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertInventoryCompleteness,
  INSTALLER_OUTPUT_INVENTORY,
  inventoryEntry,
} from "./installer-output-inventory.js";
import { runSetup } from "./setup.js";
import {
  resolveDeftSkillTargetRel,
  resolveRuntimeAgentsEntryTemplatePath,
} from "./setup-wiring.js";

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
  // AC8.6 / AC9.9: readiness requires activatable Git hooks.
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("runSetup package-relative wiring (Wave 2c / R9)", { timeout: 30_000 }, () => {
  it("AGENTS managed section references main.md + AC9.7 recovery", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain(`${RUNTIME_PREFIX}main.md`);
    expect(agents).toMatch(/npm i -g @deftai\/directive/);
    expect(agents).toMatch(/directive install --repair/);
    expect(agents).not.toMatch(/<!-- deft:managed-section[\s\S]*?\.deft\/core\//);
  });

  it("AGENTS-STUB: managed body comes from agents-entry.md (session routing / always-pins)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("Session routing");
    expect(agents).toContain("always-pin");
    expect(agents).toContain("deft-directive-pre-pr");
    expect(agents).toContain("deft-directive-review-cycle");
    expect(agents).toMatch(/npm i -g @deftai\/directive/);
    expect(agents).toMatch(/directive install --repair/);
    expect(agents).not.toMatch(/<!-- deft:managed-section[\s\S]*?\.deft\/core\//);
    // Must not be the retired 4-line stub alone.
    expect(agents.split("\n").length).toBeGreaterThan(20);
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

  it("SKILL-INV: always-pins pre-pr + review-cycle; deft prefers AC9.6 skills/deft", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const prePr = readFileSync(
      join(root, ".agents", "skills", "deft-directive-pre-pr", "SKILL.md"),
      "utf8",
    );
    const review = readFileSync(
      join(root, ".agents", "skills", "deft-directive-review-cycle", "SKILL.md"),
      "utf8",
    );
    expect(prePr).toContain(`${RUNTIME_PREFIX}skills/deft-directive-pre-pr/SKILL.md`);
    expect(review).toContain(`${RUNTIME_PREFIX}skills/deft-directive-review-cycle/SKILL.md`);
    expect(existsSync(join(root, ".github", "skills", "deft-directive-pre-pr", "SKILL.md"))).toBe(
      true,
    );
    const deft = readFileSync(join(root, ".agents", "skills", "deft", "SKILL.md"), "utf8");
    // Prefer AC9.6 skills/deft when staged; otherwise package-root SKILL.md still works.
    expect(
      deft.includes(`${RUNTIME_PREFIX}skills/deft/SKILL.md`) ||
        deft.includes(`${RUNTIME_PREFIX}SKILL.md`),
    ).toBe(true);
    if (resolveDeftSkillTargetRel() === "skills/deft/SKILL.md") {
      expect(deft).toContain(`${RUNTIME_PREFIX}skills/deft/SKILL.md`);
    }
  });

  it("OWN-SKILLS: GENERATION ownership lists skill pointer paths (AC11.10)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      ownership: Array<{ path: string; kind: string }>;
    };
    const skillOwned = gen.ownership.filter(
      (a) => a.kind === "whole-file" && a.path.includes("/skills/") && a.path.endsWith("SKILL.md"),
    );
    expect(skillOwned.length).toBeGreaterThanOrEqual(10);
    expect(skillOwned.some((a) => a.path === ".agents/skills/deft-directive-pre-pr/SKILL.md")).toBe(
      true,
    );
    expect(
      skillOwned.some((a) => a.path === ".github/skills/deft-directive-review-cycle/SKILL.md"),
    ).toBe(true);
  });

  it("FEAT-PRESERVE: inventory complete and setup deposits slash commands", () => {
    assertInventoryCompleteness();
    expect(inventoryEntry("slash-commands")?.setupActivator).toBe("ensureSlashCommands");
    expect(inventoryEntry("gitattributes-core-markers")?.disposition).toBe("na-retired-copy-model");
    expect(INSTALLER_OUTPUT_INVENTORY.some((e) => e.id === "openclaw-integrations")).toBe(true);

    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    expect(existsSync(join(root, ".claude", "commands"))).toBe(true);
    const cmdSample = readdirSync(join(root, ".claude", "commands")).find((n) => n.endsWith(".md"));
    expect(cmdSample).toBeTruthy();
    const body = readFileSync(join(root, ".claude", "commands", cmdSample!), "utf8");
    expect(body).toContain(RUNTIME_PREFIX);
    expect(body).not.toContain(".deft/core/");
  });

  it("slash: preserves custom command files and reports conflict (no clobber)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    const customRel = ".claude/commands/deft-continue.md";
    writeFileSync(join(root, customRel), "# my custom continue command\n", "utf8");
    const result = runSetup({ operation: "install", from: "none", root });
    expect(readFileSync(join(root, customRel), "utf8")).toBe("# my custom continue command\n");
    expect(result.conflicts.some((c) => c.includes(customRel) && c.includes("refusing"))).toBe(
      true,
    );
  });

  it("ownership: does not claim user command files that only mention runtime path", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    const userRel = ".claude/commands/my-review.md";
    writeFileSync(
      join(root, userRel),
      `# notes\nSee ${RUNTIME_PREFIX}skills/deft-directive-review-cycle/SKILL.md\n`,
      "utf8",
    );
    // Re-run setup so GENERATION ownership is rebuilt with the user file present.
    runSetup({ operation: "repair", from: "0.0.0", root });
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      ownership: Array<{ path: string; kind: string }>;
    };
    expect(gen.ownership.some((a) => a.path === userRel)).toBe(false);
    expect(
      gen.ownership.some((a) => a.path.startsWith(".claude/commands/") && a.kind === "whole-file"),
    ).toBe(true);
  });

  it("AGENTS template comes from resolveRuntimeAgentsEntryTemplatePath", () => {
    const path = resolveRuntimeAgentsEntryTemplatePath();
    expect(path).toBeTruthy();
    expect(path!.replace(/\\/g, "/")).toMatch(/templates\/agents-entry\.md$/);
    expect(readFileSync(path!, "utf8")).toContain("Session routing");
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

  it("git hook helper short-circuits on local .deft-directive-disable (#5543 / #3039)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const helper = readFileSync(join(root, ".githooks", "_directive-run.sh"), "utf8");
    expect(helper).toContain(".deft-directive-disable");
    expect(helper).toContain("#5543");
    expect(helper).toMatch(/ls-files --error-unmatch/);
    // Fake runtime bin so sourcing the helper succeeds; short-circuit must avoid executing it.
    const binPath = join(root, RUNTIME_PREFIX, "dist", "bin.js");
    mkdirSync(join(root, RUNTIME_PREFIX, "dist"), { recursive: true });
    writeFileSync(
      binPath,
      '#!/usr/bin/env node\nprocess.stderr.write("BIN_RAN\\n"); process.exit(99);\n',
      "utf8",
    );
    writeFileSync(join(root, ".deft-directive-disable"), "", "utf8");
    const combined = execFileSync(
      "sh",
      ["-c", `. "$REPO_ROOT/.githooks/_directive-run.sh"; run_directive doctor 2>&1; echo EXIT:$?`],
      {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, REPO_ROOT: root },
      },
    );
    expect(combined).toMatch(/DISABLED|skipping Directive CLI/i);
    expect(combined).toContain("EXIT:0");
    expect(combined).not.toContain("BIN_RAN");
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

  it("PRE_TOOL_MATCHERS include Grok write/search_replace/run_terminal_command/spawn_subagent", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const grok = readFileSync(join(root, ".grok", "hooks", "deft.json"), "utf8");
    expect(grok).toContain("write");
    expect(grok).toContain("search_replace");
    expect(grok).toContain("run_terminal_command");
    expect(grok).toContain("spawn_subagent");
    expect(grok).toContain("kill_command_or_subagent");
  });

  it("chmod +x on pre-commit and pre-push", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const mode = statSync(join(root, ".githooks", "pre-commit")).mode & 0o111;
    expect(mode).toBeTruthy();
  });

  it("does not overwrite a foreign core.hooksPath", () => {
    const root = tempRoot();
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "core.hooksPath", "custom-hooks"]);
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts.some((c) => c.includes("core.hooksPath"))).toBe(true);
    const current = execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
    expect(current).toBe("custom-hooks");
  });

  it("checkFullInSync passes after setup when pin/lockfile/installed agree", () => {
    const root = tempRoot();
    const result = runSetup({ operation: "install", from: "none", root });
    const version = result.runtimeVersion;
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "t",
          version: "0.0.0",
          private: true,
          devDependencies: { [RUNTIME_PIN_PACKAGE]: version },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": { devDependencies: { [RUNTIME_PIN_PACKAGE]: version } },
            [`node_modules/${RUNTIME_PIN_PACKAGE}`]: { version },
          },
        },
        null,
        2,
      )}\n`,
    );
    const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(runtimePkg, { recursive: true });
    writeFileSync(
      join(runtimePkg, "package.json"),
      `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version }, null, 2)}\n`,
    );
    const sync = checkFullInSync(root);
    expect(sync.predicates.wiring.ok).toBe(true);
    expect(sync.inSync).toBe(true);
  });

  it("merges Taskfile includes without duplicating the top-level key", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "Taskfile.yml"),
      "version: '3'\n\nincludes:\n  # user comment\n  other:\n    taskfile: ./other.yml\n",
    );
    runSetup({ operation: "install", from: "none", root });
    const body = readFileSync(join(root, "Taskfile.yml"), "utf8");
    expect(body.match(/^includes:/gm)?.length ?? 0).toBe(1);
    expect(body).toContain("taskfile: ./node_modules/@deftai/directive-runtime/Taskfile.yml");
    expect(body).toContain("other:");
  });

  it("respects plan.policy.hostHooks opt-out", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({ plan: { policy: { hostHooks: { cursor: false } } } }, null, 2)}\n`,
    );
    runSetup({ operation: "install", from: "none", root });
    expect(existsSync(join(root, ".cursor", "hooks.json"))).toBe(false);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
  });

  it("shared host/Taskfile ownership is structured-entry not whole-file", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      ownership: Array<{ path: string; kind: string; entryKey?: string }>;
    };
    const cursor = gen.ownership.find((a) => a.path === ".cursor/hooks.json");
    const taskfile = gen.ownership.find((a) => a.path === "Taskfile.yml");
    expect(cursor?.kind).toBe("structured-entry");
    expect(taskfile?.kind).toBe("structured-entry");
    expect(taskfile?.entryKey).toBe("includes.deft");
  });
});
