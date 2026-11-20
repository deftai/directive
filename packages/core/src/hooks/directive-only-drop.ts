/**
 * Directive-only drop for prospective git-commit scope-cover (#5771).
 *
 * A staged entry leaves the product set only when all of these hold:
 * - its raw git path is already canonical (no backslash, carriage return,
 *   leading or trailing whitespace, or leading `./`);
 * - its staged mode is a plain file (`100644` / `100755`) or it is a deletion,
 *   and its HEAD mode, when present, is a plain file;
 * - its HEAD side and staged side read cleanly (a read error is never "absent");
 * - the installer's ownership API (`classifyDirectiveOwnedChange`, #6615) calls
 *   the change `directive-only`.
 *
 * Every other entry stays product with one exact reason. Dropping is by raw
 * staged entry, so a distinct raw path that normalizes to the same string is
 * never dropped with it. The ownership API itself is unchanged here; its
 * precision on shared files is tracked separately (#6790 / #6788).
 */

import { execFileSync } from "node:child_process";
import { classifyDirectiveOwnedChange } from "../install-health/owned-paths.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { readStagedBlob, type StagedIndexEntry } from "./planning-publication.js";

/** Why a staged entry still needs scope cover. */
export type DirectiveOnlyKeptReason =
  | "unreadable-head"
  | "unreadable-staged"
  | "unsupported-mode"
  | "non-canonical-path"
  | "mixed"
  | "not-owned";

/** One HEAD tree entry at an exact path. */
export interface HeadTreeEntry {
  readonly mode: string;
  readonly oid: string;
}

/**
 * HEAD tree lookup for a set of exact paths. `entries` holds only paths that
 * HEAD has; a path missing from it was looked up successfully and is absent.
 * `unborn` is a verified unborn branch; `error` is any other failure.
 */
export type HeadTreeLookup =
  | { readonly kind: "entries"; readonly entries: ReadonlyMap<string, HeadTreeEntry> }
  | { readonly kind: "unborn" }
  | { readonly kind: "error"; readonly message: string };

export type HeadTreeReader = (projectRoot: string, paths: readonly string[]) => HeadTreeLookup;

/** Reads one blob by object id; null when it cannot be read. */
export type BlobReader = (projectRoot: string, oid: string) => string | null;

export interface DirectiveOnlyKeptPath {
  /** Raw staged path, exactly as git emitted it. */
  readonly path: string;
  readonly reason: DirectiveOnlyKeptReason;
  /** True when the path (normalized) is in a Directive path class. */
  readonly directivePath: boolean;
}

export interface DirectiveOnlyPartition {
  /** Raw paths of the dropped entries. */
  readonly dropped: readonly string[];
  /** Entries that still need cover, in staged order. */
  readonly keptEntries: readonly StagedIndexEntry[];
  /** One reason per kept entry, in staged order. */
  readonly kept: readonly DirectiveOnlyKeptPath[];
}

export interface PartitionDirectiveOnlyInput {
  readonly projectRoot: string;
  /** Raw staged entries that are already product (lifecycle paths removed). */
  readonly entries: readonly StagedIndexEntry[];
  readonly readStagedBlob: BlobReader;
  readonly readHeadTree?: HeadTreeReader;
  readonly readHeadBlob?: BlobReader;
}

const PLAIN_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** The raw path is already in the form the ownership API reads. */
export function isCanonicalStagedPath(raw: string): boolean {
  if (raw.length === 0) return false;
  if (raw.includes("\\") || raw.includes("\r")) return false;
  if (raw !== raw.trim()) return false;
  return !raw.startsWith("./");
}

/** Normalized project-relative form, as the scope-cover rails read it. */
export function normalizeStagedPath(raw: string): string {
  return raw.replace(/\r/g, "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * True when the path is in one of the ownership API's Directive path classes.
 * Read from the API itself: a path outside every class is `not-owned` for any
 * content, so a probe with an empty new file answers the class question.
 */
export function isDirectivePathClass(relPath: string): boolean {
  // The API answers `not-owned` from the path alone, before it reads content,
  // so a probe that throws inside a content check is a known class.
  try {
    return classifyDirectiveOwnedChange(relPath, null, "") !== "not-owned";
  } catch {
    return true;
  }
}

function isDeletion(entry: StagedIndexEntry): boolean {
  return entry.kind === "D" && entry.mode === "000000";
}

/**
 * Split product entries into Directive-only (dropped) and kept, with one exact
 * reason per kept entry. Reads HEAD only for entries that pass the path, class
 * and staged-mode checks, and resolves HEAD once for all of them.
 */
export function partitionDirectiveOnlyEntries(
  input: PartitionDirectiveOnlyInput,
): DirectiveOnlyPartition {
  const readHeadTree = input.readHeadTree ?? readHeadTreeEntries;
  const readHeadBlob = input.readHeadBlob ?? readStagedBlob;
  const verdicts = new Map<number, DirectiveOnlyKeptReason | "drop">();
  const classed = new Map<number, boolean>();
  const candidates: number[] = [];
  input.entries.forEach((entry, index) => {
    const rel = normalizeStagedPath(entry.path);
    const directivePath = rel.length > 0 && isDirectivePathClass(rel);
    classed.set(index, directivePath);
    if (!isCanonicalStagedPath(entry.path)) {
      verdicts.set(index, "non-canonical-path");
    } else if (!directivePath) {
      verdicts.set(index, "not-owned");
    } else if (!isDeletion(entry) && !PLAIN_FILE_MODES.has(entry.mode)) {
      verdicts.set(index, "unsupported-mode");
    } else {
      candidates.push(index);
    }
  });
  if (candidates.length > 0) {
    const paths = [...new Set(candidates.map((i) => (input.entries[i] as StagedIndexEntry).path))];
    const head = readHeadTree(input.projectRoot, paths);
    for (const index of candidates) {
      const entry = input.entries[index] as StagedIndexEntry;
      verdicts.set(index, classifyCandidate(input, entry, head, readHeadBlob));
    }
  }
  const dropped: string[] = [];
  const keptEntries: StagedIndexEntry[] = [];
  const kept: DirectiveOnlyKeptPath[] = [];
  input.entries.forEach((entry, index) => {
    const verdict = verdicts.get(index) ?? "not-owned";
    if (verdict === "drop") {
      dropped.push(entry.path);
      return;
    }
    keptEntries.push(entry);
    kept.push({ path: entry.path, reason: verdict, directivePath: classed.get(index) === true });
  });
  return { dropped, keptEntries, kept };
}

function classifyCandidate(
  input: PartitionDirectiveOnlyInput,
  entry: StagedIndexEntry,
  head: HeadTreeLookup,
  readHeadBlob: BlobReader,
): DirectiveOnlyKeptReason | "drop" {
  if (head.kind === "error") return "unreadable-head";
  let before: string | null = null;
  if (head.kind === "entries") {
    const headEntry = head.entries.get(entry.path);
    if (headEntry !== undefined) {
      if (!PLAIN_FILE_MODES.has(headEntry.mode)) return "unsupported-mode";
      before = readHeadBlob(input.projectRoot, headEntry.oid);
      if (before === null) return "unreadable-head";
    }
  }
  let after: string | null = null;
  if (!isDeletion(entry)) {
    after = input.readStagedBlob(input.projectRoot, entry.blob);
    if (after === null) return "unreadable-staged";
  }
  // A deletion with no HEAD entry is not a readable change.
  if (before === null && after === null) return "unreadable-head";
  let verdict: ReturnType<typeof classifyDirectiveOwnedChange>;
  try {
    verdict = classifyDirectiveOwnedChange(entry.path, before, after);
  } catch {
    // Not shown to be Directive-only, so it stays product.
    return "mixed";
  }
  return verdict === "directive-only" ? "drop" : verdict;
}

type GitRun =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly status: number | null; readonly message: string };

function runGit(projectRoot: string, args: readonly string[]): GitRun {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return { ok: true, stdout };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    return {
      ok: false,
      status: typeof e.status === "number" ? e.status : null,
      message: stderr.length > 0 ? stderr : String(e.message ?? err),
    };
  }
}

type HeadResolution =
  | { readonly kind: "commit"; readonly sha: string }
  | { readonly kind: "unborn" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Resolve HEAD once. Unborn only when HEAD is a symbolic ref to a branch that
 * does not exist (`show-ref --verify` exits 1); any other failure is an error.
 */
function resolveHead(projectRoot: string): HeadResolution {
  const commit = runGit(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (commit.ok) {
    const sha = commit.stdout.trim();
    if (/^[0-9a-f]+$/.test(sha)) return { kind: "commit", sha };
    return { kind: "error", message: `unexpected HEAD id ${JSON.stringify(sha)}` };
  }
  const sym = runGit(projectRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!sym.ok) return { kind: "error", message: `HEAD does not resolve: ${sym.message}` };
  const ref = sym.stdout.trim();
  if (!ref.startsWith("refs/heads/")) {
    return { kind: "error", message: `HEAD names ${ref}, not a branch` };
  }
  const exists = runGit(projectRoot, ["show-ref", "--verify", "--quiet", ref]);
  if (!exists.ok && exists.status === 1) return { kind: "unborn" };
  return { kind: "error", message: `HEAD branch ${ref} exists but does not resolve to a commit` };
}

/** Parse `git ls-tree -z` records into exact-path entries. Null on a malformed record. */
export function parseLsTreeZ(stdout: string): Map<string, HeadTreeEntry & { type: string }> | null {
  const out = new Map<string, HeadTreeEntry & { type: string }>();
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) return null;
    const parts = record.slice(0, tab).split(" ");
    const [mode, type, oid] = parts;
    if (parts.length !== 3 || mode === undefined || type === undefined || oid === undefined) {
      return null;
    }
    out.set(record.slice(tab + 1), { mode, type, oid });
  }
  return out;
}

function lsTree(
  projectRoot: string,
  sha: string,
  paths: readonly string[],
): Map<string, HeadTreeEntry & { type: string }> | string {
  const run = runGit(projectRoot, [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    "--full-tree",
    sha,
    "--",
    ...paths,
  ]);
  if (!run.ok) return `git ls-tree failed: ${run.message}`;
  const parsed = parseLsTreeZ(run.stdout);
  return parsed ?? "git ls-tree output could not be parsed";
}

/**
 * Default HEAD reader: one `ls-tree` over all paths, then a single-path lookup
 * for any absent path that has a requested descendant (ls-tree does not list a
 * directory itself when it descends into it for a deeper requested path).
 */
export function readHeadTreeEntries(projectRoot: string, paths: readonly string[]): HeadTreeLookup {
  const head = resolveHead(projectRoot);
  if (head.kind === "error") return head;
  if (head.kind === "unborn") return head;
  const listed = lsTree(projectRoot, head.sha, paths);
  if (typeof listed === "string") return { kind: "error", message: listed };
  const entries = new Map<string, HeadTreeEntry>();
  for (const path of paths) {
    let hit = listed.get(path);
    if (hit === undefined && paths.some((other) => other.startsWith(`${path}/`))) {
      const single = lsTree(projectRoot, head.sha, [path]);
      if (typeof single === "string") return { kind: "error", message: single };
      hit = single.get(path);
    }
    if (hit !== undefined) entries.set(path, { mode: hit.mode, oid: hit.oid });
  }
  return { kind: "entries", entries };
}

/**
 * Refusal note for a staged set that holds Directive paths (#5771 / #5949):
 * names the dropped paths and each kept path with its reason, and gives the
 * commit-the-Directive-part recovery only when a path was dropped. Empty when
 * no Directive path is staged, so today's refusal text is kept.
 */
export function formatDirectiveOnlyRefusalNote(partition: DirectiveOnlyPartition | null): string {
  if (partition === null) return "";
  const holdsDirective =
    partition.dropped.length > 0 || partition.kept.some((k) => k.directivePath);
  if (!holdsDirective) return "";
  const show = (raw: string): string => (isCanonicalStagedPath(raw) ? raw : JSON.stringify(raw));
  const parts: string[] = [];
  if (partition.dropped.length > 0) {
    parts.push(
      `Directive-only staged paths (no scope needed, #5771): ${partition.dropped.map(show).join(", ")}.`,
    );
  }
  if (partition.kept.length > 0) {
    parts.push(
      `Staged paths that still need cover: ${partition.kept
        .map((k) => `${show(k.path)} (${k.reason})`)
        .join(", ")}.`,
    );
  }
  if (partition.dropped.length > 0) {
    parts.push(
      "Recovery: commit the Directive-only paths on their own, then cover the rest with the story's scope.",
    );
  }
  return parts.join(" ");
}
