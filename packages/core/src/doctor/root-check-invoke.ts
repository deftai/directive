/**
 * Root `check` invocation for the doctor gates-surface warning (#4947).
 * Comment lines are dropped with stripTaskBodyComments before any match.
 * A folded block command is one joined shell command. A literal block keeps
 * one command per line. ignore_error: true is not an invocation.
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
  ignoreError: boolean;
}

interface ShellPiece {
  indent: number;
  text: string;
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

const LITERAL_BLOCK_RE = /^\|(?:[+-]?[1-9]?|[1-9][+-]?)$/;
const FOLDED_BLOCK_RE = /^>(?:[+-]?[1-9]?|[1-9][+-]?)$/;

function blockScalarStyle(rest: string): "literal" | "folded" | null {
  const head = stripInlineComment(rest).trim();
  if (LITERAL_BLOCK_RE.test(head)) return "literal";
  if (FOLDED_BLOCK_RE.test(head)) return "folded";
  return null;
}

function scalarIsTrue(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

/** Same-indent folded lines join. A deeper line stays its own command. */
function foldCommands(pieces: readonly ShellPiece[]): string[] {
  const commands: string[] = [];
  let bucket: string[] = [];
  const flush = (): void => {
    const joined = bucket.join(" ").trim();
    if (joined.length > 0) commands.push(joined);
    bucket = [];
  };
  let base = -1;
  for (const piece of pieces) {
    if (piece.text.length === 0) {
      flush();
      continue;
    }
    if (base < 0) base = piece.indent;
    if (piece.indent > base) {
      flush();
      commands.push(piece.text);
      continue;
    }
    bucket.push(piece.text);
  }
  flush();
  return commands;
}

function splitFlowItems(inner: string): string[] | null {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? "";
    if (quote !== null) {
      current += ch;
      if (ch === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth < 0) return null;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote !== null || depth !== 0) return null;
  const last = current.trim();
  if (last.length > 0) items.push(last);
  return items;
}

function flowItemToEntry(item: string): CmdEntry | null {
  if (item.startsWith("{") && item.endsWith("}")) {
    const fields = splitFlowItems(item.slice(1, -1));
    if (fields === null) return null;
    let taskName: string | null = null;
    let ignoreError = false;
    for (const field of fields) {
      const idx = field.indexOf(":");
      if (idx < 0) continue;
      const key = field.slice(0, idx).trim();
      const value = unquoteScalar(stripInlineComment(field.slice(idx + 1)));
      if (key === "task") taskName = value;
      if (key === "ignore_error" && scalarIsTrue(value)) ignoreError = true;
    }
    if (taskName === null || taskName.length === 0) return null;
    return { taskName, shell: [], engineCmd: null, ignoreError };
  }
  const taskName = unquoteScalar(stripInlineComment(item));
  if (taskName.length === 0) return null;
  return { taskName, shell: [], engineCmd: null, ignoreError: false };
}

/** Same-line `deps: [deft:check]` flow sequence. Null when the line is not one. */
function parseFlowDeps(rest: string): CmdEntry[] | null {
  const trimmed = rest.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const items = splitFlowItems(trimmed.slice(1, -1));
  if (items === null) return null;
  const parsed: CmdEntry[] = [];
  for (const item of items) {
    if (item.length === 0) continue;
    const entry = flowItemToEntry(item);
    if (entry !== null) parsed.push(entry);
  }
  return parsed;
}

function taskLevelIgnoresError(body: string): boolean {
  const lines = stripTaskBodyComments(body).split("\n");
  let keyIndent: number | null = null;
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const indent = raw.length - raw.trimStart().length;
    if (keyIndent === null || indent < keyIndent) keyIndent = indent;
  }
  if (keyIndent === null) return false;
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent !== keyIndent) continue;
    const stripped = raw.trim();
    if (/^ignore_error\s*:/.test(stripped) && scalarIsTrue(scalarAfterColon(stripped))) {
      return true;
    }
  }
  return false;
}

function applyEntryHead(entry: CmdEntry, rest: string, section: "cmds" | "deps"): void {
  if (rest.length === 0 || blockScalarStyle(rest) !== null) return;
  if (rest.startsWith("task:")) {
    entry.taskName = scalarAfterColon(rest);
    return;
  }
  if (rest.startsWith("cmd:")) {
    const cmd = scalarAfterColon(rest);
    if (blockScalarStyle(cmd) === null) entry.shell.push(cmd);
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
  let blockStyle: "literal" | "folded" | null = null;
  let contentIndent = -1;
  let shellPieces: ShellPiece[] = [];

  const commitShell = (): void => {
    const current = entry;
    if (current !== null && blockStyle !== null) {
      if (blockStyle === "literal") {
        for (const piece of shellPieces) {
          if (piece.text.length > 0) current.shell.push(piece.text);
        }
      } else {
        for (const command of foldCommands(shellPieces)) current.shell.push(command);
      }
    }
    shellPieces = [];
    blockStyle = null;
    contentIndent = -1;
    if (block === "shell") block = null;
  };

  const finish = (): void => {
    commitShell();
    if (entry !== null) entries.push(entry);
    entry = null;
    block = null;
  };

  // Caller assigns block = "shell". A write only in this closure is invisible to
  // loop narrowing, so a later `block === "shell"` check becomes unreachable (TS2367).
  const beginShell = (indicator: string, indicatorIndent: number): boolean => {
    const style = blockScalarStyle(indicator);
    if (style === null) return false;
    blockStyle = style;
    blockIndent = indicatorIndent;
    contentIndent = -1;
    shellPieces = [];
    return true;
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
        if (kind === "deps") {
          const flow = parseFlowDeps(scalarAfterColon(stripped));
          if (flow !== null) {
            for (const item of flow) entries.push(item);
          }
        }
      }
      continue;
    }

    if (stripped.startsWith("-")) {
      finish();
      entry = { taskName: null, shell: [], engineCmd: null, ignoreError: false };
      entryIndent = indent;
      block = null;
      const rest = stripped.replace(/^-\s*/, "");
      applyEntryHead(entry, rest, section);
      if (beginShell(rest, indent)) {
        block = "shell";
      } else if (rest.startsWith("cmd:")) {
        const cmd = scalarAfterColon(rest);
        if (beginShell(cmd, indent)) block = "shell";
      }
      continue;
    }

    if (entry === null) continue;
    const current = entry;

    if (block === "shell") {
      const endsBlock = indent <= blockIndent || (contentIndent >= 0 && indent < contentIndent);
      if (!endsBlock) {
        if (contentIndent < 0) contentIndent = indent;
        shellPieces.push({ indent, text: stripped });
        continue;
      }
      commitShell();
    }

    if (/^ignore_error\s*:/.test(stripped) && indent > entryIndent) {
      if (scalarIsTrue(scalarAfterColon(stripped))) current.ignoreError = true;
      continue;
    }
    if (/^vars\s*:/.test(stripped)) {
      block = "vars";
      blockIndent = indent;
      continue;
    }
    if (block === "vars" && indent > blockIndent) {
      const match = stripped.match(/^ENGINE_CMD\s*:\s*(.*)$/);
      if (match?.[1] !== undefined) current.engineCmd = match[1].trim();
      continue;
    }
    if (/^task\s*:/.test(stripped) && current.taskName === null) {
      current.taskName = scalarAfterColon(stripped);
      continue;
    }
    if (/^cmd\s*:/.test(stripped)) {
      const cmd = scalarAfterColon(stripped);
      if (beginShell(cmd, indent)) {
        block = "shell";
      } else {
        current.shell.push(cmd);
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
  if (taskLevelIgnoresError(body)) return false;
  const deposited = engineInvokeIsDepositedDispatcher(projectRoot, taskfileText);
  for (const entry of parseEntries(body)) {
    if (entry.ignoreError) continue;
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
