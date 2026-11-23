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
import type { HookHost } from "../hooks/dispatcher.js";
import {
  ENTRY_GUARD_MESSAGES,
  ENTRY_GUARD_PERSON_RUNS_INSTALL,
} from "../install-health/constants.js";
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
 * The outer's missing-runtime message (AC9.12, D-013): the `runtime-missing`
 * row plus the note that a person runs the install. `{install}` is filled in
 * from the project's lockfile when the outer runs.
 */
export const HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE = `${ENTRY_GUARD_MESSAGES["runtime-missing"]} ${ENTRY_GUARD_PERSON_RUNS_INSTALL}`;

export const HOST_HOOK_OUTER_PIN_HOOK_BIN_REL =
  "node_modules/@deftai/directive-runtime/dist/hook-bin.js";

/** Filename stem + content-hash suffix (AC9.1). */
export function hostHookOuterFileName(sha8: string): string {
  return `deft-hook-${sha8}.mjs`;
}

/** Deposit-relative path for the committed outer (per host). */
export function hostHookOuterRelPath(host: HookHost, sha8: string): string {
  const name = hostHookOuterFileName(sha8);
  switch (host) {
    case "grok":
      return `.grok/hooks/${name}`;
    case "cursor":
      return `.cursor/hooks/${name}`;
    case "claude":
      return `.claude/${name}`;
    case "codex":
      return `.codex/${name}`;
    default: {
      const _exhaustive: never = host;
      return _exhaustive;
    }
  }
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
  return `#!/usr/bin/env node
/**
 * Directive host-hook outer (v261027 / #5994 / #6122 / #6201 / #6620 / #6740). Node built-ins only.
 * Shared entry order: valid kill record → runtime missing (project install, by
 * lockfile) → spawn pin hook-bin.js with the kill-switch reader flag.
 * A bare root flag file turns nothing off; it gets one warning.
 * Any failure on tool.before blocks the tool call in the host's own form.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
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

function quietAllow() {
  process.exit(0);
}

/**
 * The single failure exit (#6201). tool.before blocks: Claude/Codex/unknown
 * exit 2, Cursor and Grok one deny JSON on exit 0. Other events: Grok deny
 * JSON on exit 0, every other host stderr + exit 1 (no compaction or prompt
 * blocks, D-018).
 */
function blockToolCall(host, event, reason) {
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

const root = findProjectRoot(here);
const argv = process.argv.slice(2);
const host = parseArg(argv, "--host");
const event = parseArg(argv, "--event");

const verdict = killRecordVerdict(root);
if (verdict === "valid") {
  quietAllow();
}

const pin = join(root, PIN_REL);
if (!existsSync(pin)) {
  const warning = killSwitchWarning(root, verdict);
  if (warning.length > 0) process.stderr.write(warning + "\\n");
  blockToolCall(host, event, GUIDANCE.replace("{install}", () => installCommand(root)));
}

const child = spawnSync(process.execPath, [pin, ...argv, ...READER_ARGS], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "pipe", "inherit"],
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
process.stdout.write(child.stdout);
`;
}
