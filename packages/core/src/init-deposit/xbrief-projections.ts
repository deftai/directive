/**
 * Idempotent consumer xBRIEF derivatives maintained by init/update (#2595).
 *
 * The framework payload manifest and consumer projections have independent
 * freshness. A current `.deft/core/VERSION` therefore cannot short-circuit
 * these repairs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { containedMkdir, containedRemove, containedWrite } from "../fs/contained-write.js";
import { assertDestinationNotSymlink } from "../fs/projection-containment.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { DEV_FALLBACK } from "../platform/constants.js";
import { MIGRATED_ARTIFACT_DIR } from "../xbrief-migrate/constants.js";

const OBSOLETE_CORE_SCHEMA = "vbrief-core.schema.json";
const CURRENT_CORE_SCHEMA = "xbrief-core-0.8.schema.json";
/** Legacy lifecycle eval prefix in framework vbrief/schemas source copies. */
const LEGACY_EVAL_PATH_PREFIX = "vbrief/.eval/";
/** Consumer xbrief/schemas projection must root description paths here (#2670). */
const XBRIEF_EVAL_PATH_PREFIX = "xbrief/.eval/";

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectSchemaFiles(root: string, dir = root, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing xbrief schema projection from symlink: ${full}`);
    }
    if (entry.isDirectory()) {
      collectSchemaFiles(root, full, files);
    } else if (entry.isFile()) {
      files.push(relative(root, full));
    }
  }
  return files;
}

/** Rewrite legacy vbrief/.eval description paths for xbrief/schemas projection (#2670). */
export function rewriteProjectedSchemaContent(content: string): string {
  return content.includes(LEGACY_EVAL_PATH_PREFIX)
    ? content.replaceAll(LEGACY_EVAL_PATH_PREFIX, XBRIEF_EVAL_PATH_PREFIX)
    : content;
}

/** Fail closed when planned (source-rewritten) schema bytes still cite vbrief/.eval/. */
export function assertPlannedSchemaDescriptionRooted(rel: string, text: string): void {
  if (text.includes(LEGACY_EVAL_PATH_PREFIX)) {
    throw new Error(
      `projected xbrief schema still cites ${LEGACY_EVAL_PATH_PREFIX}: ${join(MIGRATED_ARTIFACT_DIR, "schemas", rel)}`,
    );
  }
}

/**
 * Fail closed when a projected xbrief/schemas file still cites vbrief/.eval/.
 * Upstream vbrief/schemas/ may keep legacy paths; consumer copies must not (#2670).
 *
 * `skipRel` is dest files the collect record plans to replace (#3456 plan-note):
 * never validate stale dest bytes a skipped write would have replaced.
 */
export function assertProjectedSchemaDescriptionsRooted(
  projectDir: string,
  destinationDir: string,
  options: { readonly skipRel?: ReadonlySet<string> } = {},
): void {
  assertDestinationNotSymlink(projectDir, destinationDir);
  if (!isDirectory(destinationDir)) return;

  const skipRel = options.skipRel;
  for (const rel of collectSchemaFiles(destinationDir)) {
    if (skipRel?.has(rel)) continue;
    const full = join(destinationDir, rel);
    const text = readFileSync(full, "utf8");
    assertPlannedSchemaDescriptionRooted(rel, text);
  }
}

function writeFileIfChanged(projectDir: string, target: string, content: Buffer | string): boolean {
  // Keep early containment so ProjectionContainmentError type is preserved for callers/tests.
  assertDestinationNotSymlink(projectDir, target);
  const desired = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  try {
    if (readFileSync(target).equals(desired)) return false;
  } catch {
    // Missing or unreadable target is replaced below.
  }
  // #2980 wave A: product write sink routes through containedWrite.
  containedWrite({
    root: resolve(projectDir),
    target,
    data: desired,
    mode: "replace",
  });
  return true;
}

/**
 * Synchronize framework-owned xBRIEF schemas while preserving unknown consumer
 * files. The obsolete v0.6 root schema is the only destination-only file this
 * repair removes.
 */
export function syncConsumerXbriefSchemas(projectDir: string, deftDir: string): boolean {
  const sourceDir = join(deftDir, "vbrief", "schemas");
  const currentSource = join(sourceDir, CURRENT_CORE_SCHEMA);
  if (!isDirectory(sourceDir) || !existsSync(currentSource) || !statSync(currentSource).isFile()) {
    throw new Error(
      `cannot project xbrief schemas: framework payload is missing ${CURRENT_CORE_SCHEMA}`,
    );
  }

  const destinationDir = join(projectDir, MIGRATED_ARTIFACT_DIR, "schemas");
  assertDestinationNotSymlink(projectDir, destinationDir);
  containedMkdir({ root: resolve(projectDir), target: destinationDir });

  let changed = false;
  const plannedRel = new Set<string>();
  for (const rel of collectSchemaFiles(sourceDir)) {
    if (rel === OBSOLETE_CORE_SCHEMA) continue;
    const source = join(sourceDir, rel);
    const destination = join(destinationDir, rel);
    const projected = rewriteProjectedSchemaContent(readFileSync(source, "utf8"));
    // Planned content is the oracle. Dest bytes a skipped write would replace
    // are not validated (#3456 plan-note).
    assertPlannedSchemaDescriptionRooted(rel, projected);
    plannedRel.add(rel);
    changed = writeFileIfChanged(projectDir, destination, projected) || changed;
  }

  const obsoleteDestination = join(destinationDir, OBSOLETE_CORE_SCHEMA);
  if (containedRemove({ root: projectDir, target: obsoleteDestination }).removed) {
    changed = true;
  }

  assertProjectedSchemaDescriptionsRooted(projectDir, destinationDir, { skipRel: plannedRel });

  return changed;
}

function syncBareVersionMarkerWithPolicy(
  projectDir: string,
  version: string,
  allowRootFallback: boolean,
): boolean {
  const normalized = normalizeVersion(version);
  if (!normalized || normalized === DEV_FALLBACK) return false;

  const canonicalRoot = join(projectDir, MIGRATED_ARTIFACT_DIR);
  if (existsSync(canonicalRoot)) {
    assertDestinationNotSymlink(projectDir, join(canonicalRoot, ".deft-version"));
  }
  let targetDir = projectDir;
  try {
    targetDir = resolveLifecycleRoot(projectDir);
  } catch {
    // Preserve the historical root fallback for payload-changing refreshes,
    // and repair an existing fallback on no-op refreshes without creating new
    // untracked state (#2118 / #2595).
    const rootMarker = join(projectDir, ".deft-version");
    if (!allowRootFallback && !existsSync(rootMarker)) return false;
  }
  const target = join(targetDir, ".deft-version");
  return writeFileIfChanged(projectDir, target, `${normalized}\n`);
}

/** Regenerate the bare consumer version derivative, retaining the historical root fallback. */
export function syncBareVersionMarker(projectDir: string, version: string): boolean {
  return syncBareVersionMarkerWithPolicy(projectDir, version, true);
}

/** Repair an existing marker without creating root state when no lifecycle artifact exists. */
export function syncExistingBareVersionMarker(projectDir: string, version: string): boolean {
  return syncBareVersionMarkerWithPolicy(projectDir, version, false);
}
