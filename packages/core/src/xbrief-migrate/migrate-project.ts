import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { containedRemove, containedRename, containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { checkGitClean } from "../migrate-preflight/index.js";
import { applyAgentsRefresh } from "../platform/agents-md.js";
import {
  hasLifecycleWriteStamp,
  isMigrationLifecycleWrite,
  stampLifecycleWrite,
} from "../scope/lifecycle-write.js";
import { validateVbriefSchema } from "../vbrief-validate/schema.js";
import { patchAgentsMdHeader, renderHeaderPatchSummary } from "./agents-header.js";
import {
  ARCHIVE_FROM_VBRIEF_REL_DIR,
  ARCHIVE_README_BODY,
  ARCHIVE_README_FILENAME,
  ARCHIVE_REL_DIR,
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  LEGACY_VBRIEF_VERSION,
  MIGRATE_THROUGH_VBRIEF_VERSION,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
  OBSOLETE_FRAMEWORK_NARRATIVE_FILENAME,
  PRE_LEGACY_VBRIEF_VERSION,
  VBRIEF_DEPRECATION_MARKER_BODY,
  VBRIEF_DEPRECATION_MARKER_FILENAME,
  VBRIEF_VERSION,
} from "./constants.js";
import { deleteTopLevelJsonKey } from "./delete-top-level-json-key.js";
import { detectLegacyVbriefLayout, detectXbriefConvergence } from "./detect.js";
import { evaluateXbriefDrift, inMemoryCorpusEnvelopeIsDirty } from "./drift-gate.js";
import { hasVbriefDeprecationMarker, isDirectory, isEffectivelyEmptyDir } from "./fs-helpers.js";
import { assertMigrationSourceSafe } from "./migration-containment.js";
import { renderXbriefMigrationLine, xbriefMigrationGuidance } from "./signpost.js";
import type { JsonObject } from "./transforms.js";
import {
  readDeclaredArtifactVersion,
  rewriteEmbeddedTokens,
  transformArtifactV06ToV08Transactional,
} from "./transforms.js";

/**
 * #5540: for completed/ envelopes with no durable lifecycleWrite yet, add
 * `{ action: "complete", writtenAt: now, migration: true }`. Never overwrites
 * an existing complete/fail/cancel stamp. Leaves completedAt alone.
 */
export function maybeStampMigratedCompletedArtifact(
  artifact: JsonObject,
  srcPath: string,
  nowIso: string = new Date().toISOString(),
): void {
  const norm = srcPath.replace(/\\/g, "/");
  if (!norm.includes("/completed/")) {
    return;
  }
  const planRaw = artifact.plan;
  if (typeof planRaw !== "object" || planRaw === null || Array.isArray(planRaw)) {
    return;
  }
  const plan = planRaw as Record<string, unknown>;
  if (hasLifecycleWriteStamp(plan)) {
    return;
  }
  stampLifecycleWrite(plan, "complete", nowIso, { migration: true });
}

export interface XbriefMigrationArgs {
  readonly projectRoot: string;
  readonly frameworkRoot?: string;
  readonly force?: boolean;
  /**
   * Retain a fully-migrated `vbrief/` for read-compatibility behind an explicit
   * deprecation marker instead of removing it (#2270). Default: remove, also
   * when `vbrief/` and `xbrief/` both hold content or `vbrief/` is already
   * marked (#6571). Opt-in on a direct `migrate:xbrief`; upgrade never sets it.
   */
  readonly keepLegacy?: boolean;
}

export interface XbriefMigrationIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

/** How the legacy `vbrief/` root was converged to an unambiguous state (#2270). */
export type VbriefConvergeAction = "removed" | "marker";

export type XbriefMigrationOutcome =
  | { readonly kind: "noop"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "migrated";
      readonly backupDir: string;
      readonly files: number;
      readonly migratedPaths: readonly string[];
      /** Every archived path: unconvertible files plus collision copies. */
      readonly archivedPaths: readonly string[];
      /** Finish-move only (#6571): legacy files whose converted form was already in `xbrief/`. */
      readonly alreadyPresentPaths?: readonly string[];
      /** Finish-move only (#6571): raw legacy copies archived because `xbrief/` held different content. */
      readonly collisionArchivedPaths?: readonly string[];
      /** Finish-move only (#6571): residual envelope rewrite applied under `xbrief/` first. */
      readonly residualMessage?: string;
    }
  | {
      readonly kind: "rewritten";
      readonly files: number;
      readonly message: string;
    }
  | {
      readonly kind: "converged";
      readonly action: VbriefConvergeAction;
      readonly already: boolean;
      readonly message: string;
    }
  | { readonly kind: "config"; readonly message: string };

/**
 * Walk files under `root`.
 * When `skipArchiveDir` is set, omit directories named `archive` — use that only
 * when scanning the canonical `xbrief/` tree so `xbrief/archive/` unknowables
 * are not re-migrated. Do not set it when copying a legacy `vbrief/` tree;
 * source `vbrief/archive/` must still land in the migrated tree.
 */
function collectFiles(
  root: string,
  acc: string[] = [],
  options: { readonly skipArchiveDir?: boolean } = {},
): string[] {
  if (!isDirectory(root)) {
    return acc;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (options.skipArchiveDir && entry.name === ARCHIVE_REL_DIR) continue;
      collectFiles(full, acc, options);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

/** True when a legacy lifecycle file is an obsolete framework narrative (#2806). */
export function shouldOmitLegacyMigrationFile(relativePath: string): boolean {
  return relativePath.replace(/\\/g, "/") === OBSOLETE_FRAMEWORK_NARRATIVE_FILENAME;
}

/**
 * Remove a stale `xbrief/vbrief.md` left by an earlier migrate:xbrief run.
 * Project JSON records and `xbrief/schemas/` are untouched (#2806).
 */
export function removeStaleMigratedFrameworkNarrative(projectRoot: string): boolean {
  const stale = join(projectRoot, MIGRATED_ARTIFACT_DIR, OBSOLETE_FRAMEWORK_NARRATIVE_FILENAME);
  return containedRemove({ root: projectRoot, target: stale }).removed;
}

function mapRelativePath(relativePath: string): string {
  return relativePath
    .split(/[/\\]/)
    .map((segment) =>
      segment.endsWith(LEGACY_ARTIFACT_SUFFIX)
        ? segment.slice(0, -LEGACY_ARTIFACT_SUFFIX.length) + MIGRATED_ARTIFACT_SUFFIX
        : segment,
    )
    .join("/");
}

/** Versions tip can envelope-migrate (0.5 thin→0.6→0.8; 0.6/0.7→0.8; 0.8 no-op). */
function isSupportedMigrateVersion(version: string | null): boolean {
  return (
    version === PRE_LEGACY_VBRIEF_VERSION ||
    version === LEGACY_VBRIEF_VERSION ||
    version === MIGRATE_THROUGH_VBRIEF_VERSION ||
    version === VBRIEF_VERSION
  );
}

export type MigrateFileDisposition =
  | { readonly kind: "migrate"; readonly body: string }
  | { readonly kind: "archive"; readonly reason: string }
  | { readonly kind: "copy"; readonly body: string };

/**
 * Classify a legacy lifecycle file: migrate envelope, archive unknowable, or
 * token-rewrite copy (non-envelope). F-017: never hard-fail the tree for S5/corrupt.
 */
export function classifyLegacyMigrationFile(srcPath: string, raw: string): MigrateFileDisposition {
  const isLifecycleEnvelope =
    srcPath.endsWith(LEGACY_ARTIFACT_SUFFIX) || srcPath.endsWith(MIGRATED_ARTIFACT_SUFFIX);
  if (!isLifecycleEnvelope) {
    // schemas/, .triage-cache/, notes, etc. — token rewrite only.
    return { kind: "copy", body: rewriteEmbeddedTokens(raw) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "archive", reason: `unparseable JSON: ${detail}` };
  }
  if (!isPlainJsonObject(parsed)) {
    return { kind: "archive", reason: "JSON root is not an object" };
  }
  const version = readDeclaredArtifactVersion(parsed);
  if (version === null) {
    return { kind: "archive", reason: "missing vBRIEFInfo/xBRIEFInfo version" };
  }
  if (!isSupportedMigrateVersion(version)) {
    return {
      kind: "archive",
      reason: `unsupported envelope version ${version}`,
    };
  }
  const result = transformArtifactV06ToV08Transactional(parsed);
  if (!result.ok) {
    return { kind: "archive", reason: result.error };
  }
  maybeStampMigratedCompletedArtifact(result.artifact, srcPath);
  return { kind: "migrate", body: `${JSON.stringify(result.artifact, null, 2)}\n` };
}

/** True when the legacy relative path already lives under `vbrief/archive/`. */
function legacyRelUnderArchive(legacyRel: string): boolean {
  return legacyRel === ARCHIVE_REL_DIR || legacyRel.startsWith(`${ARCHIVE_REL_DIR}/`);
}

/**
 * Destination under staged `xbrief/` for a legacy relative path.
 * Files already under `vbrief/archive/` land in `archive/from-vbrief/…` so they
 * cannot collide with newly archived active/completed envelopes (which use
 * `archive/<mapped-rel>`).
 */
function destRelForLegacy(legacyRel: string): string {
  if (legacyRelUnderArchive(legacyRel)) {
    const rest = legacyRel.slice(ARCHIVE_REL_DIR.length).replace(/^\//, "");
    const mappedRest = rest.length > 0 ? mapRelativePath(rest) : "root";
    return `${ARCHIVE_REL_DIR}/${ARCHIVE_FROM_VBRIEF_REL_DIR}/${mappedRest}`;
  }
  return mapRelativePath(legacyRel);
}

/** Where to place an unknowable envelope that must be archived (not migrated). */
function archiveDestRelative(legacyRel: string): string {
  if (legacyRelUnderArchive(legacyRel)) {
    return destRelForLegacy(legacyRel);
  }
  return `${ARCHIVE_REL_DIR}/${mapRelativePath(legacyRel)}`;
}

function ensureArchiveReadme(projectRoot: string, stagedOrMigratedDir: string): void {
  const readme = join(stagedOrMigratedDir, ARCHIVE_REL_DIR, ARCHIVE_README_FILENAME);
  if (existsSync(readme)) return;
  containedWrite({
    root: resolve(projectRoot),
    target: readme,
    data: ARCHIVE_README_BODY,
    mode: "replace",
  });
}

function writeMigratedFile(
  projectRoot: string,
  srcPath: string,
  destPath: string,
  archivePath: string,
): "migrated" | "archived" | "copied" {
  const root = resolve(projectRoot);
  const raw = readFileSync(srcPath, "utf8");
  const disposition = classifyLegacyMigrationFile(srcPath, raw);

  if (disposition.kind === "archive") {
    containedWrite({
      root,
      target: archivePath,
      data: raw,
      mode: "replace",
    });
    return "archived";
  }

  containedWrite({
    root,
    target: destPath,
    data: disposition.body,
    mode: "replace",
  });
  return disposition.kind === "migrate" ? "migrated" : "copied";
}

/** True when declared version is a residual hybrid/orphan rewrite candidate. */
function isHybridRewriteSourceVersion(version: string | null): boolean {
  return (
    version === PRE_LEGACY_VBRIEF_VERSION ||
    version === LEGACY_VBRIEF_VERSION ||
    version === MIGRATE_THROUGH_VBRIEF_VERSION
  );
}

/** Sole mis-keyed `vBRIEFInfo@0.8` (no `xBRIEFInfo`) — Locked #5795 residual. */
function isMisKeyedLegacyV08(parsed: JsonObject): boolean {
  if (Object.hasOwn(parsed, MIGRATED_INFO_ROOT_KEY)) return false;
  const legacy = parsed[LEGACY_INFO_ROOT_KEY];
  return isPlainJsonObject(legacy) && legacy.version === VBRIEF_VERSION;
}

function needsResidualEnvelopeRewrite(parsed: JsonObject): boolean {
  if (isMisKeyedLegacyV08(parsed)) return true;
  return isHybridRewriteSourceVersion(readDeclaredArtifactVersion(parsed));
}

/**
 * Plan in-place hybrid envelope rewrites for xbrief lifecycle `.xbrief.json`
 * artifacts that still declare `xBRIEFInfo@0.6`, orphan rename-era `@0.7`, or
 * mis-keyed sole `vBRIEFInfo@0.8` (#3236 / #2974 / #5795). Pure probe — no writes.
 * Clean already-0.8 artifacts, schema deposits, and other versions are skipped so
 * residual #2368 schema-only markers still route to `directive update`.
 */
function planHybridEnvelopeRewrites(
  projectRoot: string,
):
  | { ok: true; pending: ReadonlyArray<{ path: string; body: string }> }
  | { ok: false; error: string } {
  const migratedDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  const artifactPaths = collectFiles(migratedDir, [], { skipArchiveDir: true }).filter((path) =>
    path.endsWith(MIGRATED_ARTIFACT_SUFFIX),
  );
  const pending: Array<{ path: string; body: string }> = [];

  for (const filePath of artifactPaths) {
    let parsed: JsonObject;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8")) as JsonObject;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `failed to parse hybrid envelope candidate ${relative(projectRoot, filePath)}: ${detail}`,
      };
    }
    // Residual 0.5/0.6/0.7 + mis-keyed sole vBRIEFInfo@0.8 (#5795).
    if (!needsResidualEnvelopeRewrite(parsed)) {
      continue;
    }
    const result = transformArtifactV06ToV08Transactional(parsed);
    if (!result.ok) {
      return {
        ok: false,
        error: `failed to transform hybrid envelope ${relative(projectRoot, filePath)}: ${result.error}`,
      };
    }
    const planBefore = result.artifact.plan;
    const hadStamp =
      typeof planBefore === "object" &&
      planBefore !== null &&
      !Array.isArray(planBefore) &&
      hasLifecycleWriteStamp(planBefore as Record<string, unknown>);
    // Stamp so a stamp-only #5540 pass still rewrites completed/ hybrids.
    maybeStampMigratedCompletedArtifact(result.artifact, filePath);
    const addedMigrationStamp =
      !hadStamp &&
      typeof result.artifact.plan === "object" &&
      result.artifact.plan !== null &&
      !Array.isArray(result.artifact.plan) &&
      isMigrationLifecycleWrite(result.artifact.plan as Record<string, unknown>);
    if (!result.changed && !addedMigrationStamp) {
      continue;
    }
    pending.push({
      path: filePath,
      body: `${JSON.stringify(result.artifact, null, 2)}\n`,
    });
  }

  return { ok: true, pending };
}

/**
 * Apply a previously planned hybrid-envelope rewrite set via containedWrite (#3236).
 */
function applyHybridEnvelopeRewrites(
  projectRoot: string,
  pending: ReadonlyArray<{ path: string; body: string }>,
): number {
  const root = resolve(projectRoot);
  for (const entry of pending) {
    containedWrite({
      root,
      target: entry.path,
      data: entry.body,
      mode: "replace",
    });
  }
  return pending.length;
}

function isPlainJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonFieldsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonFieldsEqual(v, b[i]));
  }
  const ao = a as JsonObject;
  const bo = b as JsonObject;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((key) => Object.hasOwn(bo, key) && jsonFieldsEqual(ao[key], bo[key]));
}

/**
 * Leftover `vBRIEFInfo` is redundant iff every field is either `version: "0.6"`
 * or already present and equal on the canonical 0.8 object. Field disagreement
 * fails closed the same way dual-populated refuses a merge (#4163).
 */
export function legacyInfoIsRedundantWithCanonical(legacy: unknown, canonical: unknown): boolean {
  if (!isPlainJsonObject(legacy) || !isPlainJsonObject(canonical)) return false;
  for (const [key, value] of Object.entries(legacy)) {
    if (key === "version" && value === LEGACY_VBRIEF_VERSION) continue;
    if (!Object.hasOwn(canonical, key)) return false;
    if (!jsonFieldsEqual(value, canonical[key])) return false;
  }
  return true;
}

function omitLegacyInfoKey(parsed: JsonObject): JsonObject {
  const stripped: JsonObject = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === LEGACY_INFO_ROOT_KEY) continue;
    stripped[key] = value;
  }
  return stripped;
}

type StripRewrite = {
  readonly path: string;
  readonly body: string;
  readonly original: string;
};

/**
 * Plan in-place leftover-`vBRIEFInfo` strips for every lifecycle `.xbrief.json`
 * under `xbrief/` (including completed/; #4163 + #5795). Beside
 * {@link planHybridEnvelopeRewrites}, not through `transformArtifactV06ToV08`.
 * Pure probe — no writes. Bodies are original file bytes with only the leftover
 * key deleted. Drift-gate corpus postconditions still apply at apply time.
 */
export function planRedundantLegacyEnvelopeStrips(
  projectRoot: string,
): { ok: true; pending: ReadonlyArray<StripRewrite> } | { ok: false; error: string } {
  const migratedDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  const artifactPaths = collectFiles(migratedDir, [], { skipArchiveDir: true }).filter((path) =>
    path.endsWith(MIGRATED_ARTIFACT_SUFFIX),
  );
  const pending: StripRewrite[] = [];

  for (const filePath of artifactPaths) {
    const rel = relative(projectRoot, filePath).replace(/\\/g, "/");

    let original: string;
    let parsed: JsonObject;
    try {
      original = readFileSync(filePath, "utf8");
      parsed = JSON.parse(original) as JsonObject;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `failed to parse leftover-envelope candidate ${rel}: ${detail}`,
      };
    }
    if (!isPlainJsonObject(parsed) || !Object.hasOwn(parsed, LEGACY_INFO_ROOT_KEY)) {
      continue;
    }
    // Sole mis-keyed legacy (no xBRIEFInfo) is owned by hybrid rewrite (#5795).
    if (!Object.hasOwn(parsed, MIGRATED_INFO_ROOT_KEY)) {
      continue;
    }

    const canonical = parsed[MIGRATED_INFO_ROOT_KEY];
    if (!isPlainJsonObject(canonical) || canonical.version !== VBRIEF_VERSION) {
      // Dual @0.5/@0.6/@0.7 is owned by hybrid rewrite (transform drops both keys).
      if (needsResidualEnvelopeRewrite(parsed)) {
        continue;
      }
      return {
        ok: false,
        error:
          `non-redundant dual envelope ${rel}: leftover ${LEGACY_INFO_ROOT_KEY} beside ` +
          `${MIGRATED_INFO_ROOT_KEY} that is not @${VBRIEF_VERSION} (refuse merge)`,
      };
    }
    if (!legacyInfoIsRedundantWithCanonical(parsed[LEGACY_INFO_ROOT_KEY], canonical)) {
      return {
        ok: false,
        error:
          `non-redundant dual envelope ${rel}: leftover ${LEGACY_INFO_ROOT_KEY} disagrees ` +
          `with ${MIGRATED_INFO_ROOT_KEY} (refuse merge)`,
      };
    }

    const stripped = omitLegacyInfoKey(parsed);
    const schemaErrors = validateVbriefSchema(stripped, rel);
    if (schemaErrors.length > 0) {
      return {
        ok: false,
        error: `post-strip schema invalid for ${rel}: ${schemaErrors.join("; ")}`,
      };
    }
    if (inMemoryCorpusEnvelopeIsDirty(stripped)) {
      return {
        ok: false,
        error: `post-strip envelope still dirty for ${rel}`,
      };
    }

    const deleted = deleteTopLevelJsonKey(original, LEGACY_INFO_ROOT_KEY);
    if (!deleted.ok) {
      return {
        ok: false,
        error: `failed to delete leftover ${LEGACY_INFO_ROOT_KEY} from original bytes of ${rel}: ${deleted.error}`,
      };
    }

    pending.push({
      path: filePath,
      body: deleted.body,
      original,
    });
  }

  return { ok: true, pending };
}

function stripRewriteRel(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).replace(/\\/g, "/");
}

function stripAtomicTempPath(targetPath: string): string {
  return join(dirname(targetPath), `${basename(targetPath)}.deft-${process.pid}.tmp`);
}

/** Contained temp+rename so a failed replace cannot truncate the live file. */
function containedReplaceAtomic(
  root: string,
  target: string,
  data: string,
): { ok: true } | { ok: false; error: string } {
  const temporary = stripAtomicTempPath(target);
  try {
    containedWrite({
      root,
      target: temporary,
      data,
      mode: "replace",
      mutation: { path: target },
    });
    containedRename({
      root,
      from: temporary,
      to: target,
      mutation: false,
    });
    return { ok: true };
  } catch (err) {
    try {
      containedRemove({ root, target: temporary, mutation: false });
    } catch {
      /* best-effort temp cleanup */
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  }
}

function stripRestoreSet(
  written: ReadonlyArray<StripRewrite>,
  inFlight: StripRewrite | undefined,
): StripRewrite[] {
  if (inFlight === undefined) return [...written];
  if (written.some((entry) => entry.path === inFlight.path)) return [...written];
  return [...written, inFlight];
}

function formatStripRestoreFailures(restoreFailures: ReadonlyArray<string>): string {
  if (restoreFailures.length === 0) return "";
  return `; restore also failed: ${restoreFailures.join("; ")}`;
}

/** Restore originals; never throw — caller includes failures in the returned error. */
function restoreStripOriginals(
  projectRoot: string,
  entries: ReadonlyArray<StripRewrite>,
): string[] {
  const root = resolve(projectRoot);
  const failures: string[] = [];
  for (const entry of entries) {
    const restored = containedReplaceAtomic(root, entry.path, entry.original);
    if (!restored.ok) {
      failures.push(`${stripRewriteRel(projectRoot, entry.path)}: ${restored.error}`);
    }
  }
  return failures;
}

function rollbackStripWrites(
  projectRoot: string,
  written: ReadonlyArray<StripRewrite>,
  inFlight: StripRewrite | undefined,
  detail: string,
): { ok: false; error: string } {
  const restoreFailures = restoreStripOriginals(projectRoot, stripRestoreSet(written, inFlight));
  return {
    ok: false,
    error: `leftover-envelope strip write failed: ${detail}${formatStripRestoreFailures(restoreFailures)}`,
  };
}

interface StripDriftOptions {
  /**
   * The caller deletes `vbrief/` in the same operation (#6571 finish-move), so
   * tracked `vbrief/` paths are not counted against the strip. Every other
   * finding still blocks.
   */
  readonly legacyDirScheduledForRemoval?: boolean;
}

function isScheduledLegacyRemoval(
  finding: { readonly kind: string; readonly path: string },
  options: StripDriftOptions,
): boolean {
  return (
    options.legacyDirScheduledForRemoval === true &&
    finding.kind === "legacy-lifecycle-dir" &&
    (finding.path === LEGACY_ARTIFACT_DIR || finding.path.startsWith(`${LEGACY_ARTIFACT_DIR}/`))
  );
}

/**
 * Write planned leftover-envelope strips via contained temp+rename only after
 * every body is planned. Record the current file before replacing it. Restore
 * that file plus prior writes on failure; restore errors are returned (#4163).
 */
function applyRedundantLegacyEnvelopeStrips(
  projectRoot: string,
  pending: ReadonlyArray<StripRewrite>,
  options: StripDriftOptions = {},
): { ok: true; files: number } | { ok: false; error: string } {
  const pre = evaluateXbriefDrift(projectRoot, { quiet: true });
  if (pre.code === 2) {
    return { ok: false, error: pre.message.trim() };
  }
  const plannedRels = new Set(pending.map((entry) => stripRewriteRel(projectRoot, entry.path)));
  const leftover = pre.findings.filter(
    (finding) =>
      !(finding.kind === "legacy-envelope-key" && plannedRels.has(finding.path)) &&
      !isScheduledLegacyRemoval(finding, options),
  );
  if (leftover.length > 0) {
    return {
      ok: false,
      error:
        pre.message.trim() ||
        "evaluateXbriefDrift has findings the leftover-envelope strip would not clear",
    };
  }

  const root = resolve(projectRoot);
  const written: StripRewrite[] = [];
  let inFlight: StripRewrite | undefined;
  try {
    for (const entry of pending) {
      inFlight = entry;
      const replaced = containedReplaceAtomic(root, entry.path, entry.body);
      if (!replaced.ok) {
        return rollbackStripWrites(projectRoot, written, inFlight, replaced.error);
      }
      written.push(entry);
      inFlight = undefined;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return rollbackStripWrites(projectRoot, written, inFlight, detail);
  }

  const post = evaluateXbriefDrift(projectRoot, { quiet: true });
  const postLeftover = post.findings.filter(
    (finding) => !isScheduledLegacyRemoval(finding, options),
  );
  if (post.code === 2 || postLeftover.length > 0) {
    const restoreFailures = restoreStripOriginals(projectRoot, written);
    return {
      ok: false,
      error: `${
        post.message.trim() ||
        "post-strip evaluateXbriefDrift still red on the drift-gate candidate set"
      }${formatStripRestoreFailures(restoreFailures)}`,
    };
  }
  return { ok: true, files: pending.length };
}

function backupMigrationInputs(
  projectRoot: string,
  legacyDir: string,
  migratedDir: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(projectRoot, ".deft", `xbrief-migrate-backup-${stamp}`);
  mkdirSync(backupRoot, { recursive: true });
  cpSync(legacyDir, join(backupRoot, LEGACY_ARTIFACT_DIR), { recursive: true });
  if (existsSync(migratedDir)) {
    cpSync(migratedDir, join(backupRoot, MIGRATED_ARTIFACT_DIR), { recursive: true });
  }
  return backupRoot;
}

/** Overlay the already-canonical cache last so it wins collisions. */
function overlayCanonicalTriageCache(migratedDir: string, stagedDir: string): void {
  const source = join(migratedDir, ".triage-cache");
  if (!isDirectory(source)) return;
  cpSync(source, join(stagedDir, ".triage-cache"), { recursive: true, force: true });
}

function migrateLegacyTree(
  projectRoot: string,
  legacyDir: string,
  options: { keepLegacy: boolean },
): {
  backupDir: string;
  files: number;
  migratedPaths: string[];
  archivedPaths: string[];
} {
  const migratedDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  const convergence = detectXbriefConvergence(projectRoot);
  const hasCanonicalCache = isDirectory(join(migratedDir, ".triage-cache"));
  if (existsSync(migratedDir) && (convergence.xbriefHasContent || !hasCanonicalCache)) {
    throw new Error(
      `refusing to migrate: '${MIGRATED_ARTIFACT_DIR}/' already exists alongside '${LEGACY_ARTIFACT_DIR}/' and is not a cache-only support tree`,
    );
  }

  assertMigrationSourceSafe(projectRoot, legacyDir);
  const backupDir = backupMigrationInputs(projectRoot, legacyDir, migratedDir);
  const stagedDir = join(projectRoot, `.${MIGRATED_ARTIFACT_DIR}.migrate-staging`);
  if (existsSync(stagedDir)) {
    rmSync(stagedDir, { recursive: true, force: true });
  }
  mkdirSync(stagedDir, { recursive: true });

  const files = collectFiles(legacyDir);
  const migratedPaths: string[] = [];
  const archivedPaths: string[] = [];
  /** Fail closed if two legacy sources would write the same staged path. */
  const claimedTargets = new Map<string, string>();
  try {
    for (const srcPath of files) {
      const rel = relative(legacyDir, srcPath).replace(/\\/g, "/");
      if (shouldOmitLegacyMigrationFile(rel)) continue;
      const destRel = destRelForLegacy(rel);
      const destPath = join(stagedDir, destRel);
      const archiveRel = archiveDestRelative(rel);
      const archivePath = join(stagedDir, archiveRel);
      for (const target of new Set([destRel, archiveRel])) {
        const prior = claimedTargets.get(target);
        if (prior !== undefined && prior !== rel) {
          throw new Error(
            `migration destination collision: '${MIGRATED_ARTIFACT_DIR}/${target}' claimed by both '${prior}' and '${rel}'`,
          );
        }
        claimedTargets.set(target, rel);
      }
      const disposition = writeMigratedFile(projectRoot, srcPath, destPath, archivePath);
      if (disposition === "archived") {
        archivedPaths.push(`${MIGRATED_ARTIFACT_DIR}/${archiveRel}`);
      } else if (disposition === "migrated") {
        migratedPaths.push(`${MIGRATED_ARTIFACT_DIR}/${destRel}`);
      } else {
        migratedPaths.push(`${MIGRATED_ARTIFACT_DIR}/${destRel}`);
      }
    }
    if (archivedPaths.length > 0) {
      ensureArchiveReadme(projectRoot, stagedDir);
    }
    overlayCanonicalTriageCache(migratedDir, stagedDir);
    renameOrReplace(stagedDir, migratedDir);
    // Converge to a single unambiguous root: the fully-migrated legacy tree is
    // either removed (default) or retained for read-compat behind an explicit
    // deprecation marker so it never looks like an active source of truth (#2270).
    if (options.keepLegacy) {
      writeVbriefDeprecationMarker(projectRoot, legacyDir);
    } else {
      rmSync(legacyDir, { recursive: true, force: true });
    }
    return {
      backupDir,
      files: files.length,
      migratedPaths,
      archivedPaths,
    };
  } catch (err) {
    rmSync(stagedDir, { recursive: true, force: true });
    throw err;
  }
}

/** Idempotently write the legacy-root deprecation marker (#2270 / #2869). */
function writeVbriefDeprecationMarker(projectRoot: string, legacyDir: string): void {
  const markerPath = join(legacyDir, VBRIEF_DEPRECATION_MARKER_FILENAME);
  // Refuse leaf or parent-dir symlink escapes via containedWrite (#2869 / #2980 wave C).
  if (hasVbriefDeprecationMarker(legacyDir)) {
    return;
  }
  containedWrite({
    root: resolve(projectRoot),
    target: markerPath,
    data: VBRIEF_DEPRECATION_MARKER_BODY,
    mode: "replace",
  });
}

/**
 * Converge a leftover legacy `vbrief/` root to an unambiguous state (#2270).
 * An effectively-empty tree is removed by default (single canonical root); a
 * tree with real content — or an empty tree when `retain` is requested — is
 * kept for read-compat behind an explicit deprecation marker. Idempotent: a
 * missing dir or an already-marked dir is a no-op.
 */
export function convergeLegacyVbriefRoot(
  projectRoot: string,
  options: { retain: boolean },
): VbriefConvergeAction {
  const legacyDir = join(projectRoot, LEGACY_ARTIFACT_DIR);
  if (!isDirectory(legacyDir)) {
    return "removed";
  }
  if (hasVbriefDeprecationMarker(legacyDir)) {
    return "marker";
  }
  if (isEffectivelyEmptyDir(legacyDir) && !options.retain) {
    rmSync(legacyDir, { recursive: true, force: true });
    return "removed";
  }
  writeVbriefDeprecationMarker(projectRoot, legacyDir);
  return "marker";
}

/** Ending for a raw collision copy of a lifecycle envelope under `xbrief/archive/` (#6571). */
const COLLISION_ARCHIVE_SUFFIX = ".legacy.json";

/**
 * Raw collision copy path under `xbrief/archive/` (#6571). An envelope keeps
 * its folder and stem but ends in `.legacy.json`, so the raw legacy bytes are
 * not read as a canonical `*.xbrief.json` artifact by the drift gate.
 */
function collisionArchiveRelative(legacyRel: string): string {
  const rel = archiveDestRelative(legacyRel);
  return rel.endsWith(MIGRATED_ARTIFACT_SUFFIX)
    ? `${rel.slice(0, -MIGRATED_ARTIFACT_SUFFIX.length)}${COLLISION_ARCHIVE_SUFFIX}`
    : rel;
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Drop a migration-only lifecycle stamp so two migration runs compare equal (#5540). */
function withoutMigrationStamp(value: unknown): unknown {
  if (!isPlainJsonObject(value)) return value;
  const plan = value.plan;
  if (!isPlainJsonObject(plan) || !isMigrationLifecycleWrite(plan)) return value;
  const metadata = plan.metadata;
  if (!isPlainJsonObject(metadata)) return value;
  const restMeta: JsonObject = {};
  for (const [key, entry] of Object.entries(metadata)) {
    if (key !== "lifecycleWrite") restMeta[key] = entry;
  }
  return { ...value, plan: { ...plan, metadata: restMeta } };
}

/**
 * True when `existing` already holds `wanted` (#6571): same bytes, same bytes
 * after CRLF to LF, or the same JSON value ignoring a migration-only stamp.
 */
function sameMigratedContent(existing: string, wanted: string): boolean {
  if (normalizeEol(existing) === normalizeEol(wanted)) return true;
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(existing);
    b = JSON.parse(wanted);
  } catch {
    return false;
  }
  return jsonFieldsEqual(withoutMigrationStamp(a), withoutMigrationStamp(b));
}

type FinishMoveWrite = {
  readonly targetRel: string;
  readonly data: string;
  readonly kind: "migrated" | "archived" | "collision";
};

type FinishMovePlan = {
  readonly files: number;
  readonly writes: FinishMoveWrite[];
  readonly alreadyPresent: string[];
};

/** True when `rel` is the deft-written deprecation marker at the legacy root. */
function isLegacyRootMarker(legacyDir: string, rel: string): boolean {
  return rel === VBRIEF_DEPRECATION_MARKER_FILENAME && hasVbriefDeprecationMarker(legacyDir);
}

/**
 * Plan the finish-move of a leftover `vbrief/` into a populated `xbrief/`
 * (#6571). Reads only. Throws on a claimed-target or archive collision, so
 * nothing is written when any file cannot be placed.
 */
function planFinishLegacyMove(projectRoot: string, legacyDir: string): FinishMovePlan {
  const migratedDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  const files = collectFiles(legacyDir);
  const writes: FinishMoveWrite[] = [];
  const alreadyPresent: string[] = [];
  const claimedTargets = new Map<string, string>();
  const claim = (targetRel: string, rel: string): void => {
    const prior = claimedTargets.get(targetRel);
    if (prior !== undefined && prior !== rel) {
      throw new Error(
        `migration destination collision: '${MIGRATED_ARTIFACT_DIR}/${targetRel}' claimed by both '${prior}' and '${rel}'`,
      );
    }
    claimedTargets.set(targetRel, rel);
  };
  // Raw copy into xbrief/archive/: skip when the same bytes are there, fail closed when different.
  const archiveRaw = (
    rel: string,
    targetRel: string,
    raw: string,
    kind: "archived" | "collision",
  ): void => {
    claim(targetRel, rel);
    const targetPath = join(migratedDir, targetRel);
    if (!existsSync(targetPath)) {
      writes.push({ targetRel, data: raw, kind });
      return;
    }
    const existing = readTextOrNull(targetPath);
    if (existing !== null && normalizeEol(existing) === normalizeEol(raw)) {
      alreadyPresent.push(`${MIGRATED_ARTIFACT_DIR}/${targetRel}`);
      return;
    }
    throw new Error(
      `migration destination collision: '${MIGRATED_ARTIFACT_DIR}/${targetRel}' already exists with different content than '${LEGACY_ARTIFACT_DIR}/${rel}'`,
    );
  };

  for (const srcPath of files) {
    const rel = relative(legacyDir, srcPath).replace(/\\/g, "/");
    if (shouldOmitLegacyMigrationFile(rel) || isLegacyRootMarker(legacyDir, rel)) continue;
    const raw = readFileSync(srcPath, "utf8");
    const disposition = classifyLegacyMigrationFile(srcPath, raw);
    if (disposition.kind === "archive") {
      archiveRaw(rel, archiveDestRelative(rel), raw, "archived");
      continue;
    }
    const destRel = destRelForLegacy(rel);
    claim(destRel, rel);
    const destPath = join(migratedDir, destRel);
    if (!existsSync(destPath)) {
      writes.push({ targetRel: destRel, data: disposition.body, kind: "migrated" });
      continue;
    }
    const existing = readTextOrNull(destPath);
    if (existing !== null && sameMigratedContent(existing, disposition.body)) {
      alreadyPresent.push(`${MIGRATED_ARTIFACT_DIR}/${destRel}`);
      continue;
    }
    // Destination taken with different content: never overwrite xbrief/.
    archiveRaw(rel, collisionArchiveRelative(rel), raw, "collision");
  }
  return { files: files.length, writes, alreadyPresent };
}

/**
 * Finish a leftover `vbrief/` move into a populated `xbrief/`, then delete
 * `vbrief/` (#6571 / D-012; replaces the #2270 marker on the default path).
 * Free destinations are written, identical ones skipped, differing ones copied
 * raw to `xbrief/archive/`. Existing `xbrief/` files are never overwritten
 * (create-only writes). Every collision is found before the backup and the
 * first write; a failed write removes what this run wrote.
 */
function finishLegacyMove(
  projectRoot: string,
  legacyDir: string,
): {
  backupDir: string;
  files: number;
  migratedPaths: string[];
  archivedPaths: string[];
  alreadyPresentPaths: string[];
  collisionArchivedPaths: string[];
} {
  assertMigrationSourceSafe(projectRoot, legacyDir);
  const root = resolve(projectRoot);
  const migratedDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  const plan = planFinishLegacyMove(projectRoot, legacyDir);
  const backupDir = backupMigrationInputs(projectRoot, legacyDir, migratedDir);
  const readme = join(migratedDir, ARCHIVE_REL_DIR, ARCHIVE_README_FILENAME);
  const readmeExisted = existsSync(readme);

  // Every path this run creates, recorded before the write starts, so a write
  // that throws after creating its file is rolled back too. A path that already
  // existed is never recorded (create mode refuses it without writing).
  const created: string[] = [];
  const createFile = (target: string, write: () => void): void => {
    if (existsSync(target)) {
      write();
      return;
    }
    created.push(target);
    write();
  };
  const migratedPaths: string[] = [];
  const archivedPaths: string[] = [];
  const collisionArchivedPaths: string[] = [];
  try {
    for (const entry of plan.writes) {
      const target = join(migratedDir, entry.targetRel);
      createFile(target, () => {
        containedWrite({ root, target, data: entry.data, mode: "create" });
      });
      const shown = `${MIGRATED_ARTIFACT_DIR}/${entry.targetRel}`;
      if (entry.kind === "migrated") {
        migratedPaths.push(shown);
      } else {
        archivedPaths.push(shown);
        if (entry.kind === "collision") collisionArchivedPaths.push(shown);
      }
    }
    if (archivedPaths.length > 0 && !readmeExisted) {
      createFile(readme, () => {
        ensureArchiveReadme(projectRoot, migratedDir);
      });
    }
  } catch (err) {
    for (const target of created) {
      try {
        if (existsSync(target)) containedRemove({ root, target });
      } catch {
        /* best-effort rollback; the backup still holds both trees */
      }
    }
    throw err;
  }
  rmSync(legacyDir, { recursive: true, force: true });
  return {
    backupDir,
    files: plan.files,
    migratedPaths,
    archivedPaths,
    alreadyPresentPaths: plan.alreadyPresent,
    collisionArchivedPaths,
  };
}

/** True when the legacy tree holds nothing but the marker, placeholders or omitted files. */
function legacyHasNothingToMove(legacyDir: string): boolean {
  return collectFiles(legacyDir).every((path) => {
    const rel = relative(legacyDir, path).replace(/\\/g, "/");
    const name = basename(path);
    return (
      shouldOmitLegacyMigrationFile(rel) ||
      isLegacyRootMarker(legacyDir, rel) ||
      name === ".gitkeep" ||
      name === ".keep"
    );
  });
}

/**
 * Default (no keepLegacy) handling of dual-populated and already-marked
 * layouts (#6571 / D-012): residual rewrites under `xbrief/` first (marker
 * case, as before), then the finish-move; `vbrief/` is always removed.
 */
function runFinishLegacyMove(
  projectRoot: string,
  legacyDir: string,
  args: XbriefMigrationArgs,
  options: { readonly residual: boolean },
): XbriefMigrationOutcome {
  if (!args.force) {
    const git = checkGitClean(projectRoot);
    if (git.status === "WARN") {
      return {
        kind: "refused",
        message: `${git.message} ${xbriefMigrationGuidance()} Pass --force to override.`,
      };
    }
  }
  // Refuse a symlinked or escaping vbrief/ before any write or removal, including
  // the marker-only shortcut below (collectFiles does not list links).
  try {
    assertMigrationSourceSafe(projectRoot, legacyDir);
  } catch (err) {
    return { kind: "config", message: err instanceof Error ? err.message : String(err) };
  }
  let residualMessage: string | undefined;
  let residualFiles = 0;
  if (options.residual) {
    // Clean-tree check ran above; the residual pass must not re-refuse. Tracked
    // vbrief/ paths do not block it: this operation deletes vbrief/.
    const residual = rewriteResidualXbriefEnvelopes(
      projectRoot,
      { ...args, force: true },
      { legacyDirScheduledForRemoval: true },
    );
    if (residual !== null) {
      if (residual.kind !== "rewritten") return residual;
      residualMessage = residual.message;
      residualFiles = residual.files;
    }
  }

  if (legacyHasNothingToMove(legacyDir)) {
    rmSync(legacyDir, { recursive: true, force: true });
    const removed = `Removed legacy '${LEGACY_ARTIFACT_DIR}/' — single '${MIGRATED_ARTIFACT_DIR}/' root.`;
    if (residualMessage !== undefined) {
      return { kind: "rewritten", files: residualFiles, message: `${residualMessage} ${removed}` };
    }
    return {
      kind: "converged",
      action: "removed",
      already: false,
      message: `Converged layout: ${removed}`,
    };
  }

  try {
    const moved = finishLegacyMove(projectRoot, legacyDir);
    return {
      kind: "migrated",
      ...moved,
      ...(residualMessage !== undefined ? { residualMessage } : {}),
    };
  } catch (err) {
    return {
      kind: "config",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function renameOrReplace(src: string, dest: string): void {
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(src, dest, { recursive: true });
  rmSync(src, { recursive: true, force: true });
}

function runAgentsRefresh(
  projectRoot: string,
  frameworkRoot: string | undefined,
  io: XbriefMigrationIo,
): number {
  try {
    assertWriteTargetSafe(projectRoot, join(projectRoot, "AGENTS.md"));
    const { state, wrote, writable } = applyAgentsRefresh(projectRoot, {}, { frameworkRoot });
    if (state === "current") {
      io.writeOut("AGENTS.md managed section is current — no changes.\n");
      return 0;
    }
    if (state === "template-missing" || state === "template-malformed" || state === "unreadable") {
      io.writeErr(`agents:refresh failed: ${state}\n`);
      return 2;
    }
    if (!writable) {
      io.writeErr("agents:refresh failed: plan produced no new_content\n");
      return 2;
    }
    if (wrote) {
      io.writeOut(`AGENTS.md updated (state=${state}).\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      io.writeErr(`agents:refresh failed: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

/**
 * In-place residual envelope rewrites under xbrief/ (#3236 / wave3b L1 / #5795).
 * Hybrid bumps and leftover-key strips share one pass so equal-version upgrade
 * clears mis-keyed @0.8 and dual leftovers together. Returns a terminal outcome
 * when work was applied or refused; null when none pending.
 */
function rewriteResidualXbriefEnvelopes(
  projectRoot: string,
  args: XbriefMigrationArgs,
  stripOptions: StripDriftOptions = {},
): XbriefMigrationOutcome | null {
  const plan = planHybridEnvelopeRewrites(projectRoot);
  if (!plan.ok) {
    return { kind: "config", message: plan.error };
  }
  const strip = planRedundantLegacyEnvelopeStrips(projectRoot);
  if (!strip.ok) {
    return { kind: "config", message: strip.error };
  }
  if (plan.pending.length === 0 && strip.pending.length === 0) {
    return null;
  }
  if (!args.force) {
    const git = checkGitClean(projectRoot);
    if (git.status === "WARN") {
      return {
        kind: "refused",
        message: `${git.message} ${xbriefMigrationGuidance()} Pass --force to override.`,
      };
    }
  }

  let hybridFiles = 0;
  if (plan.pending.length > 0) {
    hybridFiles = applyHybridEnvelopeRewrites(projectRoot, plan.pending);
  }
  let stripFiles = 0;
  if (strip.pending.length > 0) {
    const applied = applyRedundantLegacyEnvelopeStrips(projectRoot, strip.pending, stripOptions);
    if (!applied.ok) {
      return { kind: "config", message: applied.error };
    }
    stripFiles = applied.files;
  }

  const parts: string[] = [];
  if (hybridFiles > 0) {
    parts.push(
      `Rewrote ${hybridFiles} residual envelope(s) (${PRE_LEGACY_VBRIEF_VERSION}/${LEGACY_VBRIEF_VERSION}/${MIGRATE_THROUGH_VBRIEF_VERSION}/mis-keyed@${VBRIEF_VERSION}) in place to xBRIEFInfo@${VBRIEF_VERSION}`,
    );
  }
  if (stripFiles > 0) {
    parts.push(
      `Stripped ${stripFiles} redundant leftover vBRIEFInfo envelope(s) beside xBRIEFInfo@${VBRIEF_VERSION}`,
    );
  }
  return {
    kind: "rewritten",
    files: hybridFiles + stripFiles,
    message: `${parts.join("; ")} under '${MIGRATED_ARTIFACT_DIR}/'.`,
  };
}

/** Core orchestrator for the consumer xbrief rename (#2110) + convergence (#2270). */
export function runXbriefMigration(
  args: XbriefMigrationArgs,
  _io: XbriefMigrationIo,
): XbriefMigrationOutcome {
  const projectRoot = resolve(args.projectRoot);
  const legacyDir = join(projectRoot, LEGACY_ARTIFACT_DIR);
  const keepLegacy = args.keepLegacy ?? false;
  const convergence = detectXbriefConvergence(projectRoot);

  switch (convergence.state) {
    // Layout converged behind an explicit marker. Still rewrite residual hybrid
    // envelopes under xbrief/ (#3236) — the marker must not skip JSON bumps
    // (Greptile P1 on #5790: early return previously left xBRIEFInfo@0.6 in place).
    case "xbrief-marker": {
      // #6571 / D-012: without --keep-legacy, finish the move and delete vbrief/.
      if (!keepLegacy) {
        return runFinishLegacyMove(projectRoot, legacyDir, args, {
          residual: convergence.xbriefHasContent,
        });
      }
      if (convergence.xbriefHasContent) {
        const residual = rewriteResidualXbriefEnvelopes(projectRoot, args);
        if (residual !== null) {
          return residual;
        }
      }
      return {
        kind: "converged",
        action: "marker",
        already: true,
        message: `Legacy '${LEGACY_ARTIFACT_DIR}/' already carries a deprecation marker — layout already converged.`,
      };
    }

    // Ambiguous dual-empty root: a fully-migrated empty legacy tree. Converge to
    // a single canonical root by removing it (or marking it when read-compat
    // retention is requested); never leave two indistinguishable empty roots.
    // Read-compat retention is only honored when a canonical xbrief/ actually
    // has content — marking an empty legacy root with no canonical replacement
    // would strand the project behind a marker that claims a migration that
    // never happened, so that case always removes the stray empty root.
    case "empty-vbrief": {
      const retain = keepLegacy && convergence.xbriefHasContent;
      const action = convergeLegacyVbriefRoot(projectRoot, { retain });
      let message: string;
      if (action === "removed") {
        message = convergence.xbriefHasContent
          ? `Converged layout: removed empty legacy '${LEGACY_ARTIFACT_DIR}/' — single '${MIGRATED_ARTIFACT_DIR}/' root.`
          : `Converged layout: removed empty legacy '${LEGACY_ARTIFACT_DIR}/' — no canonical '${MIGRATED_ARTIFACT_DIR}/' root to migrate to yet.`;
      } else {
        message = `Converged layout: wrote deprecation marker to legacy '${LEGACY_ARTIFACT_DIR}/' (retained for read-compat).`;
      }
      return { kind: "converged", action, already: false, message };
    }

    // Legacy content coexisting with a populated canonical xbrief/. Default
    // (#6571 / D-012): finish the move without overwriting xbrief/ and delete
    // vbrief/. With --keep-legacy, keep it behind the #2270 marker instead.
    case "dual-populated": {
      if (!keepLegacy) {
        return runFinishLegacyMove(projectRoot, legacyDir, args, { residual: false });
      }
      convergeLegacyVbriefRoot(projectRoot, { retain: true });
      return {
        kind: "converged",
        action: "marker",
        already: false,
        message: `Converged layout: '${MIGRATED_ARTIFACT_DIR}/' is canonical; wrote deprecation marker to legacy '${LEGACY_ARTIFACT_DIR}/' (retained for read-compat).`,
      };
    }

    default:
      break;
  }

  // #3236 / wave3b L1: on already-xbrief trees with no vbrief/, rewrite residual
  // hybrid xBRIEFInfo@0.6 and orphan @0.7 envelopes in place (same transform).
  // Run before the layout-detection short-circuit so compact `"version":"0.6"`
  // JSON that the string-scan may miss still gets rewritten.
  // (xbrief-marker residual path is handled above in the switch.)
  if (convergence.xbriefHasContent && !convergence.vbriefPresent) {
    const residual = rewriteResidualXbriefEnvelopes(projectRoot, args);
    if (residual !== null) {
      return residual;
    }
  }

  const detection = detectLegacyVbriefLayout(projectRoot);
  if (!detection.legacyLayout) {
    return {
      kind: "noop",
      message: "Project is already on the xbrief layout — nothing to migrate.",
    };
  }

  if (!isDirectory(legacyDir)) {
    // Already on canonical xbrief/ with no vbrief/ tree — residual markers (e.g. a
    // stale deposited v0.6 schema under xbrief/schemas/) are refreshed by update,
    // not migrate:xbrief (#2368). Hybrid 0.6 envelopes were handled above (#3236).
    if (convergence.xbriefHasContent && !convergence.vbriefPresent) {
      return {
        kind: "noop",
        message:
          "Project is already on the xbrief layout — residual legacy markers (e.g. a stale deposited schema) cannot be cleared by migrate:xbrief when no vbrief/ tree remains. Run `directive update` to refresh deposited schema files.",
      };
    }
    return {
      kind: "config",
      message: `Legacy markers detected but '${LEGACY_ARTIFACT_DIR}/' directory is missing.`,
    };
  }

  if (!args.force) {
    const git = checkGitClean(projectRoot);
    if (git.status === "WARN") {
      return {
        kind: "refused",
        message: `${git.message} ${xbriefMigrationGuidance()} Pass --force to override.`,
      };
    }
  }

  try {
    const { backupDir, files, migratedPaths, archivedPaths } = migrateLegacyTree(
      projectRoot,
      legacyDir,
      { keepLegacy },
    );
    return { kind: "migrated", backupDir, files, migratedPaths, archivedPaths };
  } catch (err) {
    return {
      kind: "config",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Map a migration outcome to a process exit code and emit operator guidance. */
export function emitXbriefMigration(
  outcome: XbriefMigrationOutcome,
  io: XbriefMigrationIo,
  options: { signpostOnly?: boolean; projectRoot?: string } = {},
): number {
  if (options.signpostOnly) {
    const root = options.projectRoot ?? process.cwd();
    io.writeOut(`${renderXbriefMigrationLine(root)}\n`);
    return 0;
  }

  switch (outcome.kind) {
    case "noop":
      io.writeOut(`${outcome.message}\n`);
      return 0;
    case "refused":
      io.writeErr(`migrate:xbrief refused: ${outcome.message}\n`);
      return 1;
    case "config":
      io.writeErr(`migrate:xbrief: ${outcome.message}\n`);
      return 2;
    case "migrated": {
      const archived = outcome.archivedPaths.length;
      const migrated = outcome.migratedPaths.length;
      const collision = outcome.collisionArchivedPaths?.length ?? 0;
      const present = outcome.alreadyPresentPaths?.length ?? 0;
      const unknowable = archived - collision;
      io.writeOut(
        (outcome.residualMessage !== undefined ? `${outcome.residualMessage}\n` : "") +
          `Migrated ${migrated} file(s) from ${LEGACY_ARTIFACT_DIR}/ to ${MIGRATED_ARTIFACT_DIR}/` +
          (present > 0 ? `; ${present} already present` : "") +
          (unknowable > 0
            ? `; archived ${unknowable} unknowable file(s) under ${MIGRATED_ARTIFACT_DIR}/${ARCHIVE_REL_DIR}/`
            : "") +
          (collision > 0
            ? `; archived ${collision} file(s) that differ from ${MIGRATED_ARTIFACT_DIR}/ under ${MIGRATED_ARTIFACT_DIR}/${ARCHIVE_REL_DIR}/`
            : "") +
          `.\n` +
          `Backup written to ${outcome.backupDir}.\n`,
      );
      return 0;
    }
    case "rewritten":
      io.writeOut(`${outcome.message}\n`);
      return 0;
    case "converged":
      io.writeOut(`${outcome.message}\n`);
      return 0;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Rewrite legacy `vbrief` crossover tokens in the UNMANAGED AGENTS.md header
 * after lifecycle migration + agents:refresh (#2154). The managed section is
 * left byte-for-byte intact; only the freeform header/tail path literals are
 * patched. Idempotent and non-fatal — a header with no legacy tokens is a
 * clean no-op, and a write failure surfaces as a `failed` outcome on stderr
 * rather than an exception. Always returns 0; the migration itself already
 * succeeded, so a header-patch hiccup must not fail the whole command.
 */
function runHeaderPatch(projectRoot: string, io: XbriefMigrationIo): number {
  const outcome = patchAgentsMdHeader(projectRoot);
  const summary = `${renderHeaderPatchSummary(outcome)}\n`;
  if (outcome.kind === "failed") {
    io.writeErr(summary);
  } else {
    io.writeOut(summary);
  }
  return 0;
}

/** End-to-end migrate:xbrief handler including optional agents:refresh (#2110). */
export function runXbriefMigrationCli(args: XbriefMigrationArgs, io: XbriefMigrationIo): number {
  const outcome = runXbriefMigration(args, io);
  const code = emitXbriefMigration(outcome, io);
  if (code !== 0 || outcome.kind !== "migrated") {
    return code;
  }
  const projectRoot = resolve(args.projectRoot);
  const refreshCode = runAgentsRefresh(projectRoot, args.frameworkRoot, io);
  if (refreshCode !== 0) {
    return refreshCode;
  }
  return runHeaderPatch(projectRoot, io);
}
