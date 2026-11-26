/**
 * v261027 thin host `.mjs` outer (#5994 / AC9.1 / AC9.12).
 *
 * Registered host command is `node <deposit>/deft-hook-<sha8>.mjs …`.
 * Outer uses Node built-ins only until entry guards pass, then spawns pin
 * `hook-bin.js`. No timeout logic in the outer (#5920 / #5988 out of scope).
 *
 * F1 operator-disable eligibility (#6122 / #6740): quietAllow only for a valid
 * kill record (`.deft/authz/kill-switch.disable`: a regular file, not a link,
 * with the exact whole lines `schema=deft.kill-switch.v1` and `gitDir=` plus
 * `git rev-parse --absolute-git-dir`). A bare root flag file never selects it.
 * The outer passes `--kill-switch-reader v1` to hook-bin; an older runtime
 * refuses the unknown argument, which the outer reports as a hook failure
 * (fails closed). With no runtime, the outer prints the one bare-flag or
 * invalid-record warning itself; otherwise the runtime prints it.
 *
 * The outer runs the first steps of the shared entry order
 * (`install-health/constants.ts`, #6620): disabled → runtime missing → run the
 * runtime's hook-bin. Its messages are rows of that table.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { containedRemove, containedRename, containedWrite } from "../fs/contained-write.js";
import { agyHookOrderOuterSource } from "../hooks/classify/agy-hook-order.js";
import type { HookHost } from "../hooks/dispatcher.js";
import { SHELL_TOOL_NAMES } from "../hooks/tools.js";
import { ENTRY_GUARD_MESSAGES } from "../install-health/constants.js";
import {
  PIN_MISMATCH_RECOVERY_COMMANDS,
  PIN_MISMATCH_SIMPLE_COMMAND_SOURCE,
} from "../install-health/recovery-admit.js";
import {
  formatInvalidKillRecordWarning,
  KILL_SWITCH_BARE_FLAG_NAME,
  KILL_SWITCH_BARE_FLAG_WARNING,
  KILL_SWITCH_READER_FLAG,
  KILL_SWITCH_READER_VERSION,
  KILL_SWITCH_RECORD_GIT_DIR_PREFIX,
  KILL_SWITCH_RECORD_REL,
  KILL_SWITCH_RECORD_SCHEMA_LINE,
  type KillSwitchRecordInvalidReason,
} from "../policy/kill-switch-record.js";

/**
 * Missing-runtime exception note (#7275 Prefer-A Bound): names that the exact
 * project install is admitted; does not claim every agent tool stays blocked.
 */
export const HOST_HOOK_MISSING_PIN_INSTALL_EXCEPTION =
  "The exact project install named above is allowed through a shell tool at the project root; other agent tool calls stay blocked until that install succeeds.";

/**
 * The outer's missing-runtime message (AC9.12 / #7275): the `runtime-missing`
 * row plus the install-exception note. `{install}` is filled in from the
 * project's lockfile when the outer runs.
 */
export const HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE = `${ENTRY_GUARD_MESSAGES["runtime-missing"]} ${HOST_HOOK_MISSING_PIN_INSTALL_EXCEPTION}`;

export const HOST_HOOK_OUTER_PIN_HOOK_BIN_REL =
  "node_modules/@deftai/directive-runtime/dist/hook-bin.js";

/** Filename stem + content-hash suffix (AC9.1). */
export function hostHookOuterFileName(sha8: string): string {
  return `deft-hook-${sha8}.mjs`;
}

/** Deposit directory that holds `deft-hook-<sha8>.mjs` for `host` (#7349). */
export function hostHookOuterDepositDir(host: HookHost): string {
  switch (host) {
    case "grok":
      return ".grok/hooks";
    case "cursor":
      return ".cursor/hooks";
    case "claude":
      return ".claude";
    case "codex":
      return ".codex";
    case "agy":
      return ".agents";
    default: {
      const _exhaustive: never = host;
      return _exhaustive;
    }
  }
}

/** Host registration file that lists Directive PreToolUse entries (#7349). */
export function hostHookRegistrationRelPath(host: HookHost): string {
  switch (host) {
    case "claude":
      return ".claude/settings.json";
    case "grok":
      return ".grok/hooks/deft.json";
    case "cursor":
      return ".cursor/hooks.json";
    case "codex":
      return ".codex/hooks.json";
    case "agy":
      return ".agents/hooks.json";
    default: {
      const _exhaustive: never = host;
      return _exhaustive;
    }
  }
}

/** Glob operators use when verifying leftover outers for `host` (#7349). */
export function hostHookOuterGlobRel(host: HookHost): string {
  return `${hostHookOuterDepositDir(host)}/deft-hook-*.mjs`;
}

/**
 * Operator-facing paths repair / disable must name when rewriting host hooks
 * (#7349 Prefer-A Bound P3): registration file + outer module glob.
 */
export function hostHookRepairDisclosurePaths(host: HookHost): readonly string[] {
  return [hostHookRegistrationRelPath(host), hostHookOuterGlobRel(host)];
}

/** Repair-plan bullet SoT when host-hook opt-out rewrite/remove may run (#7349). */
export function hostHookRepairOptOutDisclosureBullet(host: HookHost = "claude"): string {
  const paths = hostHookRepairDisclosurePaths(host).join(", ");
  return `rewrite or remove Directive host hooks when plan.policy.hostHooks opts out (${paths})`;
}

/** Deposit-relative path for the committed outer (per host). */
export function hostHookOuterRelPath(host: HookHost, sha8: string): string {
  return `${hostHookOuterDepositDir(host)}/${hostHookOuterFileName(sha8)}`;
}

/**
 * Delete every `deft-hook-<sha8>.mjs` under the host deposit dir (#7349).
 * Returns relative paths that were removed.
 */
export function removeHostHookOuterModules(projectRoot: string, host: HookHost): string[] {
  const dirRel = hostHookOuterDepositDir(host);
  const dirAbs = join(projectRoot, dirRel);
  if (!existsSync(dirAbs)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dirAbs)) {
    if (!/^deft-hook-[a-f0-9]{8}\.mjs$/.test(name)) continue;
    const rel = `${dirRel}/${name}`;
    const abs = join(projectRoot, rel);
    if (
      containedRemove({
        root: projectRoot,
        target: abs,
        mutation: { path: rel },
      }).removed
    ) {
      removed.push(rel);
    }
  }
  return removed;
}

const GROK_PRETOOLUSE_WRAPPER_REL = ".grok/hooks/deft-pretooluse-wrapper.sh";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True when a registered command is Directive-managed for `host` (#7349). */
export function isDirectiveManagedHostHookCommand(commandText: string, host: HookHost): boolean {
  if (isHostHookOuterCommand(commandText)) return true;
  if (commandText.includes("deft-pretooluse-wrapper.sh")) return host === "grok";
  if (
    commandText.includes("deft-hook") ||
    commandText.includes("deft hook:dispatch") ||
    commandText.includes("node_modules/@deftai/directive-runtime/dist/hook-bin.js") ||
    commandText.includes("deft-cursor-hook-adapter.mjs")
  ) {
    return true;
  }
  // --host alone is not ownership (#7349 Greptile): company-check --host claude must stay.
  return false;
}

function withoutManagedNestedHooks(value: unknown, host: HookHost): unknown | null {
  const group = objectRecord(value);
  if (group === null || !Array.isArray(group.hooks)) return value;
  const kept = group.hooks.filter((candidate) => {
    const commandText = hostHookEntryText(candidate);
    return !(commandText !== null && isDirectiveManagedHostHookCommand(commandText, host));
  });
  if (kept.length === group.hooks.length) return value;
  return kept.length === 0 ? null : { ...group, hooks: kept };
}

function stripNestedHostHookConfig(
  config: Record<string, unknown>,
  host: HookHost,
): Record<string, unknown> {
  const hooks = objectRecord(config.hooks);
  if (hooks === null) {
    const { hooks: _hooks, ...rest } = config;
    return rest;
  }
  const nextHooks: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      nextHooks[key] = value;
      continue;
    }
    // Every nested event: strip managed commands inside the group; keep the group if user hooks remain.
    const filtered = value
      .map((entry) => withoutManagedNestedHooks(entry, host))
      .filter((entry) => entry !== null);
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _hooks, ...rest } = config;
    return rest;
  }
  return { ...config, hooks: nextHooks };
}

function stripCursorHostHookConfig(config: Record<string, unknown>): Record<string, unknown> {
  const hooks = objectRecord(config.hooks);
  if (hooks === null) {
    const { hooks: _hooks, version: _version, ...rest } = config;
    return rest;
  }
  const nextHooks: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      nextHooks[key] = value;
      continue;
    }
    const filtered = value.filter((entry) => {
      const record = objectRecord(entry);
      if (typeof record?.command !== "string") return true;
      return !isDirectiveManagedHostHookCommand(record.command, "cursor");
    });
    if (filtered.length > 0) nextHooks[key] = filtered;
  }
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _hooks, version: _version, ...rest } = config;
    return rest;
  }
  return { ...config, version: 1, hooks: nextHooks };
}

/** Operational write outcome — I/O deny stays returned-failure (#5574 Prefer-A). */
function writeJsonAtomic(
  projectRoot: string,
  absPath: string,
  relPath: string,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  const parent = dirname(absPath);
  const temporary = join(parent, `${basename(absPath)}.deft-${process.pid}.tmp`);
  try {
    containedWrite({
      root: resolve(projectRoot),
      target: temporary,
      data: next,
      mode: "replace",
      mutation: { kind: "stripped", path: relPath },
    });
    containedRename({
      root: resolve(projectRoot),
      from: temporary,
      to: absPath,
      mutation: false,
    });
    return { ok: true };
  } catch (err) {
    try {
      containedRemove({ root: resolve(projectRoot), target: temporary, mutation: false });
    } catch {
      /* best-effort cleanup */
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type StripHostHookRegistrationResult = {
  touchedPaths: string[];
  stripped: boolean;
  /** Set when registration JSON is unusable or the atomic write fails (operational). */
  error?: string;
};

/**
 * Strip Directive-managed hook registration for one host in the current project
 * root and remove leftover outer modules (#7349 Prefer-A Bound P1). Does not
 * touch other hosts' deposits. Malformed registration JSON and write I/O
 * denials are returned as `error` (operational; no throw-site).
 */
export function stripHostHookRegistrationInPlace(
  projectRoot: string,
  host: HookHost,
): StripHostHookRegistrationResult {
  const touched: string[] = [];
  let stripped = false;
  const regRel = hostHookRegistrationRelPath(host);
  const regAbs = join(projectRoot, regRel);
  if (existsSync(regAbs)) {
    const before = readFileSync(regAbs, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(before) as unknown;
    } catch (cause) {
      return {
        touchedPaths: [],
        stripped: false,
        error: `${regRel} is not valid JSON; refusing to overwrite user configuration: ${cause}`,
      };
    }
    const config = objectRecord(parsed);
    if (config === null) {
      return {
        touchedPaths: [],
        stripped: false,
        error: `${regRel} must contain a JSON object; refusing to overwrite user configuration.`,
      };
    }
    const next =
      host === "cursor"
        ? stripCursorHostHookConfig(config)
        : stripNestedHostHookConfig(config, host);
    const after = `${JSON.stringify(next, null, 2)}\n`;
    if (after !== before) {
      const wrote = writeJsonAtomic(projectRoot, regAbs, regRel, next);
      if (!wrote.ok) {
        return { touchedPaths: [], stripped: false, error: wrote.error };
      }
      touched.push(regRel);
      stripped = true;
    }
  }

  for (const rel of removeHostHookOuterModules(projectRoot, host)) {
    touched.push(rel);
    stripped = true;
  }

  if (host === "grok") {
    const wrapperAbs = join(projectRoot, GROK_PRETOOLUSE_WRAPPER_REL);
    if (
      containedRemove({
        root: projectRoot,
        target: wrapperAbs,
        mutation: { path: GROK_PRETOOLUSE_WRAPPER_REL },
      }).removed
    ) {
      touched.push(GROK_PRETOOLUSE_WRAPPER_REL);
      stripped = true;
    }
  }

  for (const path of hostHookRepairDisclosurePaths(host)) {
    if (!touched.includes(path)) touched.push(path);
  }
  return { touchedPaths: touched, stripped };
}

/** Registered command prefix: `node <rel>` (host/event args appended by callers). */
export function hostHookOuterCommand(host: HookHost, sha8: string): string {
  return `node ${hostHookOuterRelPath(host, sha8)}`;
}

export function hostHookOuterSha8(source: string = hostHookOuterSource()): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 8);
}

/** True when a registered command string is the v261027 `.mjs` outer form. */
export function isHostHookOuterCommand(commandText: string): boolean {
  return /(?:^|[\s/])deft-hook-[a-f0-9]{8}\.mjs(?:\s|$)/.test(commandText);
}

/**
 * Message when the Git checkout the hook runs in has no committed outer
 * (AC9.1 v261119): the `no-runtime-pin` row ("No Directive project here").
 */
export const HOST_HOOK_LOCATOR_NO_OUTER_MESSAGE = ENTRY_GUARD_MESSAGES["no-runtime-pin"];

/**
 * No-shell Node locator (AC9.1 v261119, #5959 / #6594), run as
 * `node -e <locator> -- <outer rel> <outer args>`. It walks up from the current
 * folder to the first Git checkout top (a `.git` folder or a linked worktree's
 * `.git` file) and runs that checkout's outer in this process with the same
 * arguments. No checkout: exit 1, as `deft-hook` outside a repository (O-08).
 * No outer in that checkout: block (exit 2) with the install message.
 * Node built-ins only; never looks past the first checkout top.
 */
export const HOST_HOOK_LOCATOR_SOURCE = [
  'const f=require("node:fs"),p=require("node:path"),u=require("node:url");',
  "const [r,...a]=process.argv.slice(1);let d=process.cwd();",
  'for(;!f.existsSync(p.join(d,".git"));d=p.dirname(d))if(p.dirname(d)===d)process.exit(1);',
  "const o=p.join(d,r);",
  'const no=m=>{process.stderr.write(m+"\\n");process.exit(2)};',
  `if(!f.existsSync(o))no(${JSON.stringify(HOST_HOOK_LOCATOR_NO_OUTER_MESSAGE)}+" ("+d+")");`,
  "process.argv=[process.argv[0],o,...a];",
  "import(u.pathToFileURL(o).href).catch(e=>no(String(e)));",
].join("");

/** Text form of a locator entry; matchers read entries through {@link hostHookEntryText}. */
export const HOST_HOOK_LOCATOR_TEXT = "node -e <locator> --";

/**
 * Hosts that run hooks from the agent's current folder and offer a no-shell
 * form (AC9.1 v261119). Codex runs hooks from the session folder but has only
 * a shell string, so it keeps `node <rel>` (documented limitation).
 */
export function hostHookUsesLocator(host: HookHost): boolean {
  return host === "claude";
}

/**
 * Registered entry prefix as text (host/event args appended by callers):
 * `node -e <locator> -- <rel>` for locator hosts, `node <rel>` otherwise.
 */
export function hostHookEntryPrefix(host: HookHost, sha8: string): string {
  const rel = hostHookOuterRelPath(host, sha8);
  return hostHookUsesLocator(host) ? `${HOST_HOOK_LOCATOR_TEXT} ${rel}` : `node ${rel}`;
}

/** Entry fields for one registered hook from its text form. */
export function hostHookEntryFields(commandText: string): { command: string; args?: string[] } {
  const prefix = `${HOST_HOOK_LOCATOR_TEXT} `;
  if (!commandText.startsWith(prefix)) return { command: commandText };
  const rest = commandText.slice(prefix.length).trim().split(/\s+/);
  return { command: "node", args: ["-e", HOST_HOOK_LOCATOR_SOURCE, "--", ...rest] };
}

/**
 * Text form of a registered hook entry: `command` alone, or `command` plus
 * `args` for the no-shell form. Only today's locator source reads as
 * `<locator>`; any other `node -e` script keeps its own text, so a user's
 * hook is never taken for Directive's. Null when there is no command.
 */
export function hostHookEntryText(hook: unknown): string | null {
  if (hook === null || typeof hook !== "object" || Array.isArray(hook)) return null;
  const { command, args } = hook as { command?: unknown; args?: unknown };
  if (typeof command !== "string") return null;
  if (args === undefined) return command;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  const list = args as string[];
  if (
    command === "node" &&
    list[0] === "-e" &&
    list[1] === HOST_HOOK_LOCATOR_SOURCE &&
    list[2] === "--"
  ) {
    return [HOST_HOOK_LOCATOR_TEXT, ...list.slice(3)].join(" ");
  }
  return [command, ...list].join(" ");
}

/**
 * Text forms of every hook entry in a host config file, one per line, so text
 * checks see no-shell entries as `node -e <locator> -- <rel> …`. Raw text when
 * the file is not JSON.
 */
export function hostHookConfigEntryLines(configText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return configText;
  }
  const lines: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        // A bare command string listed directly in an event array.
        if (typeof item === "string") lines.push(item);
        else walk(item);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    const text = hostHookEntryText(value);
    if (text !== null) lines.push(text);
    for (const [key, child] of Object.entries(value)) {
      // `args` belong to the entry text above; walking them would list the locator source.
      if (key !== "args") walk(child);
    }
  };
  walk(parsed);
  return lines.join("\n");
}

/**
 * Reason the outer gives when the pin exists but hook-bin reached no decision
 * (spawn error, signal / null status, non-zero exit, stdout capture failure,
 * or malformed Grok output): the `hook-failed` row (#6201 / #6166).
 */
export const HOST_HOOK_NONDECISION_REASON = ENTRY_GUARD_MESSAGES["hook-failed"];

/**
 * Pure ESM outer source deposited under each host dir.
 * Keep this string the SoT for sha8; tests assert F1 order + messaging.
 *
 * #6201 / #6166: every failure path goes through `blockToolCall`. On
 * `tool.before` it uses the host's blocking form (Claude/Codex exit 2,
 * Cursor and Grok one deny JSON on exit 0). Other events keep today's exit
 * codes (D-018). Child stdout is captured so a failed run never leaks a
 * partial decision, and Grok output must be one decision or empty.
 */
export function hostHookOuterSource(): string {
  const guidance = HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE;
  const nondecision = HOST_HOOK_NONDECISION_REASON;
  const pinRel = HOST_HOOK_OUTER_PIN_HOOK_BIN_REL;
  const reasonSlot = "{reason}" as KillSwitchRecordInvalidReason;
  const invalidWarning = formatInvalidKillRecordWarning(reasonSlot, false);
  const invalidWarningFlag = formatInvalidKillRecordWarning(reasonSlot, true);
  const recoveryCommands = PIN_MISMATCH_RECOVERY_COMMANDS.map((tokens) => [...tokens]);
  const shellToolNames = [
    ...new Set(SHELL_TOOL_NAMES.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""))),
  ];
  return `#!/usr/bin/env node
/**
 * Directive host-hook outer (v261027 / #5994 / #6122 / #6201 / #6620 / #6740 / #7275).
 * Node built-ins only. Shared entry order: valid kill record → runtime missing
 * (admit exact project install on tool.before; else block) → spawn pin
 * hook-bin.js with the kill-switch reader flag.
 * A bare root flag file turns nothing off; it gets one warning.
 * Any failure on tool.before blocks the tool call in the host's own form.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const GUIDANCE = ${JSON.stringify(guidance)};
const NONDECISION = ${JSON.stringify(nondecision)};
const PIN_REL = ${JSON.stringify(pinRel)};
const FLAG = ${JSON.stringify(KILL_SWITCH_BARE_FLAG_NAME)};
const RECORD_REL = ${JSON.stringify(KILL_SWITCH_RECORD_REL)};
const SCHEMA_LINE = ${JSON.stringify(KILL_SWITCH_RECORD_SCHEMA_LINE)};
const GIT_DIR_PREFIX = ${JSON.stringify(KILL_SWITCH_RECORD_GIT_DIR_PREFIX)};
const READER_ARGS = [${JSON.stringify(KILL_SWITCH_READER_FLAG)}, ${JSON.stringify(KILL_SWITCH_READER_VERSION)}];
const BARE_FLAG_WARNING = ${JSON.stringify(KILL_SWITCH_BARE_FLAG_WARNING)};
const INVALID_WARNING = ${JSON.stringify(invalidWarning)};
const INVALID_WARNING_FLAG = ${JSON.stringify(invalidWarningFlag)};
const RECOVERY_COMMANDS = ${JSON.stringify(recoveryCommands)};
const SHELL_TOOL_NAMES = ${JSON.stringify(shellToolNames)};
const SIMPLE_COMMAND = new RegExp(${JSON.stringify(PIN_MISMATCH_SIMPLE_COMMAND_SOURCE)});
const RUN_DIR_FIELDS = ["workdir", "cwd", "working_directory", "workingDirectory"];

const here = dirname(fileURLToPath(import.meta.url));

function findProjectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start, "../..");
    dir = parent;
  }
}

function parseArg(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return "";
}

function isRegularFile(path) {
  try {
    const lst = lstatSync(path);
    if (lst.isSymbolicLink()) return false;
    return lst.isFile();
  } catch {
    return false;
  }
}

/** git rev-parse --absolute-git-dir with trailing newlines removed, or "". */
function absoluteGitDir(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return "";
  return r.stdout.replace(/\\n+$/, "");
}

/**
 * Kill record verdict (#6740): "absent", "valid", or an invalid reason. Exact
 * whole lines (CR removed, split on LF); the same contract as every other reader.
 */
function killRecordVerdict(root) {
  const path = join(root, RECORD_REL);
  let lst;
  try {
    lst = lstatSync(path);
  } catch {
    return "absent";
  }
  if (lst.isSymbolicLink() || !lst.isFile()) return "not-a-regular-file";
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "unreadable";
  }
  const lines = text.replace(/\\r/g, "").split("\\n");
  if (!lines.includes(SCHEMA_LINE)) return "missing-schema-line";
  const gitDir = absoluteGitDir(root);
  if (gitDir.length === 0) return "git-dir-unresolved";
  if (!lines.includes(GIT_DIR_PREFIX + gitDir)) return "git-dir-mismatch";
  return "valid";
}

/** The one warning for a bare flag or an invalid record, or "". */
function killSwitchWarning(root, verdict) {
  const flag = isRegularFile(join(root, FLAG));
  if (verdict !== "absent") {
    return (flag ? INVALID_WARNING_FLAG : INVALID_WARNING).replace("{reason}", () => verdict);
  }
  return flag ? BARE_FLAG_WARNING : "";
}

/** The project install named in GUIDANCE, from the lockfile at root (AC9.12). */
function installCommand(root) {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "\`pnpm install --frozen-lockfile\`";
  if (existsSync(join(root, "package-lock.json"))) return "\`npm install\`";
  return "\`npm install\` (or \`pnpm install --frozen-lockfile\`)";
}

/**
 * Intentional allow. agy treats exit 0 with empty stdout as allow on a real
 * call, so on agy tool.before the allow is printed as one decision (#7378).
 */
function quietAllow(host, event) {
  if (host === "agy" && event === "tool.before") {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\\n");
  }
  process.exit(0);
}

/**
 * The single failure exit (#6201). tool.before blocks: Claude/Codex/unknown
 * exit 2, Cursor and Grok one deny JSON on exit 0. Other events: Grok deny
 * JSON on exit 0, every other host stderr + exit 1 (no compaction or prompt
 * blocks, D-018).
 */
function blockToolCall(host, event, reason) {
  if (host === "agy" && event === "tool.before") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\\n");
    process.exit(0);
  }
  if (host === "grok") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\\n");
    process.exit(0);
  }
  if (event === "tool.before" && host === "cursor") {
    process.stdout.write(
      JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }) + "\\n",
    );
    process.exit(0);
  }
  process.stderr.write(reason + "\\n");
  process.exit(event === "tool.before" ? 2 : 1);
}

function nonDecision(detail) {
  return NONDECISION + " (" + detail + ")";
}

/** Grok success output: empty, or exactly one object with decision allow|deny (#6166). */
function grokOutputIsDecision(text) {
  if (text.trim().length === 0) return true;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return parsed.decision === "allow" || parsed.decision === "deny";
}

/** agy success output: exactly one object with decision allow|deny|ask|force_ask (#7378). */
function agyOutputIsDecision(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return ["allow", "deny", "ask", "force_ask"].includes(parsed.decision);
}

${agyHookOrderOuterSource()}

function readStdinUtf8() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function toolInputOf(payload) {
  const input = asRecord(payload);
  if (input === null) return null;
  const toolCall = asRecord(input.tool_call) || asRecord(input.toolCall);
  return (
    asRecord(input.tool_input) ||
    asRecord(input.toolInput) ||
    asRecord(input.input) ||
    asRecord(input.arguments) ||
    (toolCall !== null ? asRecord(toolCall.arguments) : null)
  );
}

function hookToolName(payload) {
  const input = asRecord(payload);
  if (input === null) return null;
  const toolObject = asRecord(input.tool);
  const toolCall = asRecord(input.tool_call) || asRecord(input.toolCall);
  return (
    firstString([input.tool_name]) ||
    firstString([input.toolName]) ||
    (typeof input.tool === "string" ? firstString([input.tool]) : null) ||
    (toolObject !== null ? firstString([toolObject.name]) : null) ||
    (toolCall !== null ? firstString([toolCall.name]) : null)
  );
}

function hookShellCommand(payload) {
  const input = asRecord(payload);
  if (input === null) return null;
  const toolInput = toolInputOf(input);
  return firstString([
    toolInput !== null ? toolInput.command : null,
    toolInput !== null ? toolInput.cmd : null,
    toolInput !== null ? toolInput.shell_command : null,
    input.command,
    input.cmd,
  ]);
}

function normalizeToolName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isShellToolName(name) {
  return SHELL_TOOL_NAMES.includes(normalizeToolName(name));
}

function matchRecoveryCommand(command) {
  if (command === null) return null;
  const trimmed = command.trim();
  if (!SIMPLE_COMMAND.test(trimmed)) return null;
  const tokens = trimmed.split(/[ \\t]+/);
  for (const candidate of RECOVERY_COMMANDS) {
    if (
      candidate.length === tokens.length &&
      candidate.every((token, index) => token === tokens[index])
    ) {
      return candidate.join(" ");
    }
  }
  return null;
}

function rootsMatch(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Directories that prove where a shell tool call runs (#6313 / #7275). */
function shellRunDirectories(host, payload) {
  const input = asRecord(payload);
  if (input === null) return [];
  const toolInput = toolInputOf(input);
  if (toolInput !== null && toolInput !== input) {
    const present = RUN_DIR_FIELDS.filter((field) => field in toolInput);
    if (present.length > 0) {
      const values = present.map((field) => firstString([toolInput[field]]));
      return values.every((value) => value !== null) ? values : [];
    }
  }
  if (host === "codex") return [];
  const outer = firstString([input.cwd]);
  return outer === null ? [] : [outer];
}

/** Admit exact simple project-root installs when pin hook-bin is missing (#7275). */
function admitMissingPinInstall(host, event, projectRoot, payload) {
  if (event !== "tool.before") return false;
  const toolName = hookToolName(payload);
  if (toolName === null || !isShellToolName(toolName)) return false;
  if (matchRecoveryCommand(hookShellCommand(payload)) === null) return false;
  const runDirectories = shellRunDirectories(host, payload);
  return (
    runDirectories.length > 0 &&
    runDirectories.every((dir) => rootsMatch(dir, projectRoot))
  );
}

const root = findProjectRoot(here);
const argv = process.argv.slice(2);
const host = parseArg(argv, "--host");
const event = parseArg(argv, "--event");

const verdict = killRecordVerdict(root);
if (verdict === "valid") {
  quietAllow(host, event);
}

const pin = join(root, PIN_REL);
if (!existsSync(pin)) {
  const warning = killSwitchWarning(root, verdict);
  if (warning.length > 0) process.stderr.write(warning + "\\n");
  // Read stdin only on the missing-pin branch (#7275); installed-pin keeps inherit.
  if (event === "tool.before") {
    const raw = readStdinUtf8();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    if (payload !== null && admitMissingPinInstall(host, event, root, payload)) {
      quietAllow(host, event);
    }
  }
  blockToolCall(host, event, GUIDANCE.replace("{install}", () => installCommand(root)));
}

// agy runs hooks in hook-name order and the last overwrite wins (#7378): check on
// every call that no foreign PreToolUse hook runs at or after Directive's entry.
const agyToolBefore = host === "agy" && event === "tool.before";
let agyRaw = "";
if (agyToolBefore) {
  agyRaw = readStdinUtf8();
  let agyPayload = null;
  try {
    agyPayload = JSON.parse(agyRaw);
  } catch {
    agyPayload = null;
  }
  const agyFindings = agyHookOrderPayloadFindings(agyPayload);
  if (agyFindings.length > 0) blockToolCall(host, event, agyHookOrderDenial(agyFindings));
}

const child = spawnSync(process.execPath, [pin, ...argv, ...READER_ARGS], {
  cwd: root,
  env: process.env,
  stdio: [agyToolBefore ? "pipe" : "inherit", "pipe", "inherit"],
  input: agyToolBefore ? agyRaw : undefined,
  maxBuffer: 16 * 1024 * 1024,
});
if (child.error) {
  blockToolCall(host, event, nonDecision("failed to run pin hook-bin: " + child.error.message));
}
if (child.status === null) {
  const signal = child.signal ? ", signal " + child.signal : "";
  blockToolCall(host, event, nonDecision("pin hook-bin ended without an exit status" + signal));
}
if (child.status !== 0) {
  blockToolCall(host, event, nonDecision("pin hook-bin exited " + child.status));
}
if (!Buffer.isBuffer(child.stdout)) {
  blockToolCall(host, event, nonDecision("pin hook-bin output was not captured"));
}
const text = child.stdout.toString("utf8");
if (host === "grok") {
  if (!grokOutputIsDecision(text)) {
    blockToolCall(host, event, nonDecision("pin hook-bin output is not one Grok decision"));
  }
  if (text.trim().length === 0) process.exit(0);
}
if (agyToolBefore && !agyOutputIsDecision(text)) {
  blockToolCall(host, event, nonDecision("pin hook-bin output is not one agy decision"));
}
process.stdout.write(child.stdout);
`;
}
