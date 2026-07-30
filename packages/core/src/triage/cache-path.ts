/**
 * Layout-aware triage working-set cache paths (#1703 namespace cleanup).
 *
 * Triage append-only logs and scratch dirs live under `.triage-cache/` so the
 * `.eval/` namespace can be reclaimed for version-eval results (#1703 Tier 2).
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertProjectionContained } from "../fs/projection-containment.js";
import {
  MIGRATED_ARTIFACT_DIR,
  resolveEvalDir,
  resolveLifecycleLayout,
  resolveLifecycleRoot,
} from "../layout/resolve.js";
import { generateTriageCacheReadmeBody } from "./bootstrap/gitignore.js";

/** Directory name for the triage working-set cache (not version-eval results). */
export const TRIAGE_CACHE_DIR_NAME = ".triage-cache";

/** Legacy directory that previously held triage cache files before #1703. */
export const LEGACY_TRIAGE_EVAL_DIR_NAME = ".eval";

/** Known triage-cache file basenames migrated off the legacy `.eval/` tree. */
export const TRIAGE_CACHE_FILE_NAMES = [
  "candidates.jsonl",
  "summary-history.jsonl",
  "scope-lifecycle.jsonl",
  "subscription-history.jsonl",
  "slices.jsonl",
  "doctor-state.json",
  "README.md",
] as const;

/** Known triage-cache directory names migrated off the legacy `.eval/` tree. */
export const TRIAGE_CACHE_DIR_NAMES = ["decompositions"] as const;

export interface TriageCacheMigrationResult {
  readonly migratedFiles: readonly string[];
  readonly skippedFiles: readonly string[];
  readonly migratedDirs: readonly string[];
  readonly regeneratedFiles: readonly string[];
  readonly removedLegacyFiles: readonly string[];
}

/** Compute the layout-aware `.triage-cache/` directory without containment checks. */
function triageCacheDirPath(projectRoot: string): string {
  let layoutRoot: string;
  try {
    layoutRoot = resolveLifecycleRoot(projectRoot);
  } catch {
    layoutRoot = join(projectRoot, MIGRATED_ARTIFACT_DIR); // No xbrief/ layout; use canonical path.
  }
  return join(layoutRoot, TRIAGE_CACHE_DIR_NAME);
}

/** Refuse symlink-escaping xbrief/.triage-cache before mkdir/read/write (#2446). */
function assertWritableTriageCachePath(projectRoot: string, ...segments: string[]): void {
  const base = triageCacheDirPath(projectRoot);
  const target = segments.length > 0 ? join(base, ...segments) : base;
  assertProjectionContained(projectRoot, target);
}

/** Absolute path to the layout-aware `.triage-cache/` directory. */
export function resolveTriageCacheDir(projectRoot: string): string {
  assertWritableTriageCachePath(projectRoot);
  return triageCacheDirPath(projectRoot);
}

/** POSIX-style path relative to project root (e.g. `xbrief/.triage-cache/foo`). */
export function triageCacheRelPath(projectRoot: string, ...segments: string[]): string {
  let artifactDir: string;
  try {
    const layout = resolveLifecycleLayout(projectRoot);
    artifactDir = layout.artifactDir;
  } catch {
    artifactDir = "xbrief"; // No layout; default to xbrief/ path for display purposes.
  }
  return [artifactDir, TRIAGE_CACHE_DIR_NAME, ...segments].join("/");
}

/**
 * Idempotently move triage working-set artefacts from legacy `.eval/` into
 * `.triage-cache/` when the new location is absent.
 */
export function migrateLegacyTriageCacheFromEval(projectRoot: string): TriageCacheMigrationResult {
  let legacyDir: string;
  try {
    legacyDir = resolveEvalDir(projectRoot);
  } catch {
    return {
      migratedFiles: [],
      skippedFiles: [],
      migratedDirs: [],
      regeneratedFiles: [],
      removedLegacyFiles: [],
    };
  }
  const targetDir = resolveTriageCacheDir(projectRoot);
  const migratedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const migratedDirs: string[] = [];
  const regeneratedFiles: string[] = [];
  const removedLegacyFiles: string[] = [];

  if (!existsSync(legacyDir)) {
    return { migratedFiles, skippedFiles, migratedDirs, regeneratedFiles, removedLegacyFiles };
  }

  mkdirSync(targetDir, { recursive: true });

  for (const name of TRIAGE_CACHE_FILE_NAMES) {
    const legacyPath = join(legacyDir, name);
    const targetPath = join(targetDir, name);
    if (!existsSync(legacyPath)) {
      continue;
    }
    if (name === "README.md") {
      if (existsSync(targetPath)) {
        unlinkSync(legacyPath);
        removedLegacyFiles.push(name);
      } else {
        // #2980 wave D: product write sink routes through containedWrite.
        containedWrite({
          root: resolve(projectRoot),
          target: targetPath,
          data: generateTriageCacheReadmeBody(projectRoot),
          mode: "create",
        });
        unlinkSync(legacyPath);
        regeneratedFiles.push(name);
      }
      continue;
    }
    if (existsSync(targetPath)) {
      unlinkSync(legacyPath);
      removedLegacyFiles.push(name);
      continue;
    }
    renameSync(legacyPath, targetPath);
    migratedFiles.push(name);
  }

  for (const name of TRIAGE_CACHE_DIR_NAMES) {
    const legacyPath = join(legacyDir, name);
    const targetPath = join(targetDir, name);
    if (!existsSync(legacyPath)) {
      continue;
    }
    if (existsSync(targetPath)) {
      skippedFiles.push(`${name}/`);
      continue;
    }
    renameSync(legacyPath, targetPath);
    migratedDirs.push(name);
  }

  return { migratedFiles, skippedFiles, migratedDirs, regeneratedFiles, removedLegacyFiles };
}

/** Resolve a path under `.triage-cache/`, migrating legacy `.eval/` files first. */
export function resolveTriageCachePath(projectRoot: string, ...segments: string[]): string {
  assertWritableTriageCachePath(projectRoot, ...segments);
  migrateLegacyTriageCacheFromEval(projectRoot);
  return join(triageCacheDirPath(projectRoot), ...segments);
}

/** Display helper: project-root-relative POSIX path for logs and gitignore copy. */
export function triageCacheDisplayPath(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath).split(/[\\/]/).join("/");
}

/** Back-compat display constant; resolution flows through `resolveTriageCachePath`. */
export const TRIAGE_CANDIDATES_LOG_REL_PATH = "xbrief/.triage-cache/candidates.jsonl";

/** Layout-aware candidates audit-log path. */
export function resolveCandidatesLogPath(projectRoot: string): string {
  return resolveTriageCachePath(projectRoot, "candidates.jsonl");
}

/** Ensure the triage cache directory exists (post-migration). */
export function ensureTriageCacheDir(projectRoot: string): string {
  migrateLegacyTriageCacheFromEval(projectRoot);
  const dir = resolveTriageCacheDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}
