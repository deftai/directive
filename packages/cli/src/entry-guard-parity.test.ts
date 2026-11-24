/**
 * The launcher's copy of the entry-guard message table matches core (#6620),
 * and the two per-host block renderers (the committed hook file's
 * `blockToolCall` and the launcher's `renderHookBlock`) give the same response.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
  hostHookOuterSource,
} from "../../core/src/init-deposit/host-hook-outer.js";
import * as core from "../../core/src/install-health/constants.js";
import {
  matchPinMismatchRecoveryCommand,
  PIN_MISMATCH_SIMPLE_COMMAND_SOURCE,
} from "../../core/src/install-health/recovery-admit.js";
import { DEFT_DIRECTIVE_DISABLE_ONE_LINE } from "../../core/src/policy/deft-directive-disable.js";
import {
  KILL_SWITCH_BARE_FLAG_NAME,
  KILL_SWITCH_NAMESPACE,
  KILL_SWITCH_OFF_VERB,
  KILL_SWITCH_ON_VERB,
  KILL_SWITCH_RECORD_GIT_DIR_PREFIX,
  KILL_SWITCH_RECORD_REL,
  KILL_SWITCH_RECORD_SCHEMA_LINE,
} from "../../core/src/policy/kill-switch-record.js";
import { PRE_OVPR_LAYOUT_MESSAGE } from "./constants.js";
import * as cli from "./entry-guard.js";
import { DISABLE_ONE_LINE } from "./entry-guard.js";
import { renderHookBlock } from "./hook-block.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(lockfiles: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "entry-guard-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), "{}\n");
  for (const name of lockfiles) writeFileSync(join(root, name), "");
  return root;
}

const LOCKFILE_CASES: readonly (readonly string[])[] = [
  ["pnpm-lock.yaml"],
  ["package-lock.json"],
  ["pnpm-lock.yaml", "package-lock.json"],
  [],
];

describe("entry-guard table parity (core ↔ launcher copy)", () => {
  it("has the same rows and the same person-runs-it note", () => {
    expect(cli.ENTRY_GUARD_MESSAGES).toEqual(core.ENTRY_GUARD_MESSAGES);
    expect(cli.ENTRY_GUARD_PERSON_RUNS_INSTALL).toBe(core.ENTRY_GUARD_PERSON_RUNS_INSTALL);
  });

  it.each(LOCKFILE_CASES)("names the same install for lockfiles %j", (...lockfiles) => {
    const root = project(lockfiles);
    expect(cli.projectInstallCommand(root)).toBe(core.projectInstallCommand(root));
  });

  it("fills placeholders the same way for every row", () => {
    const values = { install: "`npm install`", pin: "1.2.4", installed: "1.2.3", spec: "^1" };
    for (const situation of Object.keys(core.ENTRY_GUARD_MESSAGES) as core.EntrySituation[]) {
      expect(cli.formatEntryGuardMessage(situation, values)).toBe(
        core.formatEntryGuardMessage(situation, values),
      );
      expect(cli.formatEntryGuardMessage(situation)).toBe(core.formatEntryGuardMessage(situation));
    }
  });

  it("inserts values literally, with no `$&`-style replacement patterns", () => {
    const values = { pin: "$&", installed: "$'", spec: "$$1" };
    for (const format of [core.formatEntryGuardMessage, cli.formatEntryGuardMessage]) {
      expect(format("pin-mismatch", values)).toContain(
        "@deftai/directive-runtime $' is not the pinned $&.",
      );
      expect(format("pin-invalid", values)).toContain("It currently says `$$1`.");
    }
  });

  it("keeps the launcher's old-project and disabled texts equal to the table and core", () => {
    expect(PRE_OVPR_LAYOUT_MESSAGE).toBe(core.ENTRY_GUARD_MESSAGES["legacy-layout"]);
    expect(DISABLE_ONE_LINE).toBe(DEFT_DIRECTIVE_DISABLE_ONE_LINE);
  });

  it("keeps the launcher's kill record contract equal to core (#6740)", () => {
    expect(cli.KILL_RECORD_REL).toBe(KILL_SWITCH_RECORD_REL);
    expect(cli.KILL_RECORD_SCHEMA_LINE).toBe(KILL_SWITCH_RECORD_SCHEMA_LINE);
    expect(cli.KILL_RECORD_GIT_DIR_PREFIX).toBe(KILL_SWITCH_RECORD_GIT_DIR_PREFIX);
    expect(cli.DISABLE_FLAG_NAME).toBe(KILL_SWITCH_BARE_FLAG_NAME);
    expect([...cli.KILL_SWITCH_LAUNCHER_COMMANDS].sort()).toEqual(
      [KILL_SWITCH_OFF_VERB, KILL_SWITCH_ON_VERB, KILL_SWITCH_NAMESPACE].sort(),
    );
  });
});

describe("pin-invalid row (D-042)", () => {
  it.each([
    [
      [] as string[],
      "^0.129.0",
      'package.json must name one exact Directive version, like `"@deftai/directive-runtime": "0.129.0"`. It currently says `^0.129.0`. Change it to an exact version, then run `npm install` (or `pnpm install`).',
    ],
    [
      ["pnpm-lock.yaml"],
      "~1.2.3-rc.1",
      'package.json must name one exact Directive version, like `"@deftai/directive-runtime": "1.2.3-rc.1"`. It currently says `~1.2.3-rc.1`. Change it to an exact version, then run `pnpm install --frozen-lockfile`.',
    ],
    [
      ["package-lock.json"],
      "latest",
      "package.json must name one exact Directive version. It currently says `latest`. Change it to an exact version, then run `npm install`.",
    ],
  ])("lockfiles %j, spec %s", (lockfiles, spec, expected) => {
    const root = project(lockfiles);
    for (const m of [core, cli]) {
      expect(m.formatEntryGuardMessage("pin-invalid", m.pinInvalidValues(root, spec))).toBe(
        expected,
      );
    }
  });
});

describe("every install the table names is one the hook lets through (O-30)", () => {
  it.each(LOCKFILE_CASES)("lockfiles %j", (...lockfiles) => {
    const named = core.projectInstallCommand(project(lockfiles));
    const commands = [...named.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(matchPinMismatchRecoveryCommand(command)).toBe(command);
    }
  });

  it("no row names Yarn or the global launcher-plus-repair pair", () => {
    for (const row of Object.values(core.ENTRY_GUARD_MESSAGES)) {
      expect(row).not.toMatch(/yarn/i);
      expect(row).not.toContain("npm i -g @deftai/directive, then");
    }
  });
});

describe("block renderer parity (hook file ↔ launcher deft-hook)", () => {
  const HOSTS = ["claude", "codex", "cursor", "grok", ""] as const;
  const EVENTS = ["tool.before", "session.start"] as const;

  it.each(
    HOSTS.flatMap((host) => EVENTS.map((event) => [host, event] as const)),
  )("host %j, event %s: same stdout, stderr and exit code", (host, event) => {
    const root = project([]);
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "outer.mjs"), hostHookOuterSource());
    const args = [join(root, "outer.mjs"), "--event", event];
    if (host !== "") args.push("--host", host);
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    const reason = HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE.replace(
      "{install}",
      core.projectInstallCommand(root),
    );
    const expected = renderHookBlock(host, event, reason);
    expect({ stdout: result.stdout, stderr: result.stderr, exitCode: result.status }).toEqual({
      stdout: expected.stdout,
      stderr: expected.stderr,
      exitCode: expected.exitCode,
    });
  });
});

describe("missing-runtime outer admit parity (#7275)", () => {
  it("outer source embeds the shared recovery commands and simple-command source", () => {
    const source = hostHookOuterSource();
    expect(source).toContain("pnpm");
    expect(source).toContain("frozen-lockfile");
    expect(source).toContain('"npm","install"');
    expect(source).toContain('"npm","ci"');
    expect(source).toContain("A-Za-z0-9@/._=-");
    expect(PIN_MISMATCH_SIMPLE_COMMAND_SOURCE).toContain("A-Za-z0-9@/._=-");
    for (const command of ["pnpm install --frozen-lockfile", "npm install", "npm ci"]) {
      expect(matchPinMismatchRecoveryCommand(command)).toBe(command);
    }
    expect(matchPinMismatchRecoveryCommand("npm i -g @deftai/directive")).toBeNull();
    expect(matchPinMismatchRecoveryCommand("directive install --repair")).toBeNull();
  });

  it("missing-pin guidance names the install exception", () => {
    expect(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE).toContain(
      "exact project install named above is allowed",
    );
    expect(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE).not.toContain(
      "Agent tool calls stay blocked until a person runs it.",
    );
  });
});
