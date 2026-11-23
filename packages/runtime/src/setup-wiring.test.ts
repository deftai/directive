/**
 * Wave 2c package-relative wiring owner tests (R9 / AC13.1 / AC9.*).
 */
import { execFileSync, spawnSync } from "node:child_process";
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
import {
  hostHookConfigEntryLines,
  hostHookEntryPrefix,
  hostHookOuterSha8,
} from "@deftai/directive-core/dist/init-deposit/host-hook-outer.js";
import { INSTALLATION_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import {
  checkFullInSync,
  RUNTIME_PIN_PACKAGE,
} from "@deftai/directive-core/dist/install-health/index.js";
import { resolveAbsoluteGitDir } from "@deftai/directive-core/dist/policy/deft-directive-disable.js";
import {
  KILL_SWITCH_BARE_FLAG_NAME,
  KILL_SWITCH_GITHOOK_MARKER,
  KILL_SWITCH_RECORD_REL,
  writeKillSwitchRecord,
} from "@deftai/directive-core/dist/policy/kill-switch-record.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertInventoryCompleteness,
  INSTALLER_OUTPUT_INVENTORY,
  inventoryEntry,
} from "./installer-output-inventory.js";
import { runSetup } from "./setup.js";
import {
  listSkillPointerPaths,
  resolveDeftSkillTargetRel,
  resolveRuntimeAgentsEntryTemplatePath,
  SKILL_HOST_ROOTS,
  SKILL_POINTER_INVENTORY,
  SKILL_POINTER_RECOVERY,
  yamlScalar,
} from "./setup-wiring.js";

const TEMPS: string[] = [];
const RUNTIME_PREFIX = "node_modules/@deftai/directive-runtime/";
const HOOK_BIN = `node ${RUNTIME_PREFIX}dist/hook-bin.js`;
const OUTER_SHA = hostHookOuterSha8();
function outerCmd(host: "claude" | "cursor" | "codex" | "grok", event: string): string {
  return `${hostHookEntryPrefix(host, OUTER_SHA)} --host ${host} --event ${event}`;
}

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
    expect(skill).toContain(`Recovery: ${SKILL_POINTER_RECOVERY}`);
    expect(skill).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
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

  it("writes host hooks as node …/deft-hook-<sha8>.mjs (AC9.1 / #5994)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    for (const rel of [
      ".claude/settings.json",
      ".cursor/hooks.json",
      ".codex/hooks.json",
      ".grok/hooks/deft.json",
    ]) {
      const body = readFileSync(join(root, rel), "utf8");
      expect(body).toMatch(/deft-hook-[a-f0-9]{8}\.mjs/);
      expect(body).not.toContain(HOOK_BIN);
      expect(body).not.toMatch(/(^|[\s"`'])deft-hook([\s"`']|$)/);
    }
    expect(existsSync(join(root, `.cursor/hooks/deft-hook-${OUTER_SHA}.mjs`))).toBe(true);
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
    expect(hostHookConfigEntryLines(claude)).toContain(outerCmd("claude", "session.start"));
    expect(claude).not.toContain(HOOK_BIN);
    expect(claude).not.toMatch(/(^|[\s"`'])deft-hook([\s"`']|$)/);

    const cursor = readFileSync(join(root, ".cursor", "hooks.json"), "utf8");
    expect(cursor).toContain("echo user-owned");
    expect(cursor).toContain(outerCmd("cursor", "session.start"));
    expect(cursor).not.toContain(HOOK_BIN);
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
    expect(helper).not.toContain(INSTALLATION_RECOVERY_GUIDANCE);
    expect(helper).not.toContain("or yarn");
    expect(preCommit).toContain("_directive-run.sh");
    expect(helper).not.toContain(".deft/core/");
    // The disable check comes before the runtime check (AC9.12).
    expect(helper.indexOf("_kill=")).toBeLessThan(helper.indexOf('if [ ! -f "$RUNTIME_BIN" ]'));
  });

  it.each([
    ["pnpm-lock.yaml", "`pnpm install --frozen-lockfile`"],
    ["package-lock.json", "`npm install`"],
    [null, "`npm install` (or `pnpm install --frozen-lockfile`)"],
  ])("git hook helper with no runtime and lockfile %s names %s (#6620)", (lockfile, command) => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    if (lockfile !== null) writeFileSync(join(root, lockfile), "", "utf8");
    const result = spawnSync(
      "sh",
      ["-c", `. "$REPO_ROOT/.githooks/_directive-run.sh"; run_directive verify:encoding`],
      { encoding: "utf8", cwd: root, env: { ...process.env, REPO_ROOT: root } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Directive can't run: @deftai/directive-runtime is not installed in this project. Run ${command} in a terminal in this project.`,
    );
    expect(result.stderr).not.toMatch(/yarn|npm i -g|install --repair/);
  });

  it("git hook helper short-circuits on a valid kill record only (#5543 / #3039 / #6740)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const helper = readFileSync(join(root, ".githooks", "_directive-run.sh"), "utf8");
    expect(helper).toContain(KILL_SWITCH_GITHOOK_MARKER);
    expect(helper).toContain(KILL_SWITCH_RECORD_REL);
    expect(helper).toContain("#5543");
    expect(helper).toContain("rev-parse --absolute-git-dir");
    expect(helper).toMatch(/grep -qxF/);
    // Fake runtime bin so sourcing the helper succeeds; short-circuit must avoid executing it.
    const binPath = join(root, RUNTIME_PREFIX, "dist", "bin.js");
    mkdirSync(join(root, RUNTIME_PREFIX, "dist"), { recursive: true });
    writeFileSync(
      binPath,
      '#!/usr/bin/env node\nprocess.stderr.write("BIN_RAN\\n"); process.exit(99);\n',
      "utf8",
    );
    const runHelper = (): string =>
      execFileSync(
        "sh",
        ["-c", `. "$REPO_ROOT/.githooks/_directive-run.sh"; run_directive doctor 2>&1; echo EXIT:$?`],
        {
          encoding: "utf8",
          cwd: root,
          env: { ...process.env, REPO_ROOT: root },
        },
      );
    // #6740: a bare root flag turns nothing off; the bin still runs.
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "", "utf8");
    expect(runHelper()).toContain("BIN_RAN");
    writeKillSwitchRecord(root, {
      gitDir: resolveAbsoluteGitDir(root) ?? "",
      mintedAt: "2026-11-22T00:00:00Z",
      mintedVia: "kill-switch:on",
    });
    const combined = runHelper();
    // #5994 F1: disable is quiet allow (no required message); still exit 0 and skip bin.
    expect(combined).toContain("EXIT:0");
    expect(combined).not.toContain("BIN_RAN");
    expect(combined).not.toMatch(/DISABLED|skipping Directive CLI/i);
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

  // Windows has no POSIX mode bits: statSync never reports the execute bits, so skip there.
  it.skipIf(process.platform === "win32")("chmod +x on pre-commit and pre-push", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    const mode = statSync(join(root, ".githooks", "pre-commit")).mode & 0o111;
    expect(mode).toBeTruthy();
  });

  it("does not overwrite a foreign core.hooksPath without the plan's approval (#4960)", () => {
    const root = tempRoot();
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "core.hooksPath", "custom-hooks"]);
    const result = runSetup({ operation: "install", from: "none", root });
    // Inactive, not a conflict (D-017 / ledger Problem 20); readiness withheld.
    expect(result.conflicts).toEqual([]);
    expect(result.gitHooksInactive).toContain("core.hooksPath is 'custom-hooks'");
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${result.runtimeVersion}.json`)),
    ).toBe(false);
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

// #5838 / #6165: the 12-pointer 0.126 set, valid YAML front matter.
const KNOWN_POINTER_NAMES = [
  "deft",
  "deft-directive-setup",
  "deft-directive-build",
  "deft-directive-review-cycle",
  "deft-directive-refinement",
  "deft-directive-swarm",
  "deft-directive-interview",
  "deft-directive-portfolio-priority",
  "deft-directive-pre-pr",
  "deft-directive-sync",
  "deft-directive-tutorial",
  "deft-directive-feedback",
];
const UNSAFE_PLAIN = /: |:$| #|^[-?:,[\]{}#&*!|>'"%@`]|^\s|\s$/;

/** Parse the two front-matter keys; fail on anything a strict YAML reader would reject. */
function parseFrontMatter(body: string): { name: string; description: string } {
  const m = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no front matter");
  const out: Record<string, string> = {};
  for (const lineText of (m[1] ?? "").split("\n")) {
    const idx = lineText.indexOf(": ");
    if (idx < 0) throw new Error(`bad front-matter line: ${lineText}`);
    const key = lineText.slice(0, idx);
    const raw = lineText.slice(idx + 2);
    if (raw.startsWith('"')) {
      out[key] = JSON.parse(raw) as string;
    } else {
      if (UNSAFE_PLAIN.test(raw)) throw new Error(`unsafe plain scalar: ${raw}`);
      out[key] = raw;
    }
  }
  return { name: out.name ?? "", description: out.description ?? "" };
}

describe("skill pointer inventory (#5838 / #6165)", { timeout: 30_000 }, () => {
  it("inventory holds all 12 known pointers; ownership paths are 12 x 5", () => {
    expect(SKILL_POINTER_INVENTORY.map((e) => e.dir).sort()).toEqual(
      [...KNOWN_POINTER_NAMES].sort(),
    );
    expect(SKILL_HOST_ROOTS).toHaveLength(5);
    expect(listSkillPointerPaths()).toHaveLength(60);
    expect(listSkillPointerPaths()).toContain(".claude/skills/deft-directive-tutorial/SKILL.md");
    expect(listSkillPointerPaths()).toContain(".github/skills/deft-directive-feedback/SKILL.md");
  });

  it("every pointer has valid front matter, runtime target and no version", () => {
    for (const entry of SKILL_POINTER_INVENTORY) {
      const fm = parseFrontMatter(entry.body);
      expect(fm.name).toBe(entry.dir);
      expect(fm.description.length).toBeGreaterThan(0);
      const target = entry.body.match(/^Read and follow: (\S+)$/m)?.[1] ?? "";
      expect(target.startsWith(RUNTIME_PREFIX)).toBe(true);
      expect(target.endsWith("SKILL.md")).toBe(true);
      if (entry.dir !== "deft") {
        expect(entry.body).toContain(`${RUNTIME_PREFIX}skills/${entry.dir}/SKILL.md`);
      }
      expect(entry.body).not.toContain(".deft/core/");
      expect(entry.body).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it("refinement description round-trips; only it is quoted", () => {
    const refinement = SKILL_POINTER_INVENTORY.find((e) => e.dir === "deft-directive-refinement");
    expect(parseFrontMatter(refinement?.body ?? "").description).toBe(
      "Structured refinement workflow: triage issues and update the roadmap.",
    );
    const quoted = SKILL_POINTER_INVENTORY.filter((e) => /^description: "/m.test(e.body));
    expect(quoted.map((e) => e.dir)).toEqual(["deft-directive-refinement"]);
  });

  it("yamlScalar quotes only text YAML would misread", () => {
    expect(yamlScalar("Plain text (ok).")).toBe("Plain text (ok).");
    expect(yamlScalar("a: b")).toBe('"a: b"');
    expect(yamlScalar("a #b")).toBe('"a #b"');
    expect(yamlScalar("-a")).toBe('"-a"');
    expect(yamlScalar("`x`")).toBe('"`x`"');
    expect(yamlScalar(" a")).toBe('" a"');
    expect(yamlScalar('say "hi": now')).toBe('"say \\"hi\\": now"');
    expect(JSON.parse(yamlScalar('say "hi": now'))).toBe('say "hi": now');
  });

  it("install writes all 12 pointers under all 5 roots; second setup changes nothing", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    for (const rel of listSkillPointerPaths()) {
      const body = readFileSync(join(root, rel), "utf8");
      expect(body).toContain(RUNTIME_PREFIX);
      expect(body).not.toContain(".deft/core/");
      parseFrontMatter(body);
    }
    const before = listSkillPointerPaths().map((rel) => readFileSync(join(root, rel), "utf8"));
    const again = runSetup({ operation: "repair", from: "none", root });
    const after = listSkillPointerPaths().map((rel) => readFileSync(join(root, rel), "utf8"));
    expect(after).toEqual(before);
    const touched = [...again.created, ...again.modified];
    expect(touched.filter((p) => p.includes("/skills/"))).toEqual([]);
  });

  it("repair rewrites stale .deft/core tutorial and feedback pointers (0.127-0.129 converts)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    for (const host of SKILL_HOST_ROOTS) {
      for (const name of ["deft-directive-tutorial", "deft-directive-feedback"]) {
        writeFileSync(
          join(root, host, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: >-\n  old\n---\n\nRead and follow: .deft/core/skills/${name}/SKILL.md\n`,
        );
      }
    }
    runSetup({ operation: "repair", from: "none", root });
    for (const rel of listSkillPointerPaths()) {
      expect(readFileSync(join(root, rel), "utf8")).not.toContain(".deft/core/skills");
    }
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      ownership: Array<{ path: string; kind: string }>;
    };
    for (const rel of [
      ".claude/skills/deft-directive-tutorial/SKILL.md",
      ".agents/skills/deft-directive-feedback/SKILL.md",
    ]) {
      expect(gen.ownership.find((a) => a.path === rel)?.kind).toBe("whole-file");
    }
  });
});
