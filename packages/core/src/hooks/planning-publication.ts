/**
 * Planning-publication commit admission (#5839 Prefer-A Recut-6 Bound).
 *
 * Prospective git-commit scope-cover (#5656) asks for a ready running scope
 * whose `file_scope` covers every non-xbrief staged path. A commit that stages
 * only planning files has no such scope by design (Path A planning split,
 * #5551). This module classifies the whole staged set from the raw index
 * entries and admits only that closed set:
 *
 * - inventory: a changelog entry path and `.deft/plan-sequence.json` (both in
 *   the #5477 lifecycle-maintenance set), plus `docs/design/<name>.md` and
 *   `docs/decisions/<name>.md`;
 * - neutral record files: `<name>.xbrief.json` / `<name>.vbrief.json` directly
 *   under a #5477 lifecycle folder other than `active/`, and
 *   `<name>.decision.json` directly under `xbrief/decisions/` or
 *   `vbrief/decisions/`.
 *
 * `<name>` is one path segment with no backslash. Every other path, a mode
 * other than 100644, a change kind other than A, M or D, and a plan-sequence
 * index blob that fails `isClosedPlanSequenceShape` refuse the set. A refuse is
 * never a deny: the caller falls through to the existing prospective-cover
 * rails. Admission writes nothing and confers no merge-time credit.
 */

import { execFileSync } from "node:child_process";
import { isChangelogEntryPath } from "../changelog/entry-path.js";
import {
  LIFECYCLE_MAINTENANCE_DIR_PREFIXES,
  LIFECYCLE_MAINTENANCE_EXACT_PATHS,
} from "../check/session-completed-ac.js";
import { isClosedPlanSequenceShape, PLAN_SEQUENCE_REL_PATH } from "../plan-sequence/types.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

/** One staged index entry from `git diff --cached --raw -z` (#5839). */
export interface StagedIndexEntry {
  /** Path exactly as git emitted it in its NUL-delimited record (no trim, no slash rewrite). */
  readonly path: string;
  /** Change kind letter (`A`, `M`, `D`, `T`, ...). */
  readonly kind: string;
  /** Index-side mode, for example `100644`; `000000` for a deletion. */
  readonly mode: string;
  /** Index-side blob id; all zeros for a deletion. */
  readonly blob: string;
}

/** Staged index entry list result — no throw; the hook maps `ok:false` to deny (#5656). */
export type ListStagedIndexEntriesResult =
  | { readonly ok: true; readonly entries: readonly StagedIndexEntry[] }
  | { readonly ok: false; readonly message: string };

/** Whole-set verdict. `admitted: false` is a fall-through, never a deny. */
export type PlanningPublicationVerdict =
  | { readonly admitted: true; readonly message: string }
  | { readonly admitted: false; readonly reason: string };

/** Role of one path in a planning-publication set. */
export type PlanningPublicationPathRole = "inventory" | "neutral";

/** Reads one index blob by id; null when it cannot be read. */
export type StagedBlobReader = (blob: string) => string | null;

const DOCS_INVENTORY_DIRS = ["docs/design/", "docs/decisions/"] as const;
const DECISION_RECORD_DIRS = ["xbrief/decisions/", "vbrief/decisions/"] as const;
const BRIEF_RECORD_SUFFIXES = [".xbrief.json", ".vbrief.json"] as const;
const DECISION_RECORD_SUFFIX = ".decision.json";
const DOCS_RECORD_SUFFIX = ".md";
const ACTIVE_FOLDER_SUFFIX = "/active/";
const REGULAR_FILE_MODE = "100644";

/**
 * Parse `git diff --cached --raw -z --no-renames` stdout. Each record is a
 * `:<srcmode> <dstmode> <srcblob> <dstblob> <status>` header then one path,
 * NUL-delimited. Paths are kept exactly as decoded. Returns null on a
 * malformed record.
 */
export function parseStagedRawZ(stdout: string): StagedIndexEntry[] | null {
  const fields = stdout.split("\0");
  const entries: StagedIndexEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const header = fields[i] as string;
    if (header.length === 0 && i === fields.length - 1) break;
    if (!header.startsWith(":")) return null;
    const parts = header.slice(1).split(" ");
    if (parts.length !== 5) return null;
    const path = fields[i + 1];
    if (path === undefined || path.length === 0) return null;
    const [, mode, , blob, status] = parts as [string, string, string, string, string];
    if (status.length === 0) return null;
    entries.push({ path, kind: status.charAt(0), mode, blob });
    i += 2;
  }
  return entries;
}

/**
 * Default staged-path producer for prospective scope-cover (#5656 / #5839).
 * Same file set as the earlier `--name-only` producer (ACMRDT, deletes and
 * rename sources included), widened to carry change kind, index mode and index
 * blob. Each NUL-delimited path is handed on unmodified.
 */
export function listStagedIndexEntries(projectRoot: string): ListStagedIndexEntriesResult {
  try {
    const stdout = execFileSync(
      "git",
      ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", "--diff-filter=ACMRDT"],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const entries = parseStagedRawZ(stdout);
    if (entries === null) {
      return { ok: false, message: "git diff --cached --raw output could not be parsed" };
    }
    return { ok: true, entries };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      return { ok: false, message: "'git' executable not found on PATH" };
    }
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : String(e.message ?? err);
    return { ok: false, message: `git diff --cached --raw failed: ${stderr}` };
  }
}

/** Read one index blob by id (`git cat-file blob`). Null when it cannot be read. */
export function readStagedBlob(projectRoot: string, blob: string): string | null {
  try {
    return execFileSync("git", ["cat-file", "blob", blob], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
  } catch {
    return null;
  }
}

/**
 * Project-relative paths for the existing prospective-cover rails, normalized
 * exactly as the earlier `--name-only` producer did (strip CR, trim, drop
 * empty). The classifier never reads these; it reads the raw entries.
 */
export function stagedRelPathsFromEntries(entries: readonly StagedIndexEntry[]): string[] {
  return entries
    .map((entry) => entry.path.replace(/\r/g, "").trim())
    .filter((path) => path.length > 0);
}

function isOneSegmentRecord(path: string, prefix: string, suffix: string): boolean {
  if (path.length <= prefix.length + suffix.length) return false;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return false;
  const name = path.slice(prefix.length, path.length - suffix.length);
  return !name.includes("/") && !name.includes("\\");
}

const PLAN_SEQUENCE_INVENTORY_PATH: string | undefined = (
  LIFECYCLE_MAINTENANCE_EXACT_PATHS as readonly string[]
).find((path) => path === PLAN_SEQUENCE_REL_PATH);

/** Raw-path role in a planning-publication set; null disqualifies the whole set. */
export function planningPublicationPathRole(path: string): PlanningPublicationPathRole | null {
  if (isChangelogEntryPath(path)) return "inventory";
  if (path === PLAN_SEQUENCE_INVENTORY_PATH) return "inventory";
  if (DOCS_INVENTORY_DIRS.some((dir) => isOneSegmentRecord(path, dir, DOCS_RECORD_SUFFIX))) {
    return "inventory";
  }
  for (const prefix of LIFECYCLE_MAINTENANCE_DIR_PREFIXES) {
    if (prefix.endsWith(ACTIVE_FOLDER_SUFFIX)) continue;
    if (BRIEF_RECORD_SUFFIXES.some((suffix) => isOneSegmentRecord(path, prefix, suffix))) {
      return "neutral";
    }
  }
  if (DECISION_RECORD_DIRS.some((dir) => isOneSegmentRecord(path, dir, DECISION_RECORD_SUFFIX))) {
    return "neutral";
  }
  return null;
}

function planSequenceBlobIsClosed(blob: string, readBlob: StagedBlobReader): boolean {
  const text = readBlob(blob);
  if (text === null) return false;
  try {
    return isClosedPlanSequenceShape(JSON.parse(text) as unknown);
  } catch {
    return false;
  }
}

function refuse(reason: string): PlanningPublicationVerdict {
  return { admitted: false, reason };
}

/**
 * Whole-set planning-publication classifier (#5839). Admits only when every
 * staged entry is an inventory or neutral record path, added or modified as
 * mode 100644 or deleted, and a non-deleted `.deft/plan-sequence.json` index
 * blob passes the existing closed-shape check. Reads no other file content and
 * no session or posture state.
 */
export function classifyPlanningPublicationSet(
  entries: readonly StagedIndexEntry[],
  readBlob: StagedBlobReader,
): PlanningPublicationVerdict {
  if (entries.length === 0) return refuse("no staged entries");
  for (const entry of entries) {
    const shown = JSON.stringify(entry.path);
    if (planningPublicationPathRole(entry.path) === null) {
      return refuse(`${shown} is outside the planning inventory and record files`);
    }
    if (entry.kind === "D") continue;
    if (entry.kind !== "A" && entry.kind !== "M") {
      return refuse(`${shown} has change kind ${entry.kind} (only A, M or D)`);
    }
    if (entry.mode !== REGULAR_FILE_MODE) {
      return refuse(`${shown} has index mode ${entry.mode} (only ${REGULAR_FILE_MODE})`);
    }
    if (entry.path === PLAN_SEQUENCE_REL_PATH && !planSequenceBlobIsClosed(entry.blob, readBlob)) {
      return refuse(`${shown} index blob fails the closed plan-sequence shape check`);
    }
  }
  return {
    admitted: true,
    message:
      `Planning-publication staged set (${String(entries.length)} path(s)); ` +
      "prospective scope-cover admitted without a ready scope (#5839).",
  };
}
