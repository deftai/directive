/**
 * content-manifest.ts -- deterministic gate for the content manifest (#1821).
 *
 * Validates that conventions/content-manifest.json classifies EVERY git-tracked
 * top-level repository entry into exactly one bucket, and that no classified
 * entry has gone stale. This is the Wave-1 shippability audit for the
 * engine/content split (#1669): it converts the brittle installer denylist
 * into an allowlist-by-classification and is the authoritative input the
 * content/ move (#1875) consumes.
 *
 * Authored TS-native (no Python oracle): the #1828 parity discipline applies to
 * PORTED gates; this is a net-new gate created after the migration, so the TS
 * engine is the single source of truth (the #1669 direction phases Python out).
 *
 * Exit codes (three-state, mirrors rule-ownership-lint):
 *   0 -- clean: every top-level entry classified, no stale rows.
 *   1 -- drift: an unclassified top-level entry, or a classified path that is
 *        no longer a top-level tracked entry.
 *   2 -- config error: manifest missing / malformed / structurally invalid, or
 *        `git ls-files` could not be run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CONFIG_ERROR = 2;

export const DEFAULT_MANIFEST_PATH = "conventions/content-manifest.json";

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
 * entry path) -- the caller maps a throw to exit 2 (config error). Tree-vs-
 * manifest divergence is NOT checked here; that is :func:`lintManifest` (drift).
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
    const entryPath = rec.path as string;
    const entryBucket = rec.bucket as string;
    if (!bucketIds.has(entryBucket)) {
      const sorted = [...bucketIds].sort();
      throw new Error(
        `Content manifest entry '${entryPath}' references unknown bucket '${entryBucket}'; expected one of ${JSON.stringify(sorted)}.`,
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
 * Return the sorted, de-duplicated set of git-tracked top-level entries.
 *
 * Uses `git ls-files` (tracked truth) reduced to first path components, so
 * untracked caches (.venv, node_modules, __pycache__, dist, ...) are excluded
 * automatically -- only entries under version control require classification.
 * Throws on git failure (caller maps to exit 2).
 */
export function listTrackedTopLevel(root: string): string[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["ls-files"], {
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
    const top = trimmed.split("/")[0];
    if (top !== undefined && top.length > 0) {
      set.add(top);
    }
  }
  return [...set].sort();
}

/**
 * Compare the manifest's classified paths against the actual top-level tree.
 *
 * Returns drift diagnostics (one per divergence). An empty array means clean.
 */
export function lintManifest(
  manifest: ContentManifest,
  topLevel: readonly string[],
  manifestLabel: string = DEFAULT_MANIFEST_PATH,
): string[] {
  const diagnostics: string[] = [];
  const classified = new Set(manifest.entries.map((e) => e.path));
  const tracked = new Set(topLevel);

  for (const entry of topLevel) {
    if (!classified.has(entry)) {
      diagnostics.push(
        `unclassified top-level entry '${entry}' -- add a row to ${manifestLabel} assigning it a bucket (content|engine|harness|repo-dev).`,
      );
    }
  }
  for (const entry of manifest.entries) {
    if (!tracked.has(entry.path)) {
      diagnostics.push(
        `stale classified entry '${entry.path}' -- it is no longer a git-tracked top-level entry; remove the row or fix the path.`,
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
  /** Test seam: inject the top-level entry set instead of running `git ls-files`. */
  readonly topLevelEntries?: readonly string[];
}

/**
 * Evaluate the content-manifest gate. Pure-ish: side effects limited to reading
 * the manifest and (unless `topLevelEntries` is injected) spawning `git ls-files`.
 */
export function evaluateContentManifest(
  projectRoot: string,
  options: ContentManifestOptions = {},
): ContentManifestResult {
  const root = resolve(options.root ?? projectRoot);
  const manifestPath = resolve(options.manifestPath ?? join(root, DEFAULT_MANIFEST_PATH));

  try {
    const manifest = loadManifest(manifestPath);
    const topLevel = options.topLevelEntries ?? listTrackedTopLevel(root);
    // Forward the resolved manifest location so drift diagnostics point at the
    // manifest actually in use, not the hardcoded default (a custom manifestPath
    // would otherwise be mis-reported in CI output).
    const relLabel = relative(root, manifestPath);
    const manifestLabel = relLabel && !relLabel.startsWith("..") ? relLabel : manifestPath;
    const diagnostics = lintManifest(manifest, [...topLevel], manifestLabel);
    if (diagnostics.length > 0) {
      const lines = [
        `FAIL: content manifest drift detected in ${diagnostics.length} entr(y/ies):`,
        ...diagnostics.map((d) => `  - ${d}`),
      ];
      return { code: EXIT_DRIFT, message: lines.join("\n"), stream: "stderr" };
    }
    return {
      code: EXIT_OK,
      message: `OK: content manifest clean -- ${manifest.entries.length} top-level entr(y/ies) classified across ${manifest.buckets.length} bucket(s) (root=${root}).`,
      stream: "stdout",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: EXIT_CONFIG_ERROR, message: `Error: ${msg}`, stream: "stderr" };
  }
}
