import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { checkGitClean } from "../migrate-preflight/index.js";
import { applyAgentsRefresh } from "../platform/agents-md.js";
import { patchAgentsMdHeader, renderHeaderPatchSummary } from "./agents-header.js";
import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_VBRIEF_VERSION,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  OBSOLETE_FRAMEWORK_NARRATIVE_FILENAME,
  VBRIEF_DEPRECATION_MARKER_BODY,
  VBRIEF_DEPRECATION_MARKER_FILENAME,
} from "./constants.js";
import { detectLegacyVbriefLayout, detectXbriefConvergence } from "./detect.js";
import { hasVbriefDeprecationMarker, isDirectory, isEffectivelyEmptyDir } from "./fs-helpers.js";
import { assertMigrationSourceSafe } from "./migration-containment.js";
import { renderXbriefMigrationLine, xbriefMigrationGuidance } from "./signpost.js";
import type { JsonObject } from "./transforms.js";
import {
  readDeclaredArtifactVersion,
  rewriteEmbeddedTokens,
  transformArtifactV06ToV08Transactional,
} from "./transforms.js";

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
  | { readonly kind: "migrated"; readonly backupDir: string; readonly files: number }
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

function collectFiles(root: string, acc: string[] = []): string[] {
  if (!isDirectory(root)) {
    return acc;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
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

function writeMigratedFile(projectRoot: string, srcPath: string, destPath: string): void {
  // #2980 wave C: product write sink routes through containedWrite.
  const root = resolve(projectRoot);
  if (srcPath.endsWith(LEGACY_ARTIFACT_SUFFIX)) {
    const parsed = JSON.parse(readFileSync(srcPath, "utf8")) as JsonObject;
    const result = transformArtifactV06ToV08Transactional(parsed);
    if (!result.ok) {
      throw new Error(result.error);
    }
    containedWrite({
      root,
      target: destPath,
      data: `${JSON.stringify(result.artifact, null, 2)}\n`,
      mode: "replace",
    });
    return;
  }

  const raw = readFileSync(srcPath, "utf8");
  containedWrite({
    root,
    target: destPath,
    data: rewriteEmbeddedTokens(raw),
    mode: "replace",
  });
}

/**
 * Plan in-place hybrid envelope rewrites for xbrief lifecycle `.xbrief.json`
 * artifacts that still declare `xBRIEFInfo@0.6` after the layout rename
 * (#3236 / #2974). Pure probe — no writes. Already-0.8 artifacts, schema
 * deposits, and non-0.6 JSON are skipped so residual #2368 schema-only markers
 * still route to `directive update`.
 */
function planHybridEnvelopeRewrites(
  projectRoot: string,
):
  | { ok: true; pending: ReadonlyArray<{ path: string; body: string }> }
  | { ok: false; error: string } {
  const migratedDir = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  const artifactPaths = collectFiles(migratedDir).filter((path) =>
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
    // Only residual v0.6 envelopes are rewrite candidates; skip 0.8 and unknown.
    if (readDeclaredArtifactVersion(parsed) !== LEGACY_VBRIEF_VERSION) {
      continue;
    }
    const result = transformArtifactV06ToV08Transactional(parsed);
    if (!result.ok) {
      return {
        ok: false,
        error: `failed to transform hybrid envelope ${relative(projectRoot, filePath)}: ${result.error}`,
      };
    }
    if (!result.changed) {
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
): { backupDir: string; files: number } {
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
  try {
    for (const srcPath of files) {
      const rel = relative(legacyDir, srcPath);
      if (shouldOmitLegacyMigrationFile(rel)) continue;
      const destPath = join(stagedDir, mapRelativePath(rel));
      writeMigratedFile(projectRoot, srcPath, destPath);
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
    return { backupDir, files: files.length };
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

  // #3236: on already-xbrief trees with no vbrief/, rewrite residual hybrid
  // xBRIEFInfo@0.6 envelopes in place (transform accepts hybrid — #2974).
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
        message: `Rewrote ${files} hybrid xBRIEFInfo@0.6 envelope(s) in place to xBRIEFInfo@0.8 under '${MIGRATED_ARTIFACT_DIR}/'.`,
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
    const { backupDir, files } = migrateLegacyTree(projectRoot, legacyDir, { keepLegacy });
    return { kind: "migrated", backupDir, files };
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
    case "migrated":
      io.writeOut(
        `Migrated ${outcome.files} file(s) from ${LEGACY_ARTIFACT_DIR}/ to ${MIGRATED_ARTIFACT_DIR}/.\n` +
          `Backup written to ${outcome.backupDir}.\n`,
      );
      return 0;
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
