/**
 * Capture exact stated acceptance commands from a task statement (#3267).
 *
 * Only extracts commands that appear literally in the text — never invents
 * or paraphrases. Prefer fenced blocks and labeled lines (verify:/command:/run:).
 */

import { evaluateCommandSafety } from "./safety.js";
import type { LiteralAcceptanceCommand, LiteralAcceptanceSource } from "./types.js";

/** Labeled keywords (single-token, linear match). */
const LABELED_KEYWORDS = new Set(["verify", "command", "run", "check", "exec", "shell"]);

/** Words that look like a CLI invocation start (not prose). */
const CLI_START_RE =
  /^(?:task|deft|directive|pnpm|npm|npx|yarn|bun|node|python|py|pytest|vitest|cargo|go|dotnet|make|curl|gh|git|uv|pip|poetry|rg|echo|true|false)\b/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeCommand(raw: string): string | null {
  let s = raw.trim();
  // Strip surrounding backticks once.
  if (s.startsWith("`") && s.endsWith("`") && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }
  // Strip trailing period that is clearly sentence punctuation (not a path).
  if (s.endsWith(".") && !s.endsWith("..") && !/\.\w+$/.test(s)) {
    s = s.slice(0, -1).trim();
  }
  if (s.length === 0) return null;
  // Reject pure prose / multi-sentence blobs without CLI shape.
  if (s.length > 500) return null;
  if (s.includes("\n")) {
    // Multi-line only accepted from fenced blocks (caller splits).
    return null;
  }
  return s;
}

function looksLikeShellCommand(command: string): boolean {
  if (CLI_START_RE.test(command)) return true;
  // Flags or paths suggest a real invocation.
  if (/\s--?[a-zA-Z]/.test(command)) return true;
  // Subcommand shape: word word
  if (/^\S+\s+\S+/.test(command) && !/^[A-Z][a-z]+\s/.test(command)) return true;
  return false;
}

function pushUnique(
  out: LiteralAcceptanceCommand[],
  seen: Set<string>,
  command: string,
  source: LiteralAcceptanceSource,
  sourceSpan: string | null,
): void {
  // Refuse unsafe / non-allowlisted commands at capture (defense in depth with run gate).
  if (!evaluateCommandSafety(command).ok) return;
  const key = command;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    command,
    cwd: null,
    expectedStdout: null,
    expectedExitCode: 0,
    source,
    sourceSpan,
  });
}

/** Linear: does heading text mention acceptance/verify regions? */
function isRegionHeading(text: string): boolean {
  const low = text.toLowerCase();
  if (low.includes("acceptance")) return true;
  if (low.includes("verify") || low.includes("verification")) return true;
  if (low.includes("done-gate") || low.includes("done gate")) return true;
  if (low.includes("run verbatim")) return true;
  if (low === "check" || low.startsWith("check ") || low.endsWith(" check")) return true;
  return false;
}

/** Skip leading spaces/tabs only (bounded, linear). */
function skipWs(line: string, start: number): number {
  let i = start;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  return i;
}

/** Parse `verify: cmd` / bullet-prefixed labeled lines without polynomial regex. */
function matchLabeledCommand(line: string): string | null {
  let i = skipWs(line, 0);
  // Optional bullet or number prefix.
  if (i < line.length && "-*+".includes(line[i] as string)) {
    i = skipWs(line, i + 1);
  } else if (i < line.length) {
    const ch = line[i] as string;
    if (ch >= "0" && ch <= "9") {
      while (i < line.length) {
        const d = line[i] as string;
        if (d < "0" || d > "9") break;
        i += 1;
      }
      if (i < line.length && (line[i] === "." || line[i] === ")")) i += 1;
      i = skipWs(line, i);
    }
  }
  const keywordStart = i;
  while (i < line.length && /[a-zA-Z]/.test(line[i] as string)) i += 1;
  if (i === keywordStart) return null;
  const keyword = line.slice(keywordStart, i).toLowerCase();
  if (!LABELED_KEYWORDS.has(keyword)) return null;
  i = skipWs(line, i);
  if (i >= line.length || line[i] !== ":") return null;
  i = skipWs(line, i + 1);
  if (i >= line.length) return null;
  return line.slice(i).trimEnd();
}

/** Mid-line `verify: cmd` (e.g. "Also run: verify: task check"). */
function matchMidlineLabeled(line: string): string | null {
  const low = line.toLowerCase();
  for (const kw of LABELED_KEYWORDS) {
    if (kw === "run" || kw === "check") continue; // too ambiguous mid-line
    const needle = `${kw}:`;
    const idx = low.indexOf(needle);
    if (idx < 0) continue;
    const rest = line.slice(idx + needle.length).trim();
    if (rest.length > 0) return rest;
  }
  return null;
}

/** `$ cmd` or `> cmd` prompt lines. */
function matchPromptCommand(line: string): string | null {
  let i = skipWs(line, 0);
  if (i >= line.length) return null;
  if (line[i] !== "$" && line[i] !== ">") return null;
  i = skipWs(line, i + 1);
  if (i >= line.length) return null;
  return line.slice(i).trimEnd();
}

/**
 * Walk fenced ``` / ~~~ blocks; keep fence body lines that look like shell.
 * When `requireRegion` is true, only fences under an acceptance/verify heading.
 */
function extractFromFences(
  text: string,
  requireRegion: boolean,
  out: LiteralAcceptanceCommand[],
  seen: Set<string>,
): void {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let fenceLang = "";
  let regionActive = !requireRegion;
  let fenceStartLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const heading = matchMarkdownHeading(line);
    if (heading !== null && !inFence) {
      regionActive = requireRegion ? isRegionHeading(heading.text) : true;
      continue;
    }

    const fenceOpen = matchFenceOpen(line);
    if (fenceOpen !== null && !inFence) {
      inFence = true;
      fenceLang = fenceOpen.lang;
      fenceStartLine = i + 1;
      continue;
    }
    if (inFence && matchFenceClose(line)) {
      inFence = false;
      fenceLang = "";
      continue;
    }
    if (!inFence) continue;
    if (requireRegion && !regionActive) continue;

    // Skip comment-only fence lines.
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }
    // Shell-ish langs always accepted; unknown langs need CLI shape.
    const langOk = isShellFenceLang(fenceLang);
    if (!langOk && fenceLang !== "") continue;

    // Strip leading prompt markers inside fences.
    let body = trimmed;
    if (body.startsWith("$ ") || body.startsWith("> ")) {
      body = body.slice(2).trim();
    }
    const normalized = normalizeCommand(body);
    if (normalized === null) continue;
    if (!looksLikeShellCommand(normalized) && (fenceLang === "" || !langOk)) continue;

    pushUnique(
      out,
      seen,
      normalized,
      "task_statement",
      `fence@L${fenceStartLine}${fenceLang ? `:${fenceLang}` : ""}`,
    );
  }
}

function isShellFenceLang(lang: string): boolean {
  return (
    lang === "" ||
    lang === "bash" ||
    lang === "sh" ||
    lang === "shell" ||
    lang === "zsh" ||
    lang === "console" ||
    lang === "powershell" ||
    lang === "pwsh" ||
    lang === "cmd" ||
    lang === "text"
  );
}

/** Linear fence open: ```lang or ~~~lang */
function matchFenceOpen(line: string): { lang: string } | null {
  const t = line.trimEnd();
  if (t.startsWith("```")) {
    const rest = t.slice(3).trim().toLowerCase();
    if (rest.includes(" ") || rest.includes("\t")) return null;
    return { lang: rest };
  }
  if (t.startsWith("~~~")) {
    const rest = t.slice(3).trim().toLowerCase();
    if (rest.includes(" ") || rest.includes("\t")) return null;
    return { lang: rest };
  }
  return null;
}

function matchFenceClose(line: string): boolean {
  const t = line.trim();
  return t === "```" || t === "~~~";
}

function matchMarkdownHeading(line: string): { level: number; text: string } | null {
  if (!line.startsWith("#")) return null;
  let level = 0;
  while (level < line.length && line[level] === "#") level += 1;
  if (level < 1 || level > 6) return null;
  if (level >= line.length || line[level] !== " ") return null;
  return { level, text: line.slice(level + 1).trim() };
}

/** Extract from labeled lines and `$` prompts anywhere in the statement. */
function extractFromLabeledLines(
  text: string,
  out: LiteralAcceptanceCommand[],
  seen: Set<string>,
): void {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    let capturedLabeled = false;
    let labeledBody = matchLabeledCommand(line);
    if (labeledBody === null && matchPromptCommand(line) === null) {
      // Avoid treating `$ task verify:branch` as labeled "branch".
      labeledBody = matchMidlineLabeled(line);
    }
    if (labeledBody !== null) {
      const normalized = normalizeCommand(labeledBody);
      if (normalized !== null && looksLikeShellCommand(normalized)) {
        pushUnique(out, seen, normalized, "task_statement", `labeled@L${i + 1}`);
        capturedLabeled = true;
      }
    }
    if (capturedLabeled) continue;

    const promptBody = matchPromptCommand(line);
    if (promptBody !== null) {
      const normalized = normalizeCommand(promptBody);
      if (normalized !== null && looksLikeShellCommand(normalized)) {
        pushUnique(out, seen, normalized, "task_statement", `prompt@L${i + 1}`);
      }
    }
  }
}

/**
 * Extract inline `` `command` `` spans that follow verify/run language on the same line.
 * Example: `run \`task check\` before done`
 */
function extractInlineVerifySpans(
  text: string,
  out: LiteralAcceptanceCommand[],
  seen: Set<string>,
): void {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/\b(verify|run|execute|acceptance)\b/i.test(line)) continue;
    let pos = 0;
    while (pos < line.length) {
      const open = line.indexOf("`", pos);
      if (open < 0) break;
      const close = line.indexOf("`", open + 1);
      if (close < 0) break;
      const inner = line.slice(open + 1, close);
      pos = close + 1;
      if (inner.includes("\n")) continue;
      const normalized = normalizeCommand(inner);
      if (normalized === null || !looksLikeShellCommand(normalized)) continue;
      pushUnique(out, seen, normalized, "task_statement", `inline@L${i + 1}`);
    }
  }
}

/**
 * Capture literal acceptance commands from free-form task statement text.
 * Returns [] when none are stated — never invents commands.
 */
export function captureLiteralAcceptanceCommands(
  taskStatement: string,
): LiteralAcceptanceCommand[] {
  if (!isNonEmptyString(taskStatement)) {
    return [];
  }
  const out: LiteralAcceptanceCommand[] = [];
  const seen = new Set<string>();

  // Prefer fences under acceptance/verify headings first.
  extractFromFences(taskStatement, true, out, seen);
  // Then any shell fences in the whole statement (still literal, not invented).
  extractFromFences(taskStatement, false, out, seen);
  extractFromLabeledLines(taskStatement, out, seen);
  extractInlineVerifySpans(taskStatement, out, seen);

  return out;
}

/**
 * Read already-stored commands from plan.metadata / swarm.verify_commands / item.command.
 * Preserves exact strings; does not re-parse or paraphrase.
 */
export function readStoredLiteralAcceptanceCommands(
  plan: Record<string, unknown> | null | undefined,
): LiteralAcceptanceCommand[] {
  if (plan === null || plan === undefined || typeof plan !== "object") {
    return [];
  }
  const out: LiteralAcceptanceCommand[] = [];
  const seen = new Set<string>();

  const metadata = asRecord(plan.metadata);
  if (metadata !== null) {
    const explicit =
      metadata.literal_acceptance_commands ?? metadata.literalAcceptanceCommands ?? null;
    for (const cmd of coerceCommandList(explicit, "explicit", "metadata.literal_acceptance")) {
      pushUnique(out, seen, cmd.command, cmd.source, cmd.sourceSpan ?? null);
    }

    const swarm = asRecord(metadata.swarm);
    if (swarm !== null) {
      for (const cmd of coerceCommandList(
        swarm.verify_commands,
        "verify_commands",
        "swarm.verify_commands",
      )) {
        pushUnique(out, seen, cmd.command, cmd.source, cmd.sourceSpan ?? null);
      }
      for (const cmd of coerceCommandList(
        swarm.literal_acceptance_commands ?? swarm.literalAcceptanceCommands,
        "metadata",
        "swarm.literal_acceptance",
      )) {
        pushUnique(out, seen, cmd.command, cmd.source, cmd.sourceSpan ?? null);
      }
    }
  }

  walkPlanItems(plan.items, "items", out, seen);
  return out;
}

function walkPlanItems(
  items: unknown,
  pathPrefix: string,
  out: LiteralAcceptanceCommand[],
  seen: Set<string>,
): void {
  if (!Array.isArray(items)) return;
  items.forEach((item, index) => {
    const rec = asRecord(item);
    if (rec === null) return;
    const path = `${pathPrefix}[${index}]`;
    const commandField = rec.command ?? rec.verify ?? rec.verify_command;
    if (isNonEmptyString(commandField)) {
      const normalized = normalizeCommand(commandField);
      if (normalized !== null) {
        pushUnique(out, seen, normalized, "plan_item", `${path}.command`);
      }
    }
    walkPlanItems(rec.subItems, `${path}.subItems`, out, seen);
    walkPlanItems(rec.items, `${path}.items`, out, seen);
  });
}

function coerceCommandList(
  raw: unknown,
  source: LiteralAcceptanceSource,
  span: string,
): LiteralAcceptanceCommand[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === "string") {
    const normalized = normalizeCommand(raw);
    if (normalized === null || !evaluateCommandSafety(normalized).ok) return [];
    return [
      {
        command: normalized,
        cwd: null,
        expectedStdout: null,
        expectedExitCode: 0,
        source,
        sourceSpan: span,
      },
    ];
  }
  if (!Array.isArray(raw)) return [];
  const out: LiteralAcceptanceCommand[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const normalized = normalizeCommand(entry);
      if (normalized !== null && evaluateCommandSafety(normalized).ok) {
        out.push({
          command: normalized,
          cwd: null,
          expectedStdout: null,
          expectedExitCode: 0,
          source,
          sourceSpan: span,
        });
      }
      continue;
    }
    const rec = asRecord(entry);
    if (rec === null) continue;
    const command = rec.command ?? rec.cmd ?? rec.shell;
    if (!isNonEmptyString(command)) continue;
    const normalized = normalizeCommand(command);
    if (normalized === null || !evaluateCommandSafety(normalized).ok) continue;
    out.push({
      command: normalized,
      cwd: isNonEmptyString(rec.cwd) ? rec.cwd.trim() : null,
      expectedStdout: isNonEmptyString(rec.expectedStdout)
        ? rec.expectedStdout
        : isNonEmptyString(rec.expected_stdout)
          ? rec.expected_stdout
          : null,
      expectedExitCode:
        typeof rec.expectedExitCode === "number"
          ? rec.expectedExitCode
          : typeof rec.expected_exit_code === "number"
            ? rec.expected_exit_code
            : 0,
      source,
      sourceSpan: span,
    });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Attach captured commands onto plan.metadata without paraphrasing.
 * Merges with existing literal_acceptance_commands and swarm.verify_commands.
 * Returns a shallow-cloned plan with updated metadata.
 */
export function attachLiteralAcceptanceCommands(
  plan: Record<string, unknown>,
  commands: readonly LiteralAcceptanceCommand[],
): Record<string, unknown> {
  if (commands.length === 0) {
    return plan;
  }
  const metadata = {
    ...(asRecord(plan.metadata) ?? {}),
  };
  const existing = readStoredLiteralAcceptanceCommands(plan);
  const merged = mergeCommands(existing, commands);
  metadata.literal_acceptance_commands = merged.map(toSerializable);
  // Keep swarm.verify_commands in sync when swarm block exists or is created.
  const swarm = { ...(asRecord(metadata.swarm) ?? {}) };
  const verifyList = merged.map((c) => c.command);
  const prevVerify = Array.isArray(swarm.verify_commands)
    ? swarm.verify_commands.filter((x): x is string => typeof x === "string")
    : [];
  const verifyMerged = [...prevVerify];
  for (const cmd of verifyList) {
    if (!verifyMerged.includes(cmd)) verifyMerged.push(cmd);
  }
  swarm.verify_commands = verifyMerged;
  metadata.swarm = swarm;

  return {
    ...plan,
    metadata,
  };
}

/**
 * Capture from task statement text and attach onto a plan (intake helper).
 */
export function captureAndAttachLiteralAcceptance(
  plan: Record<string, unknown>,
  taskStatement: string,
): {
  readonly plan: Record<string, unknown>;
  readonly commands: readonly LiteralAcceptanceCommand[];
} {
  const captured = captureLiteralAcceptanceCommands(taskStatement);
  if (captured.length === 0) {
    return { plan, commands: readStoredLiteralAcceptanceCommands(plan) };
  }
  const next = attachLiteralAcceptanceCommands(plan, captured);
  return { plan: next, commands: readStoredLiteralAcceptanceCommands(next) };
}

function mergeCommands(
  a: readonly LiteralAcceptanceCommand[],
  b: readonly LiteralAcceptanceCommand[],
): LiteralAcceptanceCommand[] {
  const seen = new Set<string>();
  const out: LiteralAcceptanceCommand[] = [];
  for (const cmd of [...a, ...b]) {
    if (seen.has(cmd.command)) continue;
    seen.add(cmd.command);
    out.push(cmd);
  }
  return out;
}

function toSerializable(cmd: LiteralAcceptanceCommand): Record<string, unknown> {
  const row: Record<string, unknown> = {
    command: cmd.command,
    source: cmd.source,
  };
  if (cmd.cwd !== null && cmd.cwd !== undefined && cmd.cwd.length > 0) {
    row.cwd = cmd.cwd;
  }
  if (
    cmd.expectedStdout !== null &&
    cmd.expectedStdout !== undefined &&
    cmd.expectedStdout.length > 0
  ) {
    row.expectedStdout = cmd.expectedStdout;
  }
  if (cmd.expectedExitCode !== undefined && cmd.expectedExitCode !== 0) {
    row.expectedExitCode = cmd.expectedExitCode;
  }
  if (cmd.sourceSpan !== null && cmd.sourceSpan !== undefined && cmd.sourceSpan.length > 0) {
    row.sourceSpan = cmd.sourceSpan;
  }
  return row;
}
