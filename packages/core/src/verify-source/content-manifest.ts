/**
 * content-manifest.ts -- deterministic gate for the content manifest (#1821 / #1875).
 *
 * Since the #1875 content/ move this gate enforces a LOCATION INVARIANT over
 * conventions/content-manifest.json rather than a "classify every top-level
 * entry" completeness check:
 *
 *   1. Every manifest entry with `bucket: content` MUST have a path under
 *      `content/` -- EXCEPT the named harness-entry exceptions
 *      (`harnessEntry: true`, e.g. AGENTS.md / main.md / SKILL.md) which are
 *      content-classified but root-resident per #1669 Wave-1 D2.
 *   2. No entry with a non-`content` bucket may live under `content/`.
 *   3. Every git-tracked path directly under `content/` MUST correspond to a
 *      `content` manifest entry (no unclassified content; no stale content
 *      entry pointing at a path that is no longer a content/ child).
 *
 * The manifest now physically lives at content/conventions/content-manifest.json
 * (the conventions/ directory moved under content/ in #1875). The C1 flatten
 * deposits `content/<x>` to `.deft/core/<x>`, so the consumer-facing layout is
 * unchanged; this gate guards the SOURCE-repo invariant.
 *
 * Authored TS-native (no Python oracle): the #1828 parity discipline applies to
 * PORTED gates; this is a net-new gate created after the migration, so the TS
 * engine is the single source of truth (the #1669 direction phases Python out).
 *
 * Exit codes (three-state, mirrors rule-ownership-lint):
 *   0 -- clean: the location invariant holds.
 *   1 -- drift: a content entry not under content/, a non-content entry under
 *        content/, an unclassified content/ child, or a stale content entry.
 *   2 -- config error: manifest missing / malformed / structurally invalid, or
 *        `git ls-files` could not be run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CONFIG_ERROR = 2;

export const DEFAULT_MANIFEST_PATH = "content/conventions/content-manifest.json";
export const CONTENT_ROOT = "content";
export const CONTENT_PREFIX = "content/";

export const REQUIRED_ENTRY_FIELDS = ["path", "bucket", "note"] as const;
export const REQUIRED_BUCKET_FIELDS = ["id", "label", "description"] as const;

export interface ManifestBucket {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface ManifestEntry {
  readonly path: string;
  readonly bucket: string;
  readonly note: string;
  readonly straddle?: boolean;
  /**
   * When true, a `content`-bucket entry is a named harness-entry exception that
   * is content-classified but intentionally root-resident (AGENTS.md / main.md /
   * SKILL.md per #1669 Wave-1 D2). The location invariant exempts these from the
   * "must live under content/" rule (#1875).
   */
  readonly harnessEntry?: boolean;
}

export interface ContentManifest {
  readonly version: number;
  readonly buckets: ManifestBucket[];
  readonly entries: ManifestEntry[];
}

/**
 * Load + structurally validate the content manifest.
 *
 * Throws on any structural problem (missing file, malformed JSON, missing
 * required fields, invalid bucket reference, duplicate bucket id, duplicate
 * entry path, non-boolean `straddle`/`harnessEntry`) -- the caller maps a throw
 * to exit 2 (config error). The location invariant is NOT checked here; that is
 * :func:`lintManifest` (drift).
 */
export function loadManifest(manifestPath: string): ContentManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`content manifest not found: ${manifestPath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, { encoding: "utf8" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read content manifest ${manifestPath}: ${msg}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed JSON in content manifest ${manifestPath}: ${msg}`);
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error(
      `Content manifest ${manifestPath} must contain a JSON object at the top level (got ${typeof payload}).`,
    );
  }
  const obj = payload as Record<string, unknown>;

  if (typeof obj.version !== "number") {
    throw new Error(`Content manifest ${manifestPath} must have a numeric 'version' field.`);
  }

  const buckets = obj.buckets;
  if (!Array.isArray(buckets)) {
    throw new Error(`Content manifest ${manifestPath} must contain a 'buckets' array.`);
  }
  const bucketIds = new Set<string>();
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (typeof bucket !== "object" || bucket === null) {
      throw new Error(`Content manifest bucket at index ${index} must be a JSON object.`);
    }
    const rec = bucket as Record<string, unknown>;
    for (const field of REQUIRED_BUCKET_FIELDS) {
      const val = rec[field];
      if (typeof val !== "string" || val.length === 0) {
        throw new Error(
          `Content manifest bucket at index ${index} field '${field}' must be a non-empty string.`,
        );
      }
    }
    const bucketId = rec.id as string;
    if (bucketIds.has(bucketId)) {
      throw new Error(`Duplicate content manifest bucket id: '${bucketId}'`);
    }
    bucketIds.add(bucketId);
  }
  if (bucketIds.size === 0) {
    throw new Error(`Content manifest ${manifestPath} must declare at least one bucket.`);
  }

  const entries = obj.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`Content manifest ${manifestPath} must contain an 'entries' array.`);
  }
  const seenPaths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Content manifest entry at index ${index} must be a JSON object.`);
    }
    const rec = entry as Record<string, unknown>;
    for (const field of REQUIRED_ENTRY_FIELDS) {
      const val = rec[field];
      if (typeof val !== "string" || val.length === 0) {
        throw new Error(
          `Content manifest entry at index ${index} field '${field}' must be a non-empty string.`,
        );
      }
    }
    if ("straddle" in rec && typeof rec.straddle !== "boolean") {
      throw new Error(
        `Content manifest entry '${String(rec.path)}' field 'straddle' must be a boolean when present.`,
      );
    }
    if ("harnessEntry" in rec && typeof rec.harnessEntry !== "boolean") {
      throw new Error(
        `Content manifest entry '${String(rec.path)}' field 'harnessEntry' must be a boolean when present.`,
      );
    }
    const entryPath = rec.path as string;
    const entryBucket = rec.bucket as string;
    if (!bucketIds.has(entryBucket)) {
      const sorted = [...bucketIds].sort();
      throw new Error(
        `Content manifest entry '${entryPath}' references unknown bucket '${entryBucket}'; expected one of ${JSON.stringify(sorted)}.`,
      );
    }
    if (rec.harnessEntry === true && entryBucket !== "content") {
      throw new Error(
        `Content manifest entry '${entryPath}' sets harnessEntry:true but bucket is '${entryBucket}'; only 'content' entries may be harness-entry exceptions.`,
      );
    }
    if (seenPaths.has(entryPath)) {
      throw new Error(`Duplicate content manifest entry path: '${entryPath}'`);
    }
    seenPaths.add(entryPath);
  }

  return {
    version: obj.version,
    buckets: buckets as ManifestBucket[],
    entries: entries as ManifestEntry[],
  };
}

/**
 * Reduce a git-tracked path under content/ to its immediate content/ child.
 * `content/skills/foo.md` -> `content/skills`; `content/LICENSE.md` ->
 * `content/LICENSE.md`. Returns null for paths not under content/.
 */
function toContentChild(trackedPath: string): string | null {
  if (!trackedPath.startsWith(CONTENT_PREFIX)) {
    return null;
  }
  const rest = trackedPath.slice(CONTENT_PREFIX.length);
  const first = rest.split("/")[0];
  if (first === undefined || first.length === 0) {
    return null;
  }
  return `${CONTENT_PREFIX}${first}`;
}

/**
 * Return the sorted, de-duplicated set of git-tracked immediate children of
 * `content/` (e.g. `content/skills`, `content/LICENSE.md`).
 *
 * Uses `git ls-files content` (tracked truth), so untracked caches are excluded
 * automatically. Throws on git failure (caller maps to exit 2). An empty result
 * (no content/ tree yet) is returned as `[]`, not an error.
 */
export function listTrackedContentChildren(root: string): string[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-files", "--", CONTENT_ROOT], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ls-files failed in ${root}: ${msg}`);
  }
  const set = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const child = toContentChild(trimmed);
    if (child !== null) {
      set.add(child);
    }
  }
  return [...set].sort();
}

/**
 * Enforce the #1875 location invariant against the actual content/ tree.
 *
 * Returns drift diagnostics (one per divergence). An empty array means clean.
 */
export function lintManifest(
  manifest: ContentManifest,
  contentChildren: readonly string[],
  manifestLabel: string = DEFAULT_MANIFEST_PATH,
): string[] {
  const diagnostics: string[] = [];
  const tracked = new Set(contentChildren);

  // Rule 1 + 2: per-entry location checks.
  const classifiedChildren = new Set<string>();
  for (const entry of manifest.entries) {
    const underContent = entry.path === CONTENT_ROOT || entry.path.startsWith(CONTENT_PREFIX);
    if (entry.bucket === "content") {
      if (entry.harnessEntry === true) {
        // Harness-entry exception: must stay at the repo root, not under content/.
        if (underContent) {
          diagnostics.push(
            `harness-entry exception '${entry.path}' must stay at the repo root, not under content/ -- drop the content/ prefix or unset harnessEntry.`,
          );
        }
        continue;
      }
      if (!entry.path.startsWith(CONTENT_PREFIX)) {
        diagnostics.push(
          `content entry '${entry.path}' must live under content/ (or be marked harnessEntry:true if it is a named root harness-entry) -- move it under content/ or fix the manifest path.`,
        );
        continue;
      }
      // Track the immediate content/ child this entry classifies.
      const child = toContentChild(entry.path);
      if (child !== null && child === entry.path) {
        classifiedChildren.add(entry.path);
      }
    } else if (underContent) {
      diagnostics.push(
        `non-content entry '${entry.path}' (bucket '${entry.bucket}') must not live under content/ -- only content-bucket entries belong under content/.`,
      );
    }
  }

  // Rule 3a: every git-tracked content/ child has a content entry.
  for (const child of contentChildren) {
    if (!classifiedChildren.has(child)) {
      diagnostics.push(
        `unclassified content/ child '${child}' -- add a content-bucket row to ${manifestLabel} for it.`,
      );
    }
  }
  // Rule 3b: no stale content entry pointing at a non-existent content/ child.
  for (const entry of classifiedChildren) {
    if (!tracked.has(entry)) {
      diagnostics.push(
        `stale content entry '${entry}' -- it is no longer a git-tracked content/ child; remove the row or fix the path.`,
      );
    }
  }
  return diagnostics;
}

export interface ContentManifestResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

export interface ContentManifestOptions {
  readonly manifestPath?: string;
  readonly root?: string;
  /** Test seam: inject the content/ child set instead of running `git ls-files`. */
  readonly contentChildren?: readonly string[];
}

/**
 * Evaluate the content-manifest gate. Pure-ish: side effects limited to reading
 * the manifest and (unless `contentChildren` is injected) spawning `git ls-files`.
 */
export function evaluateContentManifest(
  projectRoot: string,
  options: ContentManifestOptions = {},
): ContentManifestResult {
  const root = resolve(options.root ?? projectRoot);
  const manifestPath = resolve(options.manifestPath ?? join(root, DEFAULT_MANIFEST_PATH));

  try {
    const manifest = loadManifest(manifestPath);
    const contentChildren = options.contentChildren ?? listTrackedContentChildren(root);
    // Forward the resolved manifest location so drift diagnostics point at the
    // manifest actually in use, not the hardcoded default (a custom manifestPath
    // would otherwise be mis-reported in CI output).
    const relLabel = relative(root, manifestPath);
    const manifestLabel = relLabel && !relLabel.startsWith("..") ? relLabel : manifestPath;
    const diagnostics = lintManifest(manifest, [...contentChildren], manifestLabel);
    if (diagnostics.length > 0) {
      const lines = [
        `FAIL: content manifest drift detected in ${diagnostics.length} entr(y/ies):`,
        ...diagnostics.map((d) => `  - ${d}`),
      ];
      return { code: EXIT_DRIFT, message: lines.join("\n"), stream: "stderr" };
    }
    const contentEntries = manifest.entries.filter((e) => e.bucket === "content").length;
    return {
      code: EXIT_OK,
      message: `OK: content manifest location invariant holds -- ${contentChildren.length} content/ child(ren) classified, ${contentEntries} content entr(y/ies) total (root=${root}).`,
      stream: "stdout",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: EXIT_CONFIG_ERROR, message: `Error: ${msg}`, stream: "stderr" };
  }
}
