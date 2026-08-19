/**
 * Capture exact stated acceptance commands from a task statement (#3267).
 *
 * Only extracts commands that appear literally in the text — never invents
 * or paraphrases. Prefer fenced blocks and labeled lines (verify:/command:/run:).
 *
 * Safety-rejected shell-shaped lines are recorded on a rejected ledger so they
 * do not vanish silently (#3267 residual). Dedup keys include cwd/expectedExitCode
 * so distinct execution contexts are not collapsed.
 */

import { evaluateCommandSafety } from "./safety.js";
import type {
  LiteralAcceptanceCommand,
  LiteralAcceptanceSource,
  RejectedLiteralCommand,
} from "./types.js";
import { EXECUTABLE_LITERAL_SOURCES, LITERAL_ACCEPTANCE_REJECTED_METADATA_KEY } from "./types.js";

/** Labeled keywords (single-token, linear match). */
const LABELED_KEYWORDS = new Set(["verify", "command", "run", "check", "exec", "shell"]);

/** Words that look like a CLI invocation start (not prose). */
const CLI_START_RE =
  /^(?:task|deft|directive|pnpm|npm|npx|yarn|bun|node|python|py|pytest|vitest|cargo|go|dotnet|make|curl|gh|git|uv|pip|poetry|rg|echo|true|false)\b/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalize a captured command string.
 * Trailing period is stripped only when it is sentence punctuation — not when the
 * last token is `.` / `..` (cwd / parent path, e.g. `docker build .`).
 */
function normalizeCommand(raw: string): string | null {
  let s = raw.trim();
  // Strip surrounding backticks once.
  if (s.startsWith("`") && s.endsWith("`") && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }
  // Strip trailing period that is clearly sentence punctuation (not a path token).
  // Preserve: `file.ts`, `..`, and commands ending in whitespace+`.` (cwd path).
  if (s.endsWith(".") && !s.endsWith("..") && !/\.\w+$/.test(s) && !/\s\.$/.test(s) && s !== ".") {
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

/** Dedupe key includes execution context so distinct cwd/exit targets stay distinct. */
function commandDedupeKey(cmd: {
  readonly command: string;
  readonly cwd?: string | null;
  readonly expectedExitCode?: number;
}): string {
  const cwd =
    cmd.cwd !== null && cmd.cwd !== undefined && cmd.cwd.trim().length > 0 ? cmd.cwd.trim() : "";
  const exit =
    typeof cmd.expectedExitCode === "number" && Number.isFinite(cmd.expectedExitCode)
      ? cmd.expectedExitCode
      : 0;
  return `${cmd.command}\0${cwd}\0${exit}`;
}

interface CaptureBuckets {
  readonly out: LiteralAcceptanceCommand[];
  readonly seen: Set<string>;
  readonly rejected: RejectedLiteralCommand[];
  readonly rejectedSeen: Set<string>;
}

function recordRejected(
  buckets: CaptureBuckets,
  command: string,
  reason: string,
  sourceSpan: string | null,
): void {
  const key = `${command}\0${reason}`;
  if (buckets.rejectedSeen.has(key)) return;
  buckets.rejectedSeen.add(key);
  buckets.rejected.push({
    command,
    reason,
    sourceSpan,
  });
}

/**
 * Push a full command record (preserves cwd / expectedStdout / expectedExitCode).
 * Safety failures go to the rejected ledger instead of silent drop.
 */
function pushCommand(buckets: CaptureBuckets, cmd: LiteralAcceptanceCommand): void {
  const safety = evaluateCommandSafety(cmd.command);
  if (!safety.ok) {
    recordRejected(buckets, cmd.command, safety.reason ?? "unsafe command", cmd.sourceSpan ?? null);
    return;
  }
  const key = commandDedupeKey(cmd);
  if (buckets.seen.has(key)) return;
  buckets.seen.add(key);
  buckets.out.push({
    command: cmd.command,
    cwd: cmd.cwd ?? null,
    expectedStdout: cmd.expectedStdout ?? null,
    expectedExitCode: cmd.expectedExitCode ?? 0,
    source: cmd.source,
    sourceSpan: cmd.sourceSpan ?? null,
  });
}

/** Capture-path helper: command string only (defaults for context fields). */
function pushUnique(
  buckets: CaptureBuckets,
  command: string,
  source: LiteralAcceptanceSource,
  sourceSpan: string | null,
): void {
  pushCommand(buckets, {
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

/** `$ cmd` or `> cmd` prompt lines. */
function matchPromptCommand(line: string): string | null {
  let i = skipWs(line, 0);
  if (i >= line.length) return null;
  if (line[i] !== "$" && line[i] !== ">") return null;
  i = skipWs(line, i + 1);
  if (i >= line.length) return null;
  return line.slice(i).trimEnd();
}

/** Box-drawing / block elements used in terminal UIs (━, │, …). */
const BOX_DRAWING_RE = /[\u2500-\u257F\u2580-\u259F]/;

/**
 * True when a fence line is log/transcript, not a stated command (#3511).
 * `[1/13]` / `[ts:check-lane]`, box drawing, or FAIL/FAILED/Error:.
 */
function isTranscriptOutputLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (t.startsWith("#") || t.startsWith("//")) return false;
  if (/^\[[^\]]{1,80}\]/.test(t)) return true;
  if (BOX_DRAWING_RE.test(t)) return true;
  if (/\b(?:FAILED|FAIL|Error:)/i.test(t)) return true;
  return false;
}

function isFenceCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith("#") || t.startsWith("//");
}

function isPromptLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("$ ") || t.startsWith("> ");
}

/** Per-line mask: true for body lines inside ``` / ~~~ fences (not the markers). */
function fenceBodyMask(lines: readonly string[]): boolean[] {
  const mask = Array.from({ length: lines.length }, () => false);
  let open: FenceOpen | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (open === null) {
      open = matchFenceOpen(line);
      continue;
    }
    if (matchFenceClose(line, open)) {
      open = null;
      continue;
    }
    mask[i] = true;
  }
  return mask;
}

function captureFenceBodyLine(
  line: string,
  fenceLang: string,
  fenceStartLine: number,
  buckets: CaptureBuckets,
): void {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return;
  }
  let body = trimmed;
  if (body.startsWith("$ ") || body.startsWith("> ")) {
    body = body.slice(2).trim();
  }
  const normalized = normalizeCommand(body);
  if (normalized === null) return;
  const langOk = isShellFenceLang(fenceLang);
  if (!looksLikeShellCommand(normalized) && (fenceLang === "" || !langOk)) return;
  pushUnique(
    buckets,
    normalized,
    "task_statement",
    `fence@L${fenceStartLine}${fenceLang ? `:${fenceLang}` : ""}`,
  );
}

function flushFenceBody(
  body: readonly string[],
  fenceLang: string,
  fenceStartLine: number,
  requireRegion: boolean,
  regionActive: boolean,
  buckets: CaptureBuckets,
): void {
  if (requireRegion && !regionActive) return;
  if (!isShellFenceLang(fenceLang)) return;
  // Transcript lines are skipped. `$`/`>` prompts inside a transcript fence are
  // suggested-fixes (biome migrate), not stated AC (#3511). Comments do not
  // mark a fence as transcript, so a genuine command next to `# Error:` still
  // captures.
  const transcript = body.some((line) => isTranscriptOutputLine(line));
  for (const line of body) {
    if (isFenceCommentOrBlank(line)) continue;
    if (transcript && isPromptLine(line)) continue;
    if (isTranscriptOutputLine(line)) continue;
    captureFenceBodyLine(line, fenceLang, fenceStartLine, buckets);
  }
}

/**
 * Walk fenced ``` / ~~~ blocks; keep fence body lines that look like shell.
 * When `requireRegion` is true, only fences under an acceptance/verify heading.
 * Output-shaped fences (progress tags, box drawing, FAIL/Error:) are skipped (#3511).
 */
function extractFromFences(text: string, requireRegion: boolean, buckets: CaptureBuckets): void {
  const lines = text.split(/\r?\n/);
  let open: FenceOpen | null = null;
  let regionActive = !requireRegion;
  let fenceStartLine = 0;
  let fenceBody: string[] = [];

  const flush = (): void => {
    if (open === null) return;
    flushFenceBody(fenceBody, open.lang, fenceStartLine, requireRegion, regionActive, buckets);
    open = null;
    fenceBody = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const heading = matchMarkdownHeading(line);
    if (heading !== null && open === null) {
      regionActive = requireRegion ? isRegionHeading(heading.text) : true;
      continue;
    }

    const fenceOpen = matchFenceOpen(line);
    if (fenceOpen !== null && open === null) {
      open = fenceOpen;
      fenceStartLine = i + 1;
      fenceBody = [];
      continue;
    }
    if (open !== null && matchFenceClose(line, open)) {
      flush();
      continue;
    }
    if (open === null) continue;
    fenceBody.push(line);
  }
  flush();
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

interface FenceOpen {
  readonly lang: string;
  readonly marker: "`" | "~";
  readonly length: number;
}

/**
 * CommonMark fence open: 3+ backticks or tildes, then an optional info string.
 * Longer openers (````) must close with the same marker at >= that length (#3511 P1).
 */
function matchFenceOpen(line: string): FenceOpen | null {
  const body = line.trimEnd().trimStart();
  if (body.length < 3) return null;
  const first = body[0];
  if (first !== "`" && first !== "~") return null;
  const marker: "`" | "~" = first;
  let length = 0;
  while (length < body.length && body[length] === marker) length += 1;
  if (length < 3) return null;
  const rest = body.slice(length).trim().toLowerCase();
  if (rest.includes(" ") || rest.includes("\t")) return null;
  if (rest.includes(marker)) return null;
  return { lang: rest, marker, length };
}

function matchFenceClose(line: string, open: FenceOpen): boolean {
  const t = line.trim();
  let length = 0;
  while (length < t.length && t[length] === open.marker) length += 1;
  if (length < open.length) return false;
  return t.slice(length).trim().length === 0;
}

function matchMarkdownHeading(line: string): { level: number; text: string } | null {
  if (!line.startsWith("#")) return null;
  let level = 0;
  while (level < line.length && line[level] === "#") level += 1;
  if (level < 1 || level > 6) return null;
  if (level >= line.length || line[level] !== " ") return null;
  return { level, text: line.slice(level + 1).trim() };
}

/**
 * Extract from labeled lines and `$` prompts anywhere in the statement.
 *
 * A labeled command MUST start its own line (after an optional bullet / number
 * marker). Mid-line label capture is deliberately not attempted (#3484): a
 * `verify:<verb>` token inside ordinary prose has no terminator, so the capture
 * swallowed the rest of the paragraph and the phantom then blocked completion on
 * the safety ledger. Commands stated mid-sentence must live in a fence, a `$`
 * prompt, or an inline backtick span — all of which have real delimiters.
 */
function extractFromLabeledLines(text: string, buckets: CaptureBuckets): void {
  const lines = text.split(/\r?\n/);
  const inFence = fenceBodyMask(lines);
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i] === true) continue;
    const line = lines[i] ?? "";
    let capturedLabeled = false;
    const labeledBody = matchLabeledCommand(line);
    if (labeledBody !== null) {
      const normalized = normalizeCommand(labeledBody);
      if (normalized !== null && looksLikeShellCommand(normalized)) {
        pushUnique(buckets, normalized, "task_statement", `labeled@L${i + 1}`);
        capturedLabeled = true;
      }
    }
    if (capturedLabeled) continue;

    const promptBody = matchPromptCommand(line);
    if (promptBody !== null) {
      const normalized = normalizeCommand(promptBody);
      if (normalized !== null && looksLikeShellCommand(normalized)) {
        pushUnique(buckets, normalized, "task_statement", `prompt@L${i + 1}`);
      }
    }
  }
}

/**
 * Extract inline `` `command` `` spans that follow verify/run language on the same line.
 * Example: `run \`task check\` before done`
 */
function extractInlineVerifySpans(text: string, buckets: CaptureBuckets): void {
  const lines = text.split(/\r?\n/);
  const inFence = fenceBodyMask(lines);
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i] === true) continue;
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
      pushUnique(buckets, normalized, "task_statement", `inline@L${i + 1}`);
    }
  }
}

function emptyBuckets(): CaptureBuckets {
  return {
    out: [],
    seen: new Set<string>(),
    rejected: [],
    rejectedSeen: new Set<string>(),
  };
}

/** Result of capture including the operator-visible rejected ledger. */
export interface CaptureLiteralAcceptanceResult {
  readonly commands: readonly LiteralAcceptanceCommand[];
  readonly rejected: readonly RejectedLiteralCommand[];
}

/**
 * Capture literal acceptance commands from free-form task statement text.
 * Returns commands + rejected ledger — never invents commands.
 */
export function captureLiteralAcceptanceCommandsDetailed(
  taskStatement: string,
): CaptureLiteralAcceptanceResult {
  if (!isNonEmptyString(taskStatement)) {
    return { commands: [], rejected: [] };
  }
  const buckets = emptyBuckets();

  // Prefer fences under acceptance/verify headings first.
  extractFromFences(taskStatement, true, buckets);
  // Then any shell fences in the whole statement (still literal, not invented).
  extractFromFences(taskStatement, false, buckets);
  extractFromLabeledLines(taskStatement, buckets);
  extractInlineVerifySpans(taskStatement, buckets);

  return { commands: buckets.out, rejected: buckets.rejected };
}

/**
 * Capture literal acceptance commands from free-form task statement text.
 * Returns [] when none are stated — never invents commands.
 */
export function captureLiteralAcceptanceCommands(
  taskStatement: string,
): LiteralAcceptanceCommand[] {
  return [...captureLiteralAcceptanceCommandsDetailed(taskStatement).commands];
}

/**
 * Read already-stored commands from plan.metadata / swarm.verify_commands / item.command.
 * Preserves exact strings and execution context (cwd / expectedStdout / expectedExitCode).
 */
export function readStoredLiteralAcceptanceCommands(
  plan: Record<string, unknown> | null | undefined,
): LiteralAcceptanceCommand[] {
  return readStoredLiteralAcceptanceDetailed(plan).commands as LiteralAcceptanceCommand[];
}

/** Read stored commands plus any persisted rejected ledger. */
export function readStoredLiteralAcceptanceDetailed(
  plan: Record<string, unknown> | null | undefined,
): CaptureLiteralAcceptanceResult {
  if (plan === null || plan === undefined || typeof plan !== "object") {
    return { commands: [], rejected: [] };
  }
  const buckets = emptyBuckets();

  const metadata = asRecord(plan.metadata);
  if (metadata !== null) {
    const explicit =
      metadata.literal_acceptance_commands ?? metadata.literalAcceptanceCommands ?? null;
    for (const cmd of coerceCommandList(explicit, "explicit", "metadata.literal_acceptance")) {
      pushCommand(buckets, cmd);
    }

    // Persisted rejected ledger (operator visibility across reloads).
    const persistedRejected =
      metadata[LITERAL_ACCEPTANCE_REJECTED_METADATA_KEY] ??
      metadata.literalAcceptanceRejected ??
      null;
    if (Array.isArray(persistedRejected)) {
      for (const entry of persistedRejected) {
        const rec = asRecord(entry);
        if (rec === null) continue;
        if (!isNonEmptyString(rec.command) || !isNonEmptyString(rec.reason)) continue;
        recordRejected(
          buckets,
          rec.command.trim(),
          rec.reason.trim(),
          isNonEmptyString(rec.sourceSpan) ? rec.sourceSpan : null,
        );
      }
    }

    const swarm = asRecord(metadata.swarm);
    if (swarm !== null) {
      // swarm.verify_commands is a string list (legacy). Prefer richer
      // literal_acceptance_commands rows already loaded — do not invent a
      // null-cwd duplicate for the same command text.
      const alreadyHasCommand = (command: string): boolean =>
        buckets.out.some((c) => c.command === command);
      for (const cmd of coerceCommandList(
        swarm.verify_commands,
        "verify_commands",
        "swarm.verify_commands",
      )) {
        if (alreadyHasCommand(cmd.command)) continue;
        pushCommand(buckets, cmd);
      }
      for (const cmd of coerceCommandList(
        swarm.literal_acceptance_commands ?? swarm.literalAcceptanceCommands,
        "metadata",
        "swarm.literal_acceptance",
      )) {
        pushCommand(buckets, cmd);
      }
    }
  }

  walkPlanItems(plan.items, "items", buckets);
  return { commands: buckets.out, rejected: buckets.rejected };
}

function walkPlanItems(items: unknown, pathPrefix: string, buckets: CaptureBuckets): void {
  if (!Array.isArray(items)) return;
  items.forEach((item, index) => {
    const rec = asRecord(item);
    if (rec === null) return;
    const path = `${pathPrefix}[${index}]`;
    const commandField = rec.command ?? rec.verify ?? rec.verify_command;
    if (isNonEmptyString(commandField)) {
      const normalized = normalizeCommand(commandField);
      if (normalized !== null) {
        pushUnique(buckets, normalized, "plan_item", `${path}.command`);
      }
    }
    walkPlanItems(rec.subItems, `${path}.subItems`, buckets);
    walkPlanItems(rec.items, `${path}.items`, buckets);
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
    if (normalized === null) return [];
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
    // Preserve persisted source when present so task_statement stays capture-only (#3267).
    const persistedSource =
      typeof rec.source === "string" && rec.source.trim().length > 0
        ? (rec.source.trim() as LiteralAcceptanceSource)
        : source;
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
      source: persistedSource,
      sourceSpan: isNonEmptyString(rec.sourceSpan)
        ? rec.sourceSpan
        : isNonEmptyString(rec.source_span)
          ? rec.source_span
          : span,
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

function isExecutableSource(source: LiteralAcceptanceSource | string): boolean {
  return (EXECUTABLE_LITERAL_SOURCES as readonly string[]).includes(source);
}

/**
 * Attach captured commands onto plan.metadata without paraphrasing.
 * Merges with existing literal_acceptance_commands.
 * Only agent-executable sources (not task_statement) are mirrored into
 * swarm.verify_commands — issue text must be promoted explicitly (#3267).
 * Returns a shallow-cloned plan with updated metadata.
 */
export function attachLiteralAcceptanceCommands(
  plan: Record<string, unknown>,
  commands: readonly LiteralAcceptanceCommand[],
  rejected: readonly RejectedLiteralCommand[] = [],
): Record<string, unknown> {
  if (commands.length === 0 && rejected.length === 0) {
    return plan;
  }
  const metadata = {
    ...(asRecord(plan.metadata) ?? {}),
  };
  const existing = readStoredLiteralAcceptanceDetailed(plan);
  const merged = mergeCommands(existing.commands, commands);
  metadata.literal_acceptance_commands = merged.map(toSerializable);

  // Rejected ledger: merge and persist for operator visibility.
  const rejectedMerged = mergeRejected(existing.rejected, rejected);
  if (rejectedMerged.length > 0) {
    metadata[LITERAL_ACCEPTANCE_REJECTED_METADATA_KEY] = rejectedMerged.map((r) => {
      const row: Record<string, unknown> = { command: r.command, reason: r.reason };
      if (r.sourceSpan !== null && r.sourceSpan !== undefined && r.sourceSpan.length > 0) {
        row.sourceSpan = r.sourceSpan;
      }
      return row;
    });
  }

  // Keep swarm.verify_commands in sync only for executable (agent-authored) sources.
  // task_statement stays capture-only until an agent promotes exact strings (#3267).
  const swarm = { ...(asRecord(metadata.swarm) ?? {}) };
  const executableCmds = merged.filter((c) => isExecutableSource(c.source)).map((c) => c.command);
  const prevVerify = Array.isArray(swarm.verify_commands)
    ? swarm.verify_commands.filter((x): x is string => typeof x === "string")
    : [];
  const verifyMerged = [...prevVerify];
  for (const cmd of executableCmds) {
    if (!verifyMerged.includes(cmd)) verifyMerged.push(cmd);
  }
  if (verifyMerged.length > 0) {
    swarm.verify_commands = verifyMerged;
  }
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
  readonly rejected: readonly RejectedLiteralCommand[];
} {
  const captured = captureLiteralAcceptanceCommandsDetailed(taskStatement);
  if (captured.commands.length === 0 && captured.rejected.length === 0) {
    const stored = readStoredLiteralAcceptanceDetailed(plan);
    return { plan, commands: stored.commands, rejected: stored.rejected };
  }
  const next = attachLiteralAcceptanceCommands(plan, captured.commands, captured.rejected);
  const stored = readStoredLiteralAcceptanceDetailed(next);
  return { plan: next, commands: stored.commands, rejected: stored.rejected };
}

function mergeCommands(
  a: readonly LiteralAcceptanceCommand[],
  b: readonly LiteralAcceptanceCommand[],
): LiteralAcceptanceCommand[] {
  const seen = new Set<string>();
  const out: LiteralAcceptanceCommand[] = [];
  for (const cmd of [...a, ...b]) {
    const key = commandDedupeKey(cmd);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cmd);
  }
  return out;
}

function mergeRejected(
  a: readonly RejectedLiteralCommand[],
  b: readonly RejectedLiteralCommand[],
): RejectedLiteralCommand[] {
  const seen = new Set<string>();
  const out: RejectedLiteralCommand[] = [];
  for (const r of [...a, ...b]) {
    const key = `${r.command}\0${r.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
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

/**
 * Provenance prefixes stamped by the free-text scrapers in this module.
 * Anything carrying one of these spans came from prose, not from a structured
 * acceptance field the author wrote on purpose (#3484).
 */
const PROSE_SPAN_PREFIXES = ["labeled@", "prompt@", "inline@", "fence@"] as const;

/** True when a rejected ledger entry was scraped from narrative prose (#3484). */
export function isProseDerivedRejection(rejected: RejectedLiteralCommand): boolean {
  const span = rejected.sourceSpan;
  if (span === null || span === undefined) return false;
  return PROSE_SPAN_PREFIXES.some((prefix) => span.startsWith(prefix));
}

function hasNonEmptyCommandList(raw: unknown): boolean {
  if (typeof raw === "string") return raw.trim().length > 0;
  if (!Array.isArray(raw)) return false;
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim().length > 0) return true;
    const rec = asRecord(entry);
    if (rec === null) continue;
    if (isNonEmptyString(rec.command ?? rec.cmd ?? rec.shell)) return true;
  }
  return false;
}

/**
 * True when the author stated acceptance commands structurally — `swarm.verify_commands`
 * or `plan.acceptance.commands` (#3484). Still used by intake/tests; demotion of
 * prose-derived rejections no longer depends on this (#3511).
 */
export function hasStructuredAcceptanceCommands(
  plan: Record<string, unknown> | null | undefined,
): boolean {
  const rec = asRecord(plan);
  if (rec === null) return false;
  const acceptance = asRecord(rec.acceptance);
  if (acceptance !== null && hasNonEmptyCommandList(acceptance.commands)) return true;
  const metadata = asRecord(rec.metadata);
  if (metadata === null) return false;
  const swarm = asRecord(metadata.swarm);
  if (swarm === null) return false;
  return hasNonEmptyCommandList(swarm.verify_commands);
}

/** Format rejected ledger for CLI / complete-gate messages. */
export function formatRejectedLedger(rejected: readonly RejectedLiteralCommand[]): string {
  if (rejected.length === 0) return "";
  const lines = rejected.map((r) => {
    const span = r.sourceSpan !== null && r.sourceSpan !== undefined ? ` @${r.sourceSpan}` : "";
    return `  ✗ rejected: ${r.command}${span} — ${r.reason}`;
  });
  return (
    `Literal acceptance rejected ${rejected.length} shell-shaped command(s) (#3267 safety ledger):\n` +
    lines.join("\n")
  );
}
