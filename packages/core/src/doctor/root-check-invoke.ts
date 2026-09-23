/**
 * Root `check` invocation for the doctor gates-surface warning (#4947).
 * Comment lines are dropped with stripTaskBodyComments before any match.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseTaskfileIncludes } from "../check/consumer-gate-integrity.js";
import {
  isNonExecutingCommandLine,
  lineHasCommandPositionRunner,
  stripTaskBodyComments,
} from "../consumer-check-contract/evaluate.js";

export const ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE =
  "Gates-surface: root task check does not invoke Directive's check. " +
  "The deft include alone is not the gate. " +
  "Prefer `deft check`; else `task deft:check` on an include-only consumer. " +
  "One gate, not two runs.";

export const ROOT_CHECK_DOES_NOT_INVOKE_SUGGESTION =
  "Prefer `deft check`; else `task deft:check` on an include-only consumer. " +
  "One gate, not two runs. Doctor does not rewrite the Taskfile.";

const DIRECTIVE_TASK_NAMES = new Set([
  "deft:check",
  "deft:check:consumer",
  "deft:check:framework-source",
]);

/** Command-position `deft check` / `directive check`, not `checkout` or `check:lint`. */
const DEFT_OR_DIRECTIVE_CHECK_RE = /^(?:sudo\s+)?(?:deft|directive)\s+check(?:\s|$)/;

/** Whole task token only. `task check` and `task check:lint` do not match. */
const TASK_DEFT_CHECK_RE = /^(?:sudo\s+)?task\s+deft:check(?::framework-source|:consumer)?(?:\s|$)/;

export type RootCheckDirectiveKind = "absent" | "invokes" | "does-not-invoke";

export interface RootCheckDirective {
  readonly kind: RootCheckDirectiveKind;
}

interface CmdEntry {
  taskName: string | null;
  shell: string[];
  engineCmd: string | null;
}

/** Body of one `tasks:` key, or null when that exact key is absent. */
export function extractTasksSectionTaskBody(text: string, taskName: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const escaped = taskName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`^${escaped}\\s*:(?:\\s*(?:#.*)?)?$`);
  let inTasks = false;
  let tasksIndent = 0;
  let inTarget = false;
  let targetIndent = 0;
  const body: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (!inTasks) {
      if (/^tasks\s*:/.test(stripped) && indent === 0) {
        inTasks = true;
        tasksIndent = indent;
      }
      continue;
    }
    if (!stripped || stripped.startsWith("#")) {
      if (inTarget) body.push(raw);
      continue;
    }
    if (!inTarget) {
      if (indent <= tasksIndent) break;
      if (indent === tasksIndent + 2 && keyRe.test(stripped)) {
        inTarget = true;
        targetIndent = indent;
      }
      continue;
    }
    if (indent <= targetIndent) break;
    body.push(raw);
  }
  return inTarget ? body.join("\n") : null;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return value.slice(0, i).trim();
  }
  return value.trim();
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalarAfterColon(stripped: string): string {
  const idx = stripped.indexOf(":");
  const rest = idx >= 0 ? stripped.slice(idx + 1) : stripped;
  return unquoteScalar(stripInlineComment(rest));
}

function engineCmdIsCheck(raw: string | null): boolean {
  if (raw === null) return false;
  const scalar = unquoteScalar(stripInlineComment(raw));
  const token = scalar.split(/\s+/)[0] ?? "";
  return token === "check";
}

function shellInvokesDirective(line: string): boolean {
  if (isNonExecutingCommandLine(line)) return false;
  if (lineHasCommandPositionRunner(line, DEFT_OR_DIRECTIVE_CHECK_RE)) return true;
  if (lineHasCommandPositionRunner(line, TASK_DEFT_CHECK_RE)) return true;
  return false;
}

/**
 * True when `engine:invoke` is the dispatcher deposited by the deft include.
 * A root task named `engine:invoke` is consumer-owned and does not qualify.
 */
export function engineInvokeIsDepositedDispatcher(
  projectRoot: string,
  taskfileText: string,
): boolean {
  if (extractTasksSectionTaskBody(taskfileText, "engine:invoke") !== null) return false;
  const includes = parseTaskfileIncludes(taskfileText);
  const deft = includes.get("deft");
  const engine = includes.get("engine");
  if (deft === undefined || engine === undefined) return false;
  const deposited = resolve(dirname(resolve(projectRoot, deft.taskfile)), "tasks", "engine.yml");
  const engineTaskfile = resolve(projectRoot, engine.taskfile);
  if (!samePath(engineTaskfile, deposited)) return false;
  let depositedText: string;
  try {
    depositedText = readFileSync(deposited, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return false;
  }
  return extractTasksSectionTaskBody(depositedText, "invoke") !== null;
}

function sectionKind(stripped: string): "cmds" | "deps" | null {
  if (/^cmds\s*:/.test(stripped)) return "cmds";
  if (/^deps\s*:/.test(stripped)) return "deps";
  return null;
}

function isBlockScalar(rest: string): boolean {
  return rest === "|" || rest === ">" || rest.startsWith("|") || rest.startsWith(">");
}

function applyEntryHead(entry: CmdEntry, rest: string, section: "cmds" | "deps"): void {
  if (rest.length === 0 || isBlockScalar(rest)) return;
  if (rest.startsWith("task:")) {
    entry.taskName = scalarAfterColon(rest);
    return;
  }
  if (rest.startsWith("cmd:")) {
    const cmd = scalarAfterColon(rest);
    if (!isBlockScalar(cmd)) entry.shell.push(cmd);
    return;
  }
  const scalar = unquoteScalar(stripInlineComment(rest));
  if (section === "deps") {
    entry.taskName = scalar;
    return;
  }
  entry.shell.push(scalar);
}

function parseEntries(body: string): CmdEntry[] {
  const lines = stripTaskBodyComments(body).split("\n");
  const entries: CmdEntry[] = [];
  let section: "cmds" | "deps" | null = null;
  let sectionIndent = -1;
  let entry: CmdEntry | null = null;
  let entryIndent = -1;
  let block: "shell" | "vars" | null = null;
  let blockIndent = -1;

  const finish = (): void => {
    if (entry !== null) entries.push(entry);
    entry = null;
    block = null;
  };

  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const indent = raw.length - raw.trimStart().length;
    const stripped = raw.trim();

    if (section !== null && indent <= sectionIndent) {
      finish();
      section = null;
    }
    if (section === null) {
      const kind = sectionKind(stripped);
      if (kind !== null) {
        section = kind;
        sectionIndent = indent;
      }
      continue;
    }

    if (stripped.startsWith("-")) {
      finish();
      entry = { taskName: null, shell: [], engineCmd: null };
      entryIndent = indent;
      block = null;
      const rest = stripped.replace(/^-\s*/, "");
      applyEntryHead(entry, rest, section);
      if (isBlockScalar(rest)) {
        block = "shell";
        blockIndent = indent;
      } else if (rest.startsWith("cmd:")) {
        const cmd = scalarAfterColon(rest);
        if (isBlockScalar(cmd)) {
          block = "shell";
          blockIndent = indent;
        }
      }
      continue;
    }

    if (entry === null) continue;

    if (block === "shell" && indent > entryIndent) {
      entry.shell.push(raw.trim());
      continue;
    }
    if (/^vars\s*:/.test(stripped)) {
      block = "vars";
      blockIndent = indent;
      continue;
    }
    if (block === "vars" && indent > blockIndent) {
      const match = stripped.match(/^ENGINE_CMD\s*:\s*(.*)$/);
      if (match?.[1] !== undefined) entry.engineCmd = match[1].trim();
      continue;
    }
    if (/^task\s*:/.test(stripped) && entry.taskName === null) {
      entry.taskName = scalarAfterColon(stripped);
      continue;
    }
    if (/^cmd\s*:/.test(stripped)) {
      const cmd = scalarAfterColon(stripped);
      if (isBlockScalar(cmd)) {
        block = "shell";
        blockIndent = indent;
      } else {
        entry.shell.push(cmd);
      }
    }
  }
  finish();
  return entries;
}

function checkBodyInvokesDirective(
  projectRoot: string,
  taskfileText: string,
  body: string,
): boolean {
  const deposited = engineInvokeIsDepositedDispatcher(projectRoot, taskfileText);
  for (const entry of parseEntries(body)) {
    if (entry.taskName !== null && DIRECTIVE_TASK_NAMES.has(entry.taskName)) return true;
    if (deposited && entry.taskName === "engine:invoke" && engineCmdIsCheck(entry.engineCmd)) {
      return true;
    }
    for (const line of entry.shell) {
      if (shellInvokesDirective(line)) return true;
    }
  }
  return false;
}

/** Classify the root task named `check` in the Taskfile `resolveConsumerTaskfile` selected. */
export function classifyRootCheckDirective(
  projectRoot: string,
  taskfileText: string,
): RootCheckDirective {
  const body = extractTasksSectionTaskBody(taskfileText, "check");
  if (body === null) return { kind: "absent" };
  if (checkBodyInvokesDirective(projectRoot, taskfileText, body)) return { kind: "invokes" };
  return { kind: "does-not-invoke" };
}
