import { join } from "node:path";
import { findSkillPathsInText } from "../text/redos-safe.js";
import {
  isDeprecationRedirectStub,
  locateManifest,
  manifestCandidatePaths,
  manifestTagToVersion,
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
      "with the on-disk install root, OR run `task upgrade` to " +
      "re-pull the framework if the on-disk install is missing. " +
      "See UPGRADING.md for the canonical drift-repair walkthrough.",
    data: {
      path: qsPath,
      install_root: installRoot,
      suggested_fix: ".deft/core/run agents:refresh",
      suggested_fix_alt: "task upgrade",
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
      "`.deft\\core\\run agents:refresh` (Windows) to rewrite the managed AGENTS.md block so skill paths match the on-disk framework, OR run `task upgrade` if the on-disk skills are missing entirely. See UPGRADING.md for the drift-repair walkthrough.",
    data: {
      referenced,
      missing,
      redirect_stubs: redirectStubs,
      suggested_fix: ".deft/core/run agents:refresh",
      suggested_fix_alt: "task upgrade",
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
        detail: `Two install manifests disagree: .deft/core/VERSION (tag='${coreVer}') vs legacy .deft/VERSION (tag='${legacyVer}'). The canonical manifest is .deft/core/VERSION -- run \`task upgrade\` to migrate the stale .deft/VERSION (backed up as .deft/VERSION.premigrate). See UPGRADING.md for the canonical drift-repair walkthrough.`,
        data: {
          dual_manifest_drift: true,
          core_manifest_path: coreManifest,
          legacy_manifest_path: legacyManifest,
          core_version: coreVer,
          legacy_version: legacyVer,
          authoritative: "manifest",
          suggested_fix: "task upgrade",
        },
      };
    }
  }
  const isFile = seams.isFile ?? ((p) => readText(p, seams) !== null);
  const manifestPath = locateManifest(projectRoot, installRoot, isFile);
  const expectedManifestPath = manifestPath ?? manifestCandidatePaths(projectRoot, installRoot)[0];
  const bareCandidates = [
    join(projectRoot, "vbrief", ".deft-version"),
    join(projectRoot, ".deft-version"),
  ];
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
      detail: `Bare .deft-version exists at ${barePath} but YAML manifest is missing at ${expectedManifestPath}. Run \`task upgrade\` to write the canonical manifest (#1046 PR-B AC-4). See UPGRADING.md for the v0.27.x -> v0.28 transition walkthrough.`,
      data: {
        manifest_path: manifestPath,
        expected_manifest_path: expectedManifestPath,
        bare_path: barePath,
        bare_value: bareText?.trim() ?? null,
        suggested_fix: "task upgrade",
      },
    };
  }
  if (bareText === null) {
    const manifest = parseManifest(manifestText);
    const derived = manifestTagToVersion(manifest);
    return {
      name: "manifest-agreement",
      status: "pass",
      detail: `YAML manifest at ${manifestPath} present; bare .deft-version absent (derived value: '${derived}' from manifest tag). Run \`task upgrade\` to regenerate the derivative.`,
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
    detail: `Drift detected: YAML manifest tag='${derived}' does NOT agree with bare .deft-version='${bareValue}'. Per #1046 PR-B AC-4 the YAML manifest is the canonical source -- run \`task upgrade\` to regenerate the bare derivative from the manifest, OR manually update ${manifestPath} if the bare value is correct. See UPGRADING.md for the canonical drift-repair walkthrough.`,
    data: {
      manifest_path: manifestPath,
      bare_path: barePath,
      derived_version: derived,
      bare_value: bareValue,
      authoritative: "manifest",
      suggested_fix: "task upgrade",
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
      detail: `Install root is recorded as '${effectiveInstallRoot}' (source: ${source}) but ${claimedDir} is not a directory. Pick one of two repair paths: (a) run \`.deft/core/run agents:refresh\` (Unix) / \`.deft\\core\\run agents:refresh\` (Windows) to rewrite AGENTS.md to match the on-disk framework -- pick this if the framework on disk is correct; OR (b) run \`task relocate:relocate -- --confirm\` to move the framework to the path AGENTS.md / the manifest claims -- pick this if AGENTS.md is correct. The YAML manifest (if present) is authoritative for the install-layout contract. See UPGRADING.md for the canonical drift-repair walkthrough.`,
      data: {
        claimed_install_root: installRoot,
        effective_install_root: effectiveInstallRoot,
        effective_install_root_source: source,
        claimed_dir: claimedDir,
        claimed_dir_exists: false,
        fallback_info_note: fallbackInfoNote || null,
        suggested_fix: ".deft/core/run agents:refresh",
        suggested_fix_alt: "task relocate:relocate -- --confirm",
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

export function deriveExitCode(checks: readonly CheckResult[], errors: readonly string[]): number {
  if (errors.length > 0 || checks.some((c) => c.status === "error")) {
    return 2;
  }
  if (checks.some((c) => c.status === "fail")) {
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
  checks.push(checkInstallPathConsistency(projectRoot, installRoot, seams));
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
