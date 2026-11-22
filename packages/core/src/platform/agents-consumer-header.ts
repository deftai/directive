import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { contentRoot } from "../content-root.js";
import { containedWrite } from "../fs/contained-write.js";
import { type AgentsMdSeams, frameworkRoot } from "./agents-md.js";
import { findManagedOpenMarker } from "./linear-scan.js";

/** Rot-prone unmanaged-header sections retired by Option A (#2065). */
export const RETIRED_UNMANAGED_HEADER_SECTIONS = ["## Status", "## Known Issues"] as const;

// "Next:" is a bare label, not a markdown heading like the two patterns above --
// anchor it to the start of a line so prose that happens to contain "Next:"
// mid-sentence (e.g. "See UPGRADING.md ... Next: run `deft triage:queue`") does
// not false-positive (#2170 review).
const RETIRED_NEXT_LABEL_PATTERN = /(^|\n)\s*Next:/;

const CONSUMER_HEADER_TEMPLATE = "templates/agents-consumer-header.md";

/** Placeholder one-liner shipped by composeGreenfieldAgentsMd (#2065 / #4544). */
export const CONSUMER_HEADER_PLACEHOLDER_ONELINER = "One-line project description (edit me).";

export type HeaderOneLinerCasReason =
  | "replaced-placeholder"
  | "not-placeholder"
  | "empty-overview"
  | "already-matches";

/**
 * Longest header one-liner (#6973). The unmanaged AGENTS.md line is a one-line
 * project description, read by every agent at session start; a longer first
 * sentence is not written and the operator supplies `--line` instead.
 */
export const CONSUMER_HEADER_ONELINER_MAX_CHARS = 120;

/** Why a candidate header line does not qualify (#6973). */
export type ConsumerHeaderLineIssue =
  | "empty"
  | "too-long"
  | "markup"
  | "multi-line"
  | "placeholder";

export type ConsumerHeaderLineCheck =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly issue: ConsumerHeaderLineIssue; readonly line: string };

/**
 * Checks one candidate one-liner (#6973): one line, at most
 * {@link CONSUMER_HEADER_ONELINER_MAX_CHARS} characters, no HTML comment or
 * heading mark, and not the scaffold placeholder.
 */
export function checkConsumerHeaderLine(raw: string): ConsumerHeaderLineCheck {
  if (/[\r\n]/.test(raw.trim())) return { ok: false, issue: "multi-line", line: raw };
  const line = raw.trim();
  if (line.length === 0) return { ok: false, issue: "empty", line };
  if (line.includes("<!--") || line.startsWith("#")) return { ok: false, issue: "markup", line };
  if (line === CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return { ok: false, issue: "placeholder", line };
  }
  if (line.length > CONSUMER_HEADER_ONELINER_MAX_CHARS) {
    return { ok: false, issue: "too-long", line };
  }
  return { ok: true, line };
}

/** Closed abbreviations that do not end a sentence (#6973). */
const NON_TERMINAL_ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs"]);

function isSourceLine(line: string): boolean {
  return /^source\s*:/i.test(line);
}

/** Closing quotes and brackets that may follow a sentence-ending mark (#6973). */
const SENTENCE_CLOSERS = new Set(['"', "'", ")", "]", "”", "’", "`"]);

/**
 * First sentence of one line: up to the first `.`/`!`/`?` (plus any closing
 * quotes or brackets) that ends a word, skipping closed abbreviations.
 */
function firstSentence(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    let end = i + 1;
    while (end < line.length && SENTENCE_CLOSERS.has(line[end] ?? "")) end += 1;
    const next = line[end];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (ch === ".") {
      const word = (line.slice(0, i).match(/(\S+)$/)?.[1] ?? "").toLowerCase();
      if (NON_TERMINAL_ABBREVIATIONS.has(word.replace(/^[("'`]+/, ""))) continue;
    }
    return line.slice(0, end).trim();
  }
  return line.trim();
}

export type ConsumerHeaderDerivation =
  | { readonly ok: true; readonly line: string }
  | {
      readonly ok: false;
      readonly issue: ConsumerHeaderLineIssue | "no-sentence";
      /** The candidate sentence that did not qualify, or "" when none was found. */
      readonly candidate: string;
    };

/**
 * Derive the header one-liner from confirmed Overview (#6973): the first
 * sentence of the first line that is not a heading and not a `Source:` line.
 * Never truncates; a sentence that does not pass
 * {@link checkConsumerHeaderLine} derives nothing.
 */
export function deriveConsumerHeaderOneLiner(overview: string): ConsumerHeaderDerivation {
  for (const raw of overview.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || isSourceLine(line)) continue;
    const sentence = firstSentence(line);
    const checked = checkConsumerHeaderLine(sentence);
    if (checked.ok) return { ok: true, line: checked.line };
    return { ok: false, issue: checked.issue, candidate: sentence };
  }
  return { ok: false, issue: "no-sentence", candidate: "" };
}

/**
 * Header one-liner from confirmed Overview (#6973): the derived sentence, or ""
 * when no sentence qualifies. Not a live-prompt interpolator.
 */
export function oneLinerFromConfirmedOverview(overview: string): string {
  const derived = deriveConsumerHeaderOneLiner(overview);
  return derived.ok ? derived.line : "";
}

/** Unmanaged region above the managed-section open marker (or whole file). */
export function unmanagedHeaderRegion(agentsMd: string): string {
  const normalized = agentsMd.replace(/\r\n/g, "\n");
  const open = findManagedOpenMarker(normalized, 0);
  return open === null ? normalized : normalized.slice(0, open.start);
}

/**
 * Unmanaged header one-liner: first non-empty, non-heading, non-HTML-comment
 * line in the unmanaged region (#4544 Prefer-A / Greptile).
 */
export function unmanagedHeaderOneLiner(agentsMd: string): string | null {
  for (const raw of unmanagedHeaderRegion(agentsMd).split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("<!--")) continue;
    return line;
  }
  return null;
}

/**
 * Replace the unmanaged-header one-liner only (same locus as
 * {@link unmanagedHeaderOneLiner}). Skips headings and HTML-comment lines so a
 * quoted scaffold sentence in a leading comment cannot steal the CAS (#4544).
 */
function replaceUnmanagedHeaderOneLiner(agentsMd: string, from: string, to: string): string | null {
  const normalized = agentsMd.replace(/\r\n/g, "\n");
  const region = unmanagedHeaderRegion(normalized);
  const lines = region.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("<!--")) {
      offset += raw.length + (i < lines.length - 1 ? 1 : 0);
      continue;
    }
    if (line !== from) return null;
    const idxInRaw = raw.indexOf(from);
    if (idxInRaw < 0) return null;
    const start = offset + idxInRaw;
    return normalized.slice(0, start) + to + normalized.slice(start + from.length);
  }
  return null;
}

/**
 * Placeholder-only compare-and-set of the unmanaged AGENTS.md one-liner from
 * user-confirmed Overview. Leaves a custom header untouched. Overview is not
 * identity source of truth (#4544).
 */
export function compareAndSetConsumerHeaderOneLiner(input: {
  readonly agentsMd: string;
  readonly confirmedOverview: string;
}): {
  readonly agentsMd: string;
  readonly changed: boolean;
  readonly reason: HeaderOneLinerCasReason;
} {
  const oneLiner = oneLinerFromConfirmedOverview(input.confirmedOverview);
  if (oneLiner.length === 0) {
    return { agentsMd: input.agentsMd, changed: false, reason: "empty-overview" };
  }
  const normalized = input.agentsMd.replace(/\r\n/g, "\n");
  if (unmanagedHeaderOneLiner(normalized) !== CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return { agentsMd: input.agentsMd, changed: false, reason: "not-placeholder" };
  }
  if (oneLiner === CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return { agentsMd: input.agentsMd, changed: false, reason: "already-matches" };
  }
  const replaced = replaceUnmanagedHeaderOneLiner(
    normalized,
    CONSUMER_HEADER_PLACEHOLDER_ONELINER,
    oneLiner,
  );
  if (replaced === null) {
    return { agentsMd: input.agentsMd, changed: false, reason: "not-placeholder" };
  }
  return {
    agentsMd: replaced,
    changed: true,
    reason: "replaced-placeholder",
  };
}

/**
 * True when the only change from `before` to `after` is the scaffold
 * placeholder one-liner replaced by a line that passes
 * {@link checkConsumerHeaderLine} (#6973). Prospective scope-cover admits that
 * exact change without a story scope; any other AGENTS.md change stays product.
 */
export function isConsumerHeaderOneLinerOnlyChange(
  before: string | null,
  after: string | null,
): boolean {
  if (before === null || after === null) return false;
  const b = before.replace(/\r\n/g, "\n");
  const a = after.replace(/\r\n/g, "\n");
  if (unmanagedHeaderOneLiner(b) !== CONSUMER_HEADER_PLACEHOLDER_ONELINER) return false;
  const next = unmanagedHeaderOneLiner(a);
  if (next === null) return false;
  const checked = checkConsumerHeaderLine(next);
  if (!checked.ok) return false;
  return (
    replaceUnmanagedHeaderOneLiner(b, CONSUMER_HEADER_PLACEHOLDER_ONELINER, checked.line) === a
  );
}

export type WriteConsumerHeaderLineResult =
  | { readonly kind: "written"; readonly path: string; readonly line: string }
  | { readonly kind: "no-agents-md"; readonly path: string }
  | { readonly kind: "not-placeholder"; readonly path: string; readonly current: string | null }
  | { readonly kind: "no-overview" }
  | {
      readonly kind: "no-line";
      readonly issue: ConsumerHeaderLineIssue | "no-sentence";
      readonly candidate: string;
    }
  | { readonly kind: "failed"; readonly path: string; readonly detail: string };

/**
 * The one writer of the unmanaged one-liner (#6973): `line` when given, else
 * the first qualifying Overview sentence; placeholder-only compare-and-set with
 * a re-read guard. Never commits.
 */
export function writeConsumerHeaderLineAtRoot(
  projectRoot: string,
  input: { readonly line: string | null; readonly readOverview: () => string | null },
): WriteConsumerHeaderLineResult {
  const root = resolve(projectRoot);
  const path = join(root, "AGENTS.md");
  // Missing and unreadable stay apart: a read error is a failure, not "no file".
  const read = (): { readonly text: string | null } | { readonly error: string } => {
    if (!existsSync(path)) return { text: null };
    try {
      return { text: readFileSync(path, "utf8") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  const first = read();
  if ("error" in first)
    return { kind: "failed", path, detail: `cannot read AGENTS.md (${first.error})` };
  const before = first.text;
  if (before === null) return { kind: "no-agents-md", path };
  const current = unmanagedHeaderOneLiner(before.replace(/\r\n/g, "\n"));
  if (current !== CONSUMER_HEADER_PLACEHOLDER_ONELINER) {
    return { kind: "not-placeholder", path, current };
  }
  let line: string;
  if (input.line !== null) {
    const checked = checkConsumerHeaderLine(input.line);
    if (!checked.ok) return { kind: "no-line", issue: checked.issue, candidate: input.line };
    line = checked.line;
  } else {
    const overview = input.readOverview();
    if (overview === null || overview.trim().length === 0) return { kind: "no-overview" };
    const derived = deriveConsumerHeaderOneLiner(overview);
    if (!derived.ok) return { kind: "no-line", issue: derived.issue, candidate: derived.candidate };
    line = derived.line;
  }
  const replaced = replaceUnmanagedHeaderOneLiner(
    before.replace(/\r\n/g, "\n"),
    CONSUMER_HEADER_PLACEHOLDER_ONELINER,
    line,
  );
  if (replaced === null) return { kind: "not-placeholder", path, current };
  // Re-read at write time so a concurrent AGENTS.md edit is not overwritten (#4544).
  const again = read();
  if ("error" in again || again.text !== before) {
    return { kind: "failed", path, detail: "AGENTS.md changed while the line was derived; re-run" };
  }
  // Keep the file's line endings so the diff is the one line only.
  const data = before.includes("\r\n") ? replaced.replace(/\n/g, "\r\n") : replaced;
  try {
    containedWrite({ root, target: path, data, mode: "replace", mkdir: false });
  } catch (err) {
    return { kind: "failed", path, detail: err instanceof Error ? err.message : String(err) };
  }
  return { kind: "written", path, line };
}

export interface ConsumerHeaderSeams {
  readonly frameworkRoot?: string;
  readonly readTemplate?: () => string | null;
}

function readConsumerHeaderTemplate(seams: ConsumerHeaderSeams = {}): string | null {
  if (seams.readTemplate) return seams.readTemplate();
  const root = frameworkRoot(seams as AgentsMdSeams);
  const candidate = join(contentRoot(root), CONSUMER_HEADER_TEMPLATE);
  try {
    if (!existsSync(candidate)) return null;
    return readFileSync(candidate, "utf8");
  } catch {
    return null;
  }
}

/** Bounded unmanaged header scaffold for fresh consumer installs (#2065 Option A). */
export function renderConsumerHeader(seams: ConsumerHeaderSeams = {}): string {
  const template = readConsumerHeaderTemplate(seams);
  if (template === null) {
    return [
      "# Project",
      "",
      CONSUMER_HEADER_PLACEHOLDER_ONELINER,
      "",
      "## Session orientation",
      "",
      "Scoped work → `xbrief/` lifecycle; ranked queue → `deft triage:queue`; tracked bugs → GitHub issues; identity → `xbrief/PROJECT-DEFINITION.xbrief.json`.",
    ].join("\n");
  }
  return template.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

/** Compose a greenfield AGENTS.md: bounded unmanaged header + attributed managed section. */
export function composeGreenfieldAgentsMd(
  attributedManagedSection: string,
  seams: ConsumerHeaderSeams = {},
): string {
  const header = renderConsumerHeader(seams);
  const managed = attributedManagedSection.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return `${header}\n\n${managed}\n`;
}

/** True when text contains rot-prone retired header patterns (#2065). */
export function containsRetiredUnmanagedHeaderPatterns(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n");
  if (RETIRED_UNMANAGED_HEADER_SECTIONS.some((pattern) => normalized.includes(pattern))) {
    return true;
  }
  return RETIRED_NEXT_LABEL_PATTERN.test(normalized);
}

/** Exact scaffold edit-me still present as the unmanaged header one-liner (#4544 Prefer-A). */
export function agentsMdContainsExactPlaceholder(agentsMd: string): boolean {
  return unmanagedHeaderOneLiner(agentsMd) === CONSUMER_HEADER_PLACEHOLDER_ONELINER;
}

export const FIRST_SHIP_HEADER_PLACEHOLDER_CAUSE =
  "unmanaged AGENTS.md header still equals scaffold edit-me after product-mutation completion";

/** The command that sets the one-liner (#6973); nothing else writes that line. */
export const CONSUMER_HEADER_LINE_COMMAND = "deft project:write-header-line";

export const FIRST_SHIP_HEADER_PLACEHOLDER_REMEDY =
  `run ${CONSUMER_HEADER_LINE_COMMAND} (or add --line "<one sentence>") in the primary checkout, ` +
  "then commit AGENTS.md on a feature branch; in a linked worktree, land the line from the " +
  "primary checkout and rebase this branch; custom headers pass; Process-only exits may keep the placeholder";

export type FirstShipHeaderPlaceholderReason =
  | "no-agents-md"
  | "not-placeholder"
  | "process-only"
  | "placeholder-with-product-mutation"
  | "agents-md-unreadable"
  | "product-mutation-marker-unreadable";

export interface FirstShipHeaderPlaceholderResult {
  readonly ok: boolean;
  readonly reason: FirstShipHeaderPlaceholderReason;
  readonly message: string;
}

/**
 * Fail-closed first-ship gate (#4544 Prefer-A): product-mutation completion must
 * not finish while the unmanaged header still equals the exact scaffold
 * placeholder. Absent AGENTS.md, custom headers, and Process-only pass.
 * Unreadable Prefer-A marker fails closed only while the header is still the
 * scaffold placeholder (not silent Process-only; do not refuse custom/absent).
 * Returned failure only — no throw.
 */
export function evaluateFirstShipHeaderPlaceholderGate(input: {
  readonly agentsMd: string | null;
  readonly productMutationCompletion: boolean;
  readonly agentsMdUnreadable?: boolean;
  readonly productMutationMarkerUnreadable?: boolean;
  readonly productMutationMarkerDetail?: string;
}): FirstShipHeaderPlaceholderResult {
  if (input.agentsMdUnreadable === true) {
    return {
      ok: false,
      reason: "agents-md-unreadable",
      message:
        "consumer-header-placeholder FAIL: AGENTS.md exists but is unreadable; " +
        "remedy: fix file permissions or encoding, then re-run verify:consumer-header-placeholder",
    };
  }
  if (input.agentsMd === null) {
    return {
      ok: true,
      reason: "no-agents-md",
      message: "consumer-header-placeholder: no AGENTS.md (skip)",
    };
  }
  if (!agentsMdContainsExactPlaceholder(input.agentsMd)) {
    return {
      ok: true,
      reason: "not-placeholder",
      message: "consumer-header-placeholder: header is not the scaffold edit-me placeholder",
    };
  }
  if (input.productMutationMarkerUnreadable === true) {
    const detail =
      input.productMutationMarkerDetail !== undefined &&
      input.productMutationMarkerDetail.trim().length > 0
        ? ` (${input.productMutationMarkerDetail.trim()})`
        : "";
    return {
      ok: false,
      reason: "product-mutation-marker-unreadable",
      message:
        "consumer-header-placeholder FAIL: Prefer-A product-mutation marker exists but is " +
        `unreadable or malformed${detail}; remedy: repair or re-record ` +
        ".deft/cache/product-mutation-completion.json, then re-run " +
        "verify:consumer-header-placeholder (do not treat as Process-only)",
    };
  }
  if (!input.productMutationCompletion) {
    return {
      ok: true,
      reason: "process-only",
      message: "consumer-header-placeholder: placeholder allowed (no product-mutation completion)",
    };
  }
  return {
    ok: false,
    reason: "placeholder-with-product-mutation",
    message:
      `consumer-header-placeholder FAIL: ${FIRST_SHIP_HEADER_PLACEHOLDER_CAUSE}; ` +
      `remedy: ${FIRST_SHIP_HEADER_PLACEHOLDER_REMEDY}`,
  };
}
