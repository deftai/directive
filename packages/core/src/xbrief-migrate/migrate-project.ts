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
import {
  evaluateXbriefDrift,
  inMemoryCorpusEnvelopeIsDirty,
  isCorpusEnvelopeCandidatePath,
} from "./drift-gate.js";
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
   * deprecation marker instead of removing it (#2270). Default: remove.
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
      readonly archivedPaths: readonly string[];
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

function archiveDestRelative(legacyRel: string): string {
  const mapped = mapRelativePath(legacyRel);
  return `${ARCHIVE_REL_DIR}/${mapped}`;
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

/**
 * Plan in-place hybrid envelope rewrites for xbrief lifecycle `.xbrief.json`
 * artifacts that still declare `xBRIEFInfo@0.6` (or orphan rename-era `@0.7`)
 * after the layout rename (#3236 / #2974 / wave3b L1). Pure probe — no writes.
 * Already-0.8 artifacts, schema deposits, and other versions are skipped so
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
    // Residual 0.6 + orphan 0.7 only; skip 0.8 and unknown (0.7 is migrate-through).
    if (!isHybridRewriteSourceVersion(readDeclaredArtifactVersion(parsed))) {
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
 * Plan in-place leftover-`vBRIEFInfo` strips for the same candidate set as
 * `scanCorpusEnvelope` (#4163). Beside {@link planHybridEnvelopeRewrites}, not
 * through `transformArtifactV06ToV08`. Pure probe — no writes. Bodies are
 * original file bytes with only the leftover key deleted.
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
    if (!isCorpusEnvelopeCandidatePath(rel)) continue;

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

    const canonical = parsed[MIGRATED_INFO_ROOT_KEY];
    if (!isPlainJsonObject(canonical) || canonical.version !== VBRIEF_VERSION) {
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

/**
 * Write planned leftover-envelope strips via contained temp+rename only after
 * every body is planned. Record the current file before replacing it. Restore
 * that file plus prior writes on failure; restore errors are returned (#4163).
 */
function applyRedundantLegacyEnvelopeStrips(
  projectRoot: string,
  pending: ReadonlyArray<StripRewrite>,
): { ok: true; files: number } | { ok: false; error: string } {
  const pre = evaluateXbriefDrift(projectRoot, { quiet: true });
  if (pre.code === 2) {
    return { ok: false, error: pre.message.trim() };
  }
  const plannedRels = new Set(pending.map((entry) => stripRewriteRel(projectRoot, entry.path)));
  const leftover = pre.findings.filter(
    (finding) => !(finding.kind === "legacy-envelope-key" && plannedRels.has(finding.path)),
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
  if (post.code !== 0) {
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
  try {
    for (const srcPath of files) {
      const rel = relative(legacyDir, srcPath).replace(/\\/g, "/");
      if (shouldOmitLegacyMigrationFile(rel)) continue;
      const destRel = mapRelativePath(rel);
      const destPath = join(stagedDir, destRel);
      const archiveRel = archiveDestRelative(rel);
      const archivePath = join(stagedDir, archiveRel);
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
    // Already converged: legacy root is retained behind an explicit marker.
    // Rerun is a pure no-op (no re-removal, no duplicate marker) — idempotent.
    case "xbrief-marker":
      return {
        kind: "converged",
        action: "marker",
        already: true,
        message: `Legacy '${LEGACY_ARTIFACT_DIR}/' already carries a deprecation marker — layout already converged.`,
      };

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

    // Legacy content coexisting with a populated canonical xbrief/. We never
    // destructively merge; converge non-destructively by marking the legacy
    // tree deprecated so it no longer looks like an active source of truth.
    case "dual-populated": {
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
  if (convergence.xbriefHasContent && !convergence.vbriefPresent) {
    const plan = planHybridEnvelopeRewrites(projectRoot);
    if (!plan.ok) {
      return { kind: "config", message: plan.error };
    }
    if (plan.pending.length > 0) {
      if (!args.force) {
        const git = checkGitClean(projectRoot);
        if (git.status === "WARN") {
          return {
            kind: "refused",
            message: `${git.message} ${xbriefMigrationGuidance()} Pass --force to override.`,
          };
        }
      }
      const files = applyHybridEnvelopeRewrites(projectRoot, plan.pending);
      return {
        kind: "rewritten",
        files,
        message: `Rewrote ${files} residual envelope(s) (${PRE_LEGACY_VBRIEF_VERSION}/${LEGACY_VBRIEF_VERSION}/${MIGRATE_THROUGH_VBRIEF_VERSION}) in place to xBRIEFInfo@${VBRIEF_VERSION} under '${MIGRATED_ARTIFACT_DIR}/'.`,
      };
    }

    const strip = planRedundantLegacyEnvelopeStrips(projectRoot);
    if (!strip.ok) {
      return { kind: "config", message: strip.error };
    }
    if (strip.pending.length > 0) {
      if (!args.force) {
        const git = checkGitClean(projectRoot);
        if (git.status === "WARN") {
          return {
            kind: "refused",
            message: `${git.message} ${xbriefMigrationGuidance()} Pass --force to override.`,
          };
        }
      }
      const applied = applyRedundantLegacyEnvelopeStrips(projectRoot, strip.pending);
      if (!applied.ok) {
        return { kind: "config", message: applied.error };
      }
      return {
        kind: "rewritten",
        files: applied.files,
        message: `Stripped ${applied.files} redundant leftover vBRIEFInfo envelope(s) beside xBRIEFInfo@0.8 under '${MIGRATED_ARTIFACT_DIR}/'.`,
      };
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
      io.writeOut(
        `Migrated ${migrated} file(s) from ${LEGACY_ARTIFACT_DIR}/ to ${MIGRATED_ARTIFACT_DIR}/` +
          (archived > 0
            ? `; archived ${archived} unknowable file(s) under ${MIGRATED_ARTIFACT_DIR}/${ARCHIVE_REL_DIR}/`
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
