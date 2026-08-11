/**
 * Capture exact stated acceptance commands from a task statement (#3267).
 *
 * Only extracts commands that appear literally in the text — never invents
 * or paraphrases. Prefer fenced blocks and labeled lines (verify:/command:/run:).
 */

import type { LiteralAcceptanceCommand, LiteralAcceptanceSource } from "./types.js";

/** Heading tokens that mark an acceptance / verify region. */
const REGION_HEADING_RE =
  /\b(acceptance(\s+(criteria|sketch|commands?))?|verify(\s+commands?)?|verification|done[- ]?gate|check(er)?s?|run\s+verbatim)\b/i;

/** Labeled command lines: `verify: task check`, `command: pnpm test`, etc. */
const LABELED_COMMAND_RE =
  /^\s*(?:[-*+]|\d+[.)])?\s*(?:verify|command|run|check|exec|shell)\s*:\s*(.+?)\s*$/i;

/** Mid-line labeled command: `Also run: verify: node -e "…"` */
const MIDLINE_LABELED_COMMAND_RE = /\b(?:verify|command|exec|shell)\s*:\s*([^\n]+?)\s*$/i;

/** Shell-prompt style: `$ task check` or `> pnpm test`. */
const PROMPT_COMMAND_RE = /^\s*[$>]\s+(\S.*\S|\S)\s*$/;

/** Words that look like a CLI invocation start (not prose). */
const CLI_START_RE =
  /^(?:task|deft|directive|pnpm|npm|npx|yarn|bun|node|python|py|pytest|vitest|cargo|go|dotnet|make|curl|gh|git|uv|pip|poetry|docker|kubectl|rg|sed|awk|cat|ls|echo|true|false|sh|bash|pwsh|powershell)\b/i;

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
      regionActive = requireRegion ? REGION_HEADING_RE.test(heading.text) : true;
      continue;
    }

    const fenceOpen = line.match(/^(`{3,}|~{3,})\s*([a-zA-Z0-9_+-]*)\s*$/);
    if (fenceOpen !== null && !inFence) {
      inFence = true;
      fenceLang = (fenceOpen[2] ?? "").toLowerCase();
      fenceStartLine = i + 1;
      continue;
    }
    if (inFence && /^(`{3,}|~{3,})\s*$/.test(line)) {
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
    const langOk =
      fenceLang === "" ||
      fenceLang === "bash" ||
      fenceLang === "sh" ||
      fenceLang === "shell" ||
      fenceLang === "zsh" ||
      fenceLang === "console" ||
      fenceLang === "powershell" ||
      fenceLang === "pwsh" ||
      fenceLang === "cmd" ||
      fenceLang === "text";

    if (!langOk) continue;

    // Strip leading prompt markers inside fences.
    let body = trimmed;
    if (body.startsWith("$ ") || body.startsWith("> ")) {
      body = body.slice(2).trim();
    }
    const normalized = normalizeCommand(body);
    if (normalized === null) continue;
    if (!looksLikeShellCommand(normalized) && fenceLang === "") continue;
    if (!looksLikeShellCommand(normalized) && !langOk) continue;
    // For empty lang, require CLI shape; for shell langs, accept if non-empty.
    if (fenceLang === "" && !looksLikeShellCommand(normalized)) continue;

    pushUnique(
      out,
      seen,
      normalized,
      "task_statement",
      `fence@L${fenceStartLine}${fenceLang ? `:${fenceLang}` : ""}`,
    );
  }
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
    let labeled = line.match(LABELED_COMMAND_RE);
    if (labeled === null && !/^\s*[$>]\s+/.test(line)) {
      // Avoid treating `$ task verify:branch` as labeled "branch".
      labeled = line.match(MIDLINE_LABELED_COMMAND_RE);
    }
    if (labeled !== null && isNonEmptyString(labeled[1])) {
      const normalized = normalizeCommand(labeled[1]);
      if (normalized !== null && looksLikeShellCommand(normalized)) {
        pushUnique(out, seen, normalized, "task_statement", `labeled@L${i + 1}`);
        capturedLabeled = true;
      }
    }
    if (capturedLabeled) continue;

    const prompt = line.match(PROMPT_COMMAND_RE);
    if (prompt !== null && isNonEmptyString(prompt[1])) {
      const normalized = normalizeCommand(prompt[1]);
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
    return normalized === null
      ? []
      : [
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
      if (normalized !== null) {
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
    if (normalized === null) continue;
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
