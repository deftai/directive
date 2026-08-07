import { join } from "node:path";
import { CANONICAL_GITIGNORE_BASELINE } from "../init-deposit/gitignore.js";
import {
  detectDualLayout,
  detectLegacyLayout,
  dualLayoutSignpostLine,
  type LegacyDetectSeams,
  legacyLayoutSignpostLine,
} from "../init-deposit/legacy-detect.js";
import {
  detectCanonicalVendoredManifest,
  isNpmManaged,
  NPM_MANAGED_SENTINEL_KEY,
  NPM_MANAGED_SENTINEL_VALUE,
} from "../init-deposit/migrate.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { resolveCheckResume } from "../policy/check-resume.js";
import { resolveCoverageDebt } from "../policy/coverage-debt.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";
import { findSkillPathsInText } from "../text/redos-safe.js";
import { stripGitignoreInlineComment } from "../triage/bootstrap/gitignore.js";
import { LEGACY_INFO_ROOT_KEY, MIGRATED_ARTIFACT_DIR } from "../xbrief-migrate/constants.js";
import { detectXbriefConvergence, type XbriefConvergenceState } from "../xbrief-migrate/detect.js";
import {
  CANONICAL_UPGRADE_COMMAND,
  GO_BRIDGE_RELEASES_URL,
  UPGRADING_DOC_URL,
} from "./constants.js";
import {
  isDeprecationRedirectStub,
  locateManifest,
  manifestCandidatePaths,
  manifestReportableVersion,
  manifestTagToVersion,
  parseInstallManifest,
  parseInstallRootFromAgentsMd,
  parseManifest,
} from "./manifest.js";
import { readTextSafe } from "./paths.js";
import type { CheckResult } from "./types.js";

export interface CheckSeams {
  readonly readText?: (path: string) => string | null;
  readonly isFile?: (path: string) => boolean;
  readonly isDir?: (path: string) => boolean;
}

function readText(path: string, seams: CheckSeams): string | null {
  return (seams.readText ?? readTextSafe)(path);
}

export function checkQuickStartResolves(
  projectRoot: string,
  installRoot: string | null,
  seams: CheckSeams = {},
): CheckResult {
  if (installRoot === null) {
    return {
      name: "quick-start-resolves",
      status: "skip",
      detail: "AGENTS.md does not declare an install root; cannot check QUICK-START.md resolution.",
    };
  }
  const qsPath = join(projectRoot, installRoot, "QUICK-START.md");
  const isFile = seams.isFile ?? ((p) => readText(p, seams) !== null);
  if (isFile(qsPath)) {
    return {
      name: "quick-start-resolves",
      status: "pass",
      detail: `Found QUICK-START.md at ${qsPath}.`,
      data: { path: qsPath, install_root: installRoot },
    };
  }
  return {
    name: "quick-start-resolves",
    status: "fail",
    detail:
      `QUICK-START.md not found at ${qsPath}. AGENTS.md claims the ` +
      `install root is '${installRoot}' but the file is missing. ` +
      "Run `.deft/core/run agents:refresh` (Unix) / " +
      "`.deft\\core\\run agents:refresh` (Windows) to align AGENTS.md " +
      "with the on-disk install root, OR run `deft update` to " +
      "re-pull the framework if the on-disk install is missing. " +
      "See UPGRADING.md for the canonical drift-repair walkthrough.",
    data: {
      path: qsPath,
      install_root: installRoot,
      suggested_fix: ".deft/core/run agents:refresh",
      suggested_fix_alt: "deft update",
    },
  };
}

export function checkSkillPathsResolve(
  projectRoot: string,
  agentsMdText: string,
  seams: CheckSeams = {},
): CheckResult {
  const referenced = findSkillPathsInText(agentsMdText).sort();
  if (referenced.length === 0) {
    return {
      name: "skill-paths-resolve",
      status: "skip",
      detail: "AGENTS.md references no skill paths to verify.",
      data: { referenced: [] },
    };
  }
  const missing: string[] = [];
  const redirectStubs: string[] = [];
  const isFile = seams.isFile ?? ((p) => readText(p, seams) !== null);
  for (const rel of referenced) {
    const candidate = join(projectRoot, rel);
    if (!isFile(candidate)) {
      missing.push(rel);
      continue;
    }
    const text = readText(candidate, seams);
    if (text !== null && isDeprecationRedirectStub(text)) {
      redirectStubs.push(rel);
    }
  }
  if (missing.length === 0 && redirectStubs.length === 0) {
    return {
      name: "skill-paths-resolve",
      status: "pass",
      detail: `All ${referenced.length} skill path(s) resolve.`,
      data: { referenced },
    };
  }
  const parts: string[] = [];
  if (missing.length) {
    parts.push(`missing: ${JSON.stringify(missing)}`);
  }
  if (redirectStubs.length) {
    parts.push(`deprecation-redirect stubs: ${JSON.stringify(redirectStubs)}`);
  }
  return {
    name: "skill-paths-resolve",
    status: "fail",
    detail:
      `${missing.length} skill path(s) do not resolve; ${redirectStubs.length} stub redirect(s). ` +
      `${parts.join("; ")}. Run \`.deft/core/run agents:refresh\` (Unix) / ` +
      "`.deft\\core\\run agents:refresh` (Windows) to rewrite the managed AGENTS.md block so skill paths match the on-disk framework, OR run `deft update` if the on-disk skills are missing entirely. See UPGRADING.md for the drift-repair walkthrough.",
    data: {
      referenced,
      missing,
      redirect_stubs: redirectStubs,
      suggested_fix: ".deft/core/run agents:refresh",
      suggested_fix_alt: "deft update",
    },
  };
}

export function checkManifestAgreement(
  projectRoot: string,
  installRoot: string | null,
  seams: CheckSeams = {},
): CheckResult {
  const coreManifest = join(projectRoot, ".deft", "core", "VERSION");
  const legacyManifest = join(projectRoot, ".deft", "VERSION");
  const coreDualText = readText(coreManifest, seams);
  const legacyDualText = readText(legacyManifest, seams);
  if (coreDualText !== null && legacyDualText !== null) {
    const coreVer = manifestTagToVersion(parseManifest(coreDualText));
    const legacyVer = manifestTagToVersion(parseManifest(legacyDualText));
    if (coreVer !== legacyVer) {
      return {
        name: "manifest-agreement",
        status: "fail",
        detail: `Two install manifests disagree: .deft/core/VERSION (tag='${coreVer}') vs legacy .deft/VERSION (tag='${legacyVer}'). The canonical manifest is .deft/core/VERSION -- run \`deft update\` to migrate the stale .deft/VERSION (backed up as .deft/VERSION.premigrate). See UPGRADING.md for the canonical drift-repair walkthrough.`,
        data: {
          dual_manifest_drift: true,
          core_manifest_path: coreManifest,
          legacy_manifest_path: legacyManifest,
          core_version: coreVer,
          legacy_version: legacyVer,
          authoritative: "manifest",
          suggested_fix: "deft update",
        },
      };
    }
  }
  const isFile = seams.isFile ?? ((p) => readText(p, seams) !== null);
  const manifestPath = locateManifest(projectRoot, installRoot, isFile);
  const expectedManifestPath = manifestPath ?? manifestCandidatePaths(projectRoot, installRoot)[0];
  let layoutRoot: string;
  try {
    layoutRoot = resolveLifecycleRoot(projectRoot);
  } catch {
    layoutRoot = projectRoot; // No xbrief/ layout; fall back to project root for bare version check.
  }
  const bareCandidates = [join(layoutRoot, ".deft-version"), join(projectRoot, ".deft-version")];
  const barePath = bareCandidates.find((p) => isFile(p)) ?? null;
  const manifestText = manifestPath ? readText(manifestPath, seams) : null;
  const bareText = barePath ? readText(barePath, seams) : null;
  if (manifestText === null && bareText === null) {
    return {
      name: "manifest-agreement",
      status: "skip",
      detail:
        "Neither YAML manifest nor bare .deft-version exists; nothing to reconcile (greenfield install).",
      data: {
        manifest_path: manifestPath,
        bare_path: barePath,
      },
    };
  }
  if (manifestText === null) {
    return {
      name: "manifest-agreement",
      status: "fail",
      detail: `Bare .deft-version exists at ${barePath} but YAML manifest is missing at ${expectedManifestPath}. Run \`deft update\` to write the canonical manifest (#1046 PR-B AC-4). See UPGRADING.md for the v0.27.x -> v0.28 transition walkthrough.`,
      data: {
        manifest_path: manifestPath,
        expected_manifest_path: expectedManifestPath,
        bare_path: barePath,
        bare_value: bareText?.trim() ?? null,
        suggested_fix: "deft update",
      },
    };
  }
  if (bareText === null) {
    const manifest = parseManifest(manifestText);
    const derived = manifestTagToVersion(manifest);
    return {
      name: "manifest-agreement",
      status: "pass",
      detail: `YAML manifest at ${manifestPath} present; bare .deft-version absent (derived value: '${derived}' from manifest tag). Run \`deft update\` to regenerate the derivative.`,
      data: {
        manifest_path: manifestPath,
        manifest,
        derived_version: derived,
      },
    };
  }
  const manifest = parseManifest(manifestText);
  const derived = manifestTagToVersion(manifest);
  const bareValue = bareText.trim();
  if (derived === null) {
    return {
      name: "manifest-agreement",
      status: "fail",
      detail: `YAML manifest at ${manifestPath} has no parseable tag/ref field; cannot reconcile with bare .deft-version.`,
      data: {
        manifest_path: manifestPath,
        bare_path: barePath,
        manifest,
        bare_value: bareValue,
      },
    };
  }
  if (derived === bareValue) {
    return {
      name: "manifest-agreement",
      status: "pass",
      detail: `YAML manifest (tag='${derived}') agrees with bare .deft-version ('${bareValue}').`,
      data: {
        manifest_path: manifestPath,
        bare_path: barePath,
        derived_version: derived,
        bare_value: bareValue,
      },
    };
  }
  return {
    name: "manifest-agreement",
    status: "fail",
    detail: `Drift detected: YAML manifest tag='${derived}' does NOT agree with bare .deft-version='${bareValue}'. Per #1046 PR-B AC-4 the YAML manifest is the canonical source -- run \`deft update\` to regenerate the bare derivative from the manifest, OR manually update ${manifestPath} if the bare value is correct. See UPGRADING.md for the canonical drift-repair walkthrough.`,
    data: {
      manifest_path: manifestPath,
      bare_path: barePath,
      derived_version: derived,
      bare_value: bareValue,
      authoritative: "manifest",
      suggested_fix: "deft update",
    },
  };
}

export function checkInstallPathConsistency(
  projectRoot: string,
  installRoot: string | null,
  seams: CheckSeams = {},
): CheckResult {
  let effectiveInstallRoot = installRoot;
  let fallbackInfoNote = "";
  let source = "AGENTS.md";
  const isDir = seams.isDir ?? (() => false);
  for (const manifestPath of manifestCandidatePaths(projectRoot, installRoot)) {
    const manifestText = readText(manifestPath, seams);
    if (manifestText === null) {
      continue;
    }
    const manifest = parseManifest(manifestText);
    const manifestInstallRoot = manifest.install_root;
    if (typeof manifestInstallRoot === "string" && manifestInstallRoot.trim()) {
      effectiveInstallRoot = manifestInstallRoot.trim();
      fallbackInfoNote = "";
      source = "manifest";
      break;
    }
    fallbackInfoNote = ` INFO: manifest at ${manifestPath} is missing install_root; fell back to the legacy AGENTS.md install-root parse.`;
    break;
  }
  if (effectiveInstallRoot === null) {
    return {
      name: "install-path-consistency",
      status: "skip",
      detail: `AGENTS.md does not declare an install root.${fallbackInfoNote}`,
      data: {
        claimed_install_root: installRoot,
        effective_install_root: effectiveInstallRoot,
        fallback_info_note: fallbackInfoNote || null,
      },
    };
  }
  const claimedDir = join(projectRoot, effectiveInstallRoot);
  if (!isDir(claimedDir)) {
    return {
      name: "install-path-consistency",
      status: "fail",
      detail: `Install root is recorded as '${effectiveInstallRoot}' (source: ${source}) but ${claimedDir} is not a directory. Pick one of two repair paths: (a) run \`.deft/core/run agents:refresh\` (Unix) / \`.deft\\core\\run agents:refresh\` (Windows) to rewrite AGENTS.md to match the on-disk framework -- pick this if the framework on disk is correct; OR (b) run \`npx @deftai/directive update\` to (re)deposit the framework at the path AGENTS.md / the manifest claims (the npm CLI project deposit, #1912) -- pick this if AGENTS.md is correct. The YAML manifest (if present) is authoritative for the install-layout contract. See UPGRADING.md for the canonical drift-repair walkthrough.`,
      data: {
        claimed_install_root: installRoot,
        effective_install_root: effectiveInstallRoot,
        effective_install_root_source: source,
        claimed_dir: claimedDir,
        claimed_dir_exists: false,
        fallback_info_note: fallbackInfoNote || null,
        suggested_fix: ".deft/core/run agents:refresh",
        suggested_fix_alt: "npx @deftai/directive update",
      },
    };
  }
  return {
    name: "install-path-consistency",
    status: "pass",
    detail:
      `Install root ('${effectiveInstallRoot}', source: ${source}) matches an existing directory at ${claimedDir}.` +
      fallbackInfoNote,
    data: {
      claimed_install_root: installRoot,
      effective_install_root: effectiveInstallRoot,
      effective_install_root_source: source,
      claimed_dir: claimedDir,
      fallback_info_note: fallbackInfoNote || null,
    },
  };
}

/**
 * #1912: signpost a legacy on-disk layout. Carries the STABLE UPGRADING.md URL
 * only -- no baked Go-installer version or literal upgrade command. Returns
 * `skip` for the canonical / greenfield layout (nothing to signpost).
 */
export function checkLegacyLayout(projectRoot: string, seams: CheckSeams = {}): CheckResult {
  const legacySeams: LegacyDetectSeams = {
    ...(seams.readText ? { readText: seams.readText } : {}),
    ...(seams.isFile ? { isFile: seams.isFile } : {}),
    ...(seams.isDir ? { isDir: seams.isDir } : {}),
  };
  const dualLayout = detectDualLayout(projectRoot, legacySeams);
  if (dualLayout !== null) {
    return {
      name: "legacy-layout",
      status: "fail",
      detail: dualLayoutSignpostLine(dualLayout),
      data: {
        legacy_layout: true,
        legacy_layout_kind: dualLayout.kind,
        evidence: [...dualLayout.evidence],
        upgrading_doc_url: UPGRADING_DOC_URL,
        go_bridge_releases_url: GO_BRIDGE_RELEASES_URL,
      },
    };
  }
  const detection = detectLegacyLayout(projectRoot, legacySeams);
  if (!detection.legacy) {
    return {
      name: "legacy-layout",
      status: "skip",
      detail: "No legacy Deft layout detected (canonical .deft/core/ or greenfield).",
      data: { legacy_layout: false },
    };
  }
  return {
    name: "legacy-layout",
    status: "fail",
    detail: legacyLayoutSignpostLine(detection),
    data: {
      legacy_layout: true,
      legacy_layout_kind: detection.kind,
      evidence: [...detection.evidence],
      upgrading_doc_url: UPGRADING_DOC_URL,
      go_bridge_releases_url: GO_BRIDGE_RELEASES_URL,
    },
  };
}

/**
 * #1997: signpost a canonical-vendored `.deft/core/` deposit that has not yet
 * been stamped npm-managed. Local-only (no network).
 */
export function checkCanonicalVendoredNpmSignpost(
  projectRoot: string,
  seams: CheckSeams = {},
): CheckResult {
  const readText = seams.readText ?? readTextSafe;
  const isFile = seams.isFile ?? ((p: string) => readText(p) !== null);
  const manifestPath = detectCanonicalVendoredManifest(projectRoot, isFile);
  if (manifestPath === null) {
    return {
      name: "canonical-vendored-npm-signpost",
      status: "skip",
      detail: "No canonical-vendored .deft/core/ deposit (nothing to signpost).",
      data: { canonical_vendored: false },
    };
  }
  const text = readText(manifestPath);
  if (text === null) {
    return {
      name: "canonical-vendored-npm-signpost",
      status: "skip",
      detail: "Canonical-vendored manifest unreadable.",
      data: { canonical_vendored: true },
    };
  }
  const manifest = parseInstallManifest(text);
  if (isNpmManaged(manifest)) {
    return {
      name: "canonical-vendored-npm-signpost",
      status: "skip",
      detail: "Deposit is already npm-managed (hybrid).",
      data: { canonical_vendored: true, npm_managed: true },
    };
  }
  const detail =
    "Canonical-vendored install (.deft/core/) is not yet npm-managed. " +
    "Post-freeze upgrades run via npm: install the engine with " +
    `\`${CANONICAL_UPGRADE_COMMAND}\`, then run \`directive migrate\` ` +
    `to stamp provenance. See ${UPGRADING_DOC_URL}.`;
  return {
    name: "canonical-vendored-npm-signpost",
    status: "fail",
    detail,
    data: {
      canonical_vendored: true,
      npm_managed: false,
      manifest_path: manifestPath,
      sentinel_key: NPM_MANAGED_SENTINEL_KEY,
      sentinel_value: NPM_MANAGED_SENTINEL_VALUE,
      upgrading_doc_url: UPGRADING_DOC_URL,
    },
  };
}

/**
 * #2294: report whether the located install manifest can surface a version.
 * A legacy `deft-install` deposit made without a release pin writes empty
 * `tag`/`ref` and only a short `sha`, leaving the framework version silently
 * unreportable. Since the Go installer is a frozen legacy bridge (#1912) and
 * the Python/Go rails are retired (#1933/#2022/#2068), the fix is doctor-side:
 * turn the silent blank into a visible, actionable finding. Advisory only --
 * exit-code-exempt like `canonical-vendored-npm-signpost` -- because a sha-only
 * deposit is still a working install, just an unpinned one.
 */
export function checkManifestVersionReportable(
  projectRoot: string,
  installRoot: string | null,
  seams: CheckSeams = {},
): CheckResult {
  const isFile = seams.isFile ?? ((p) => readText(p, seams) !== null);
  const manifestPath = locateManifest(projectRoot, installRoot, isFile);
  if (manifestPath === null) {
    return {
      name: "manifest-version-reportable",
      status: "skip",
      detail: "No install manifest found; no framework version to report.",
      data: { manifest_path: null },
    };
  }
  const text = readText(manifestPath, seams);
  if (text === null) {
    return {
      name: "manifest-version-reportable",
      status: "skip",
      detail: `Install manifest at ${manifestPath} is unreadable.`,
      data: { manifest_path: manifestPath },
    };
  }
  const manifest = parseInstallManifest(text);
  const reportable = manifestReportableVersion(manifest);
  if (reportable.version !== null) {
    return {
      name: "manifest-version-reportable",
      status: "pass",
      detail: `Framework version resolves to ${reportable.version} (from manifest ${reportable.source}) at ${manifestPath}.`,
      data: {
        manifest_path: manifestPath,
        version: reportable.version,
        source: reportable.source,
      },
    };
  }
  if (reportable.sha !== null) {
    const shortSha = reportable.sha.slice(0, 8);
    return {
      name: "manifest-version-reportable",
      status: "fail",
      detail:
        `Install manifest at ${manifestPath} carries no semver tag/ref (sha ${shortSha} only), ` +
        "so the framework version is unreportable. This happens on legacy `deft-install` deposits " +
        `made without a release pin (#2294). Run \`${CANONICAL_UPGRADE_COMMAND}\` then \`directive update\` ` +
        `to obtain a pinned npm-managed manifest. See ${UPGRADING_DOC_URL}.`,
      data: {
        manifest_path: manifestPath,
        version: null,
        source: reportable.source,
        sha: reportable.sha,
        upgrade_command: CANONICAL_UPGRADE_COMMAND,
        upgrading_doc_url: UPGRADING_DOC_URL,
      },
    };
  }
  return {
    name: "manifest-version-reportable",
    status: "skip",
    detail: `Install manifest at ${manifestPath} has neither a semver tag/ref nor a sha; no provenance to report.`,
    data: { manifest_path: manifestPath, version: null, sha: null, source: reportable.source },
  };
}

/**
 * Collect the normalised (inline-comment-stripped) gitignore patterns from a
 * `.gitignore` file text. Uses the shared `stripGitignoreInlineComment` helper
 * so coverage checks stay consistent with `ensureInitGitignoreLines`.
 */
function collectGitignorePresent(text: string): Set<string> {
  const present = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = stripGitignoreInlineComment(raw);
    if (line) present.add(line);
  }
  return present;
}

function gitignoreLineIsCovered(present: ReadonlySet<string>, line: string): boolean {
  return present.has(line);
}

/** Relative path to the deposited v0.6 schema file superseded by xbrief-core-0.8.schema.json. */
export const STALE_VBRIEF_CORE_SCHEMA_REL = join(
  MIGRATED_ARTIFACT_DIR,
  "schemas",
  "vbrief-core.schema.json",
);

const MIGRATED_XBRIEF_LAYOUT_STATES = new Set<XbriefConvergenceState>([
  "xbrief-only",
  "xbrief-marker",
]);

/**
 * #2368: on an already-migrated xbrief/ layout, a stale deposited
 * `xbrief/schemas/vbrief-core.schema.json` (vBRIEFInfo v0.6) must NOT route
 * operators to `migrate:xbrief` — that verb requires a vbrief/ tree. Point at
 * `directive update` instead. Advisory only (exit-exempt).
 */
export function checkStaleXbriefSchemaDeposit(
  projectRoot: string,
  seams: CheckSeams = {},
): CheckResult {
  const checkName = "stale-xbrief-schema-deposit";
  const convergence = detectXbriefConvergence(projectRoot);
  if (!MIGRATED_XBRIEF_LAYOUT_STATES.has(convergence.state)) {
    return {
      name: checkName,
      status: "skip",
      detail:
        "Project is not on a fully migrated xbrief/ layout; stale schema deposit check does not apply.",
      data: { convergence_state: convergence.state },
    };
  }

  const schemaPath = join(projectRoot, STALE_VBRIEF_CORE_SCHEMA_REL);
  const isFile = seams.isFile ?? ((p) => readText(p, seams) !== null);
  if (!isFile(schemaPath)) {
    return {
      name: checkName,
      status: "skip",
      detail: `No deposited schema at ${STALE_VBRIEF_CORE_SCHEMA_REL}.`,
      data: { schema_path: schemaPath },
    };
  }

  const text = readText(schemaPath, seams);
  if (text === null) {
    return {
      name: checkName,
      status: "skip",
      detail: `Deposited schema at ${STALE_VBRIEF_CORE_SCHEMA_REL} is unreadable.`,
      data: { schema_path: schemaPath },
    };
  }

  if (!text.includes(`"${LEGACY_INFO_ROOT_KEY}"`)) {
    return {
      name: checkName,
      status: "pass",
      detail: `Deposited schema at ${STALE_VBRIEF_CORE_SCHEMA_REL} is current (no ${LEGACY_INFO_ROOT_KEY} root key).`,
      data: { schema_path: schemaPath },
    };
  }

  return {
    name: checkName,
    status: "fail",
    detail:
      `Stale deposited schema at ${STALE_VBRIEF_CORE_SCHEMA_REL} still carries the legacy ${LEGACY_INFO_ROOT_KEY} root key on an already-migrated xbrief/ layout. ` +
      "Run `directive update` to refresh deposited schema files — not `deft migrate:xbrief` (no vbrief/ tree remains to convert).",
    data: {
      schema_path: schemaPath,
      convergence_state: convergence.state,
      suggested_fix: "directive update",
    },
  };
}

const TS7_SIDE_BY_SIDE_CHECK = "typescript-7-side-by-side";

function depKeyIsTypescriptEslint(key: string): boolean {
  return key === "typescript-eslint" || key.startsWith("@typescript-eslint/");
}

function depKeysIncludeTypescriptEslint(keys: readonly string[]): boolean {
  return keys.some(depKeyIsTypescriptEslint);
}

function depKeysIncludeEslint(keys: readonly string[]): boolean {
  return keys.includes("eslint");
}

function typescriptValueIs7Bound(value: string): boolean {
  const v = value.trim();
  if (!v || v.includes("@typescript/typescript6")) {
    return false;
  }
  if (/npm:typescript@(?:[\^~>=<]*|\d*)7/i.test(v)) {
    return true;
  }
  if (/^[\^~>=<]*7(?:\.\d|$)/.test(v)) {
    return true;
  }
  if (/^7\.\d/.test(v)) {
    return true;
  }
  return false;
}

function resolveTypescriptDepValue(
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): string | null {
  if (typeof devDeps.typescript === "string") {
    return devDeps.typescript;
  }
  if (typeof deps.typescript === "string") {
    return deps.typescript;
  }
  return null;
}

/**
 * #2591: advisory hint when a TypeScript project pins bare `typescript@7` alongside
 * typescript-eslint without the `@typescript/typescript6` alias. Exit-exempt (like
 * gitignore-coverage) — adoption guidance, not a broken install.
 */
export function checkTypescript7SideBySide(
  projectRoot: string,
  seams: CheckSeams = {},
): CheckResult {
  const packageJsonPath = join(projectRoot, "package.json");
  const text = readText(packageJsonPath, seams);

  if (text === null) {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "skip",
      detail: "package.json not found; nothing to inspect for TypeScript side-by-side layout.",
      data: { package_json_path: packageJsonPath },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "skip",
      detail: "package.json is unreadable; skipping TypeScript side-by-side check.",
      data: { package_json_path: packageJsonPath },
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "skip",
      detail: "package.json has no dependency sections; skipping TypeScript side-by-side check.",
      data: { package_json_path: packageJsonPath },
    };
  }

  const record = parsed as Record<string, unknown>;
  const deps =
    typeof record.dependencies === "object" && record.dependencies !== null
      ? (record.dependencies as Record<string, string>)
      : {};
  const devDeps =
    typeof record.devDependencies === "object" && record.devDependencies !== null
      ? (record.devDependencies as Record<string, string>)
      : {};
  const depKeys = [...Object.keys(deps), ...Object.keys(devDeps)];

  if (depKeys.length === 0) {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "skip",
      detail: "package.json has no dependency sections; skipping TypeScript side-by-side check.",
      data: { package_json_path: packageJsonPath },
    };
  }

  if (!depKeysIncludeTypescriptEslint(depKeys)) {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "pass",
      detail:
        "No typescript-eslint packages declared; TypeScript 7 side-by-side alias not required.",
      data: { package_json_path: packageJsonPath },
    };
  }

  if (!depKeysIncludeEslint(depKeys)) {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "pass",
      detail: "eslint is not declared; TypeScript 7 side-by-side alias not required.",
      data: { package_json_path: packageJsonPath },
    };
  }

  const typescriptValue = resolveTypescriptDepValue(deps, devDeps);
  if (typescriptValue === null) {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "pass",
      detail: "No typescript dependency declared; TypeScript 7 side-by-side alias not required.",
      data: { package_json_path: packageJsonPath },
    };
  }

  if (!typescriptValueIs7Bound(typescriptValue)) {
    return {
      name: TS7_SIDE_BY_SIDE_CHECK,
      status: "pass",
      detail:
        "typescript is not pinned to 7.x (or uses the @typescript/typescript6 alias); side-by-side layout not required.",
      data: {
        package_json_path: packageJsonPath,
        typescript: typescriptValue,
      },
    };
  }

  return {
    name: TS7_SIDE_BY_SIDE_CHECK,
    status: "fail",
    detail:
      "typescript resolves to 7.x without the @typescript/typescript6 alias while typescript-eslint and eslint are present. " +
      "Until TS 7.1, use the side-by-side alias pattern in languages/typescript.md § TypeScript 7 side-by-side (pre-7.1) " +
      "(Cartograph #111: keep typescript on npm:@typescript/typescript6 and install TS 7 under @typescript/native).",
    data: {
      package_json_path: packageJsonPath,
      typescript: typescriptValue,
      suggested_fix: "languages/typescript.md#typescript-7-side-by-side-pre-71",
    },
  };
}

/**
 * #2206: check that the consumer `.gitignore` carries the canonical Deft baseline
 * entries. Advisory (exit-exempt) because missing entries are an adoption risk, not
 * a broken install.
 *
 * Skips when `.gitignore` is absent (greenfield project that has not yet run
 * `directive init` or `directive update`).
 */
export function checkGitignoreCoverage(projectRoot: string, seams: CheckSeams = {}): CheckResult {
  const gitignorePath = join(projectRoot, ".gitignore");
  const text = readText(gitignorePath, seams);

  if (text === null) {
    return {
      name: "gitignore-coverage",
      status: "skip",
      detail: ".gitignore not found; run `directive init` or `directive update` to create it.",
      data: { gitignore_path: gitignorePath, missing: [] },
    };
  }

  const present = collectGitignorePresent(text);
  const missing: string[] = [];
  for (const line of CANONICAL_GITIGNORE_BASELINE) {
    if (!gitignoreLineIsCovered(present, line)) {
      missing.push(line);
    }
  }
  // Check .deft/core/ separately — only required for hybrid/greenfield installs.
  // We conservatively omit it from the missing list here (tracked-deposit projects
  // legitimately omit it). The update path handles this correctly per layout.

  if (missing.length === 0) {
    return {
      name: "gitignore-coverage",
      status: "pass",
      detail: "All canonical Deft .gitignore entries are present.",
      data: { gitignore_path: gitignorePath, missing: [] },
    };
  }

  return {
    name: "gitignore-coverage",
    status: "fail",
    detail:
      `Deft .gitignore coverage incomplete: ${missing.length} canonical entr${missing.length === 1 ? "y" : "ies"} ` +
      `missing (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}). ` +
      "Run `directive update` to add the missing entries (idempotent, safe on re-run). " +
      `Full missing list: ${JSON.stringify(missing)}.`,
    data: {
      gitignore_path: gitignorePath,
      missing,
      suggested_fix: "directive update",
    },
  };
}

/**
 * Surface undecided / invalid coverageDebt + checkResume policy (#3189).
 * Advisory skip when undecided; never hard-fails doctor / check:consumer.
 * Decided-off is quiet; dismiss-with-reason is pass with reason in detail.
 * Invalid typed blocks resolve fail-closed and surface via source=default-on-error.
 */
export function checkCoverageCheckResumePolicy(projectRoot: string): CheckResult {
  const debt = resolveCoverageDebt(projectRoot);
  const resume = resolveCheckResume(projectRoot);
  if (debt.source === "default-on-error" || resume.source === "default-on-error") {
    return {
      name: "coverage-check-resume-policy",
      status: "skip",
      detail:
        "advisory: coverageDebt and/or checkResume block is invalid; " +
        "resolution is fail-closed (mode off, localStamp off, CI never trusts stamps). " +
        `coverageDebt.error=${JSON.stringify(debt.error)}; ` +
        `checkResume.error=${JSON.stringify(resume.error)}. ` +
        "Fix the typed block or re-apply Strict / Hatch-aware / dismiss-with-reason.",
      data: {
        coverageDebt: { status: debt.status, source: debt.source, error: debt.error },
        checkResume: { status: resume.status, source: resume.source, error: resume.error },
        advisory: true,
        invalid: true,
      },
    };
  }
  const undecided = debt.status === "unset" || resume.status === "unset";
  if (!undecided) {
    const dismissParts: string[] = [];
    if (debt.dismissReason) {
      dismissParts.push(`coverageDebt.dismissReason=${JSON.stringify(debt.dismissReason)}`);
    }
    if (resume.dismissReason) {
      dismissParts.push(`checkResume.dismissReason=${JSON.stringify(resume.dismissReason)}`);
    }
    const dismissNote = dismissParts.length > 0 ? ` Dismissed: ${dismissParts.join("; ")}.` : "";
    return {
      name: "coverage-check-resume-policy",
      status: "pass",
      detail:
        `coverageDebt status=${debt.status} mode=${debt.mode}; ` +
        `checkResume status=${resume.status} localStamp=${resume.localStamp}; ` +
        `ciTrustsLocalStamp=false (fixed v1).${dismissNote}`,
      data: {
        coverageDebt: {
          status: debt.status,
          mode: debt.mode,
          autoFile: debt.autoFile,
          dismissReason: debt.dismissReason,
        },
        checkResume: {
          status: resume.status,
          localStamp: resume.localStamp,
          ciTrustsLocalStamp: false,
          dismissReason: resume.dismissReason,
        },
      },
    };
  }
  // Advisory only (status=skip): never hard-fails doctor / check:consumer (#3189).
  // Behavior remains fail-closed while unset; session-start nudge carries the ask.
  return {
    name: "coverage-check-resume-policy",
    status: "skip",
    detail:
      "advisory: coverageDebt and/or checkResume policy is undecided (status=unset). " +
      "Behavior stays fail-closed (no hatch soft-pass, no local suite stamp, CI never trusts stamps). " +
      "Choose Strict / Hatch-aware on the next interactive session-start nudge, or record " +
      "dismiss-with-reason. Inspect: " +
      `\`${policyColonInvocation("show", " --field=coverageDebt")}\` / ` +
      `\`${policyColonInvocation("show", " --field=checkResume")}\`.`,
    data: {
      coverageDebt: { status: debt.status, mode: debt.mode },
      checkResume: { status: resume.status, localStamp: resume.localStamp },
      suggested_fix: policyColonInvocation("show", " --field=coverageDebt"),
      advisory: true,
    },
  };
}

export function deriveExitCode(checks: readonly CheckResult[], errors: readonly string[]): number {
  const exitExempt = new Set([
    "canonical-vendored-npm-signpost",
    "manifest-version-reportable",
    "gitignore-coverage",
    "stale-xbrief-schema-deposit",
    "typescript-7-side-by-side",
    "coverage-check-resume-policy",
  ]);
  if (errors.length > 0 || checks.some((c) => c.status === "error")) {
    return 2;
  }
  if (checks.some((c) => c.status === "fail" && !exitExempt.has(c.name))) {
    return 1;
  }
  return 0;
}

export function runChecksImpl(
  projectRoot: string,
  seams: CheckSeams & { isDir?: (p: string) => boolean } = {},
): import("./types.js").DoctorResult {
  const errors: string[] = [];
  const isDir = seams.isDir ?? (() => false);
  if (!isDir(projectRoot)) {
    return {
      projectRoot,
      installRoot: null,
      exitCode: 2,
      checks: [],
      errors: [`project root does not exist: ${projectRoot}`],
    };
  }
  const agentsMdPath = join(projectRoot, "AGENTS.md");
  const agentsMdText = readText(agentsMdPath, seams);
  let installRoot: string | null = null;
  if (agentsMdText !== null) {
    installRoot = parseInstallRootFromAgentsMd(agentsMdText);
  }
  const checks: CheckResult[] = [];
  if (agentsMdText === null) {
    checks.push({
      name: "agents-md-present",
      status: "fail",
      detail:
        "AGENTS.md not found at project root -- run `.deft/core/run agents:refresh` to generate it from the canonical template.",
      data: { agents_md_path: agentsMdPath },
    });
    checks.push(checkManifestAgreement(projectRoot, null, seams));
    checks.push(checkManifestVersionReportable(projectRoot, null, seams));
    checks.push(checkLegacyLayout(projectRoot, seams));
    checks.push(checkCanonicalVendoredNpmSignpost(projectRoot, seams));
    checks.push(checkStaleXbriefSchemaDeposit(projectRoot, seams));
    checks.push(checkGitignoreCoverage(projectRoot, seams));
    checks.push(checkTypescript7SideBySide(projectRoot, seams));
    checks.push(checkCoverageCheckResumePolicy(projectRoot));
    return {
      projectRoot,
      installRoot: null,
      exitCode: deriveExitCode(checks, errors),
      checks,
      errors,
    };
  }
  checks.push(checkQuickStartResolves(projectRoot, installRoot, seams));
  checks.push(checkSkillPathsResolve(projectRoot, agentsMdText, seams));
  checks.push(checkManifestAgreement(projectRoot, installRoot, seams));
  checks.push(checkManifestVersionReportable(projectRoot, installRoot, seams));
  checks.push(checkInstallPathConsistency(projectRoot, installRoot, seams));
  checks.push(checkLegacyLayout(projectRoot, seams));
  checks.push(checkCanonicalVendoredNpmSignpost(projectRoot, seams));
  checks.push(checkStaleXbriefSchemaDeposit(projectRoot, seams));
  checks.push(checkGitignoreCoverage(projectRoot, seams));
  checks.push(checkTypescript7SideBySide(projectRoot, seams));
  checks.push(checkCoverageCheckResumePolicy(projectRoot));
  return {
    projectRoot,
    installRoot,
    exitCode: deriveExitCode(checks, errors),
    checks,
    errors,
  };
}

export function runChecks(projectRoot: string, seams: CheckSeams = {}): Record<string, unknown> {
  const result = runChecksImpl(projectRoot, seams);
  return {
    project_root: result.projectRoot,
    install_root: result.installRoot,
    exit_code: result.exitCode,
    checks: result.checks.map((c) => ({
      name: c.name,
      status: c.status,
      detail: c.detail,
      data: c.data ?? {},
    })),
    errors: [...result.errors],
  };
}
