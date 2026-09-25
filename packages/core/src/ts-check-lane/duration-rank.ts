/**
 * Scrape+rank per-file durations from Step 5 tee timeline lines (#5027).
 *
 * Source lines come from the progress reporter (`formatFileDurationLine`):
 *   ts:check-lane timeline file <path> <ms>ms project=<name>
 * Those lines flush via writeSync when elapsed >= PROGRESS_FILE_HEARTBEAT_MS (30s).
 * Sub-30s files never appear. Stock vitest JsonReporter is not used: it writes
 * only in onTestRunEnd and does not survive hang kill (taskkill /T /F / SIGKILL).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROGRESS_FILE_HEARTBEAT_MS, TIMELINE_PREFIX } from "./progress.js";

/** Bound-remedy top-20 paste default for #5024 cheapen baseline. */
export const DEFAULT_TOP_N = 20;

/** Line regex for flushed timeline file duration rows. */
const FILE_DURATION_RE = new RegExp(
  `^${escapeRegExp(TIMELINE_PREFIX)} file (.+) (\\d+)ms project=(.+)\\s*$`,
);

export interface FileDurationEntry {
  readonly file: string;
  readonly elapsedMs: number;
  readonly project: string;
}

export type RankOk = {
  readonly ok: true;
  readonly entries: readonly FileDurationEntry[];
  /** Honesty clause: sub-heartbeat files are omitted from the tee stream. */
  readonly omissionNote: string;
};

export type RankErr = {
  readonly ok: false;
  readonly kind: "usage" | "read-error" | "no-duration-lines" | "bad-top";
  readonly message: string;
};

export type RankResult = RankOk | RankErr;

export function omissionNoteForHeartbeat(heartbeatMs: number = PROGRESS_FILE_HEARTBEAT_MS): string {
  const seconds = Math.round(heartbeatMs / 1000);
  return (
    `Omission: only files with elapsed >= ${String(heartbeatMs)}ms ` +
    `(${String(seconds)}s / PROGRESS_FILE_HEARTBEAT_MS) appear in timeline ` +
    `file lines; sub-${String(seconds)}s files are never ranked.`
  );
}

export function parseFileDurationLine(line: string): FileDurationEntry | null {
  const trimmed = line.trimEnd();
  const match = FILE_DURATION_RE.exec(trimmed);
  if (match === null) return null;
  const file = match[1];
  const msRaw = match[2];
  const project = match[3];
  if (file === undefined || msRaw === undefined || project === undefined) return null;
  const elapsedMs = Number(msRaw);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (file.length === 0 || project.length === 0) return null;
  return { file, elapsedMs, project };
}

/**
 * Collect file-duration rows from tee text. Duplicate file+project keys keep
 * the later (last-wins) duration so concatenated re-runs stay readable.
 */
export function scrapeFileDurations(text: string): FileDurationEntry[] {
  const byKey = new Map<string, FileDurationEntry>();
  for (const line of text.split(/\r?\n/)) {
    const entry = parseFileDurationLine(line);
    if (entry === null) continue;
    byKey.set(`${entry.project}\0${entry.file}`, entry);
  }
  return [...byKey.values()];
}

/** Sort descending by duration; stable tie-break by file then project. */
export function rankFileDurations(
  entries: readonly FileDurationEntry[],
  topN: number,
): FileDurationEntry[] {
  if (!Number.isFinite(topN) || topN <= 0) return [];
  const sorted = [...entries].sort((a, b) => {
    if (b.elapsedMs !== a.elapsedMs) return b.elapsedMs - a.elapsedMs;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.project !== b.project) return a.project < b.project ? -1 : 1;
    return 0;
  });
  return sorted.slice(0, Math.floor(topN));
}

export function formatRankLines(entries: readonly FileDurationEntry[]): string[] {
  return entries.map((e, i) => {
    const rank = String(i + 1).padStart(2, " ");
    const ms = String(e.elapsedMs).padStart(8, " ");
    return `${rank}. ${ms}ms  ${e.file}  project=${e.project}`;
  });
}

export function parseTopN(raw: string | undefined): { ok: true; topN: number } | RankErr {
  if (raw === undefined || raw === "") {
    return { ok: true, topN: DEFAULT_TOP_N };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return {
      ok: false,
      kind: "bad-top",
      message: `invalid --top value ${JSON.stringify(raw)}; expected a positive integer`,
    };
  }
  return { ok: true, topN: n };
}

export function rankTeeText(text: string, topN: number = DEFAULT_TOP_N): RankResult {
  if (!Number.isFinite(topN) || !Number.isInteger(topN) || topN <= 0) {
    return {
      ok: false,
      kind: "bad-top",
      message: `invalid topN ${String(topN)}; expected a positive integer`,
    };
  }
  const scraped = scrapeFileDurations(text);
  if (scraped.length === 0) {
    return {
      ok: false,
      kind: "no-duration-lines",
      message:
        "no ts:check-lane timeline file <path> <ms> lines found " +
        `(${omissionNoteForHeartbeat()})`,
    };
  }
  return {
    ok: true,
    entries: rankFileDurations(scraped, topN),
    omissionNote: omissionNoteForHeartbeat(),
  };
}

export function rankTeeFile(path: string, topN: number = DEFAULT_TOP_N): RankResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: "read-error",
      message: `failed to read tee log ${JSON.stringify(path)}: ${detail}`,
    };
  }
  return rankTeeText(text, topN);
}

export function usageMessage(): string {
  return [
    "Usage: duration-rank [--top N] <tee-log>",
    "",
    "Scrape flushed `ts:check-lane timeline file <path> <ms>` lines from a",
    "Step 5 / ts:check-lane tee under .deft/check-tees/** and print the top N",
    `by duration (default ${String(DEFAULT_TOP_N)}).`,
    "",
    omissionNoteForHeartbeat(),
    "",
    "Hang-kill durability: timeline lines use writeSync before kill; stock",
    "vitest --reporter=json / outputFile does not flush on taskkill/SIGKILL.",
  ].join("\n");
}

/**
 * CLI entry. Returns exit codes; does not throw for usage/read/empty failures.
 * 0 = ranked, 1 = soft failure (usage / empty / bad args / read), 2 = reserved.
 */
export function main(argv: readonly string[]): number {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usageMessage()}\n`);
    return 0;
  }

  let topN = DEFAULT_TOP_N;
  const topIdx = args.findIndex((a) => a === "--top" || a.startsWith("--top="));
  if (topIdx >= 0) {
    const token = args[topIdx] ?? "";
    let raw: string | undefined;
    if (token.startsWith("--top=")) {
      raw = token.slice("--top=".length);
      args.splice(topIdx, 1);
    } else {
      raw = args[topIdx + 1];
      args.splice(topIdx, 2);
    }
    const parsed = parseTopN(raw);
    if (!parsed.ok) {
      process.stderr.write(`${parsed.message}\n`);
      return 1;
    }
    topN = parsed.topN;
  }

  const path = args[0];
  if (path === undefined || path.length === 0 || args.length !== 1) {
    process.stderr.write(`${usageMessage()}\n`);
    return 1;
  }

  const result = rankTeeFile(path, topN);
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return 1;
  }

  process.stdout.write(`${result.omissionNote}\n`);
  process.stdout.write(`Top ${String(result.entries.length)} by duration:\n`);
  for (const line of formatRankLines(result.entries)) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
