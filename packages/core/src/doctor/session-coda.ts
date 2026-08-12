/**
 * Optional deterministic session coda for interactive doctor success (#2712).
 *
 * Human TTY affordance only: never JSON, never AGENTS/skills, never exit-code
 * changes. Env three-state DEFT_SESSION_CODA (unset / 1 / 0). Copy lives in
 * content/doctor/session-coda.json — not embedded as an engine literal.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { contentRoot } from "../content-root.js";

/** Env var name (env-only v1; no USER.md key). */
export const SESSION_CODA_ENV = "DEFT_SESSION_CODA";

/**
 * Fixed discoverability line when env is unset and gates pass (D3).
 * Snapshot-stable; not selected from the pack; no ✦ prefix.
 */
export const SESSION_CODA_OFF_HINT = "Session coda: off (set DEFT_SESSION_CODA=1 to enable)";

/** U+2726 FOUR RAYED STAR + space — stable; do not localize. */
export const SESSION_CODA_STAR_PREFIX = "\u2726 ";

/** Max body length; longer pack entries are skipped (fail-open). */
export const SESSION_CODA_MAX_CHARS = 100;

/** Relative path under contentRoot (source: content/doctor/…; deposit: doctor/…). */
export const SESSION_CODA_REL_PATH = join("doctor", "session-coda.json");

export type SessionCodaMode = "unset" | "on" | "off";

/**
 * Map DEFT_SESSION_CODA to the three-state mode (D3).
 * - undefined / "" → unset (discoverability off-hint)
 * - "1" → on (✦ coda)
 * - "0" → off (silent)
 * - any other non-empty value → unset (show correct enable form)
 */
export function sessionCodaMode(envValue: string | undefined): SessionCodaMode {
  if (envValue === undefined || envValue === "") return "unset";
  if (envValue === "1") return "on";
  if (envValue === "0") return "off";
  return "unset";
}

/**
 * Whether any extra line (off-hint or coda) is allowed (D1 + surface gates).
 * TTY = stdout.isTTY; CI truthy blocks; json blocks; exitOk = errorCount === 0.
 */
export function shouldEmitSessionCodaLine(input: {
  readonly tty: boolean;
  readonly ci: boolean;
  readonly json: boolean;
  readonly exitOk: boolean;
}): boolean {
  return input.exitOk === true && input.tty === true && input.ci !== true && input.json !== true;
}

/**
 * FNV-1a 32-bit (#2712). Documented choice for hash_u32(date + "\\0" + root).
 * No Math.random; same inputs ⇒ same u32 on every platform.
 */
export function hashU32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** UTC calendar date yyyy-mm-dd from a Date (stable for 24h across a team day). */
export function utcDateYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Best-effort realpath; falls back to the given path when realpath fails. */
export function projectRootRealpath(projectRoot: string): string {
  try {
    return realpathSync(projectRoot);
  } catch {
    return projectRoot;
  }
}

/**
 * Select one coda body from the pack (enabled path only).
 * index = hash_u32(utc_date + "\\0" + project_root_realpath) % len(codas)
 * Empty list → null (omit ✦; doctor still 0).
 */
export function selectSessionCoda(input: {
  readonly date: string;
  readonly projectRoot: string;
  readonly codas: readonly string[];
}): string | null {
  const { date, projectRoot, codas } = input;
  if (codas.length === 0) return null;
  const key = `${date}\0${projectRoot}`;
  const index = hashU32(key) % codas.length;
  return codas[index] ?? null;
}

/** Skip non-strings and bodies over SESSION_CODA_MAX_CHARS. */
export function filterCodaEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (entry.length === 0 || entry.length > SESSION_CODA_MAX_CHARS) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Load + filter coda lines from content. Fail-open: missing/unreadable/invalid
 * / empty after filter → [] (omit ✦; no error noise).
 */
export function loadSessionCodas(
  frameworkRoot: string,
  readText?: (path: string) => string | null,
): string[] {
  const packPath = join(contentRoot(frameworkRoot), SESSION_CODA_REL_PATH);
  try {
    const text =
      readText !== undefined ? readText(packPath) : readFileSync(packPath, { encoding: "utf8" });
    if (text === null || text === "") return [];
    return filterCodaEntries(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

/** Format enabled coda line: ✦ + space + body. */
export function formatSessionCodaEnabledLine(body: string): string {
  return `${SESSION_CODA_STAR_PREFIX}${body}`;
}

export interface ResolveSessionCodaLineInput {
  readonly mode: SessionCodaMode;
  readonly shouldEmit: boolean;
  readonly date: string;
  readonly projectRoot: string;
  readonly codas: readonly string[];
}

/**
 * Resolve the single extra line (or null) after final success footer.
 * Does not print; caller places after blank line post footer (D2).
 */
export function resolveSessionCodaLine(input: ResolveSessionCodaLineInput): string | null {
  if (!input.shouldEmit) return null;
  if (input.mode === "off") return null;
  if (input.mode === "unset") return SESSION_CODA_OFF_HINT;
  const body = selectSessionCoda({
    date: input.date,
    projectRoot: input.projectRoot,
    codas: input.codas,
  });
  if (body === null) return null;
  return formatSessionCodaEnabledLine(body);
}

/** Help / env-docs fragment for DEFT_SESSION_CODA three-state (#2712). */
export function sessionCodaHelpText(): string {
  return [
    "Environment:",
    `  ${SESSION_CODA_ENV}  Session coda after interactive success (exit 0, TTY, not CI, not --json):`,
    "    unset  Print discoverability line:",
    `           ${SESSION_CODA_OFF_HINT}`,
    "    =1     Print one curated line, e.g.:",
    `           ${formatSessionCodaEnabledLine("Doctor first. Then continue.")}`,
    "    =0     Silent (no hint, no coda)",
  ].join("\n");
}
