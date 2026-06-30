import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { locateManifest, manifestTagToVersion, parseInstallManifest } from "../doctor/manifest.js";
import { readCorePackageVersion } from "../engine-version.js";
import {
  buildInstallManifestText,
  CANONICAL_INSTALL_ROOT,
  type InstallManifestFields,
} from "../init-deposit/scaffold.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { agentsRefreshPlan } from "../platform/agents-md.js";
import { DEV_FALLBACK } from "../platform/constants.js";
import { resolveVersion } from "../platform/resolve-version.js";
import {
  detectPreCutoverLegacy,
  frozenPreCutoverMigrationGuidance,
} from "../vbrief-validate/precutover.js";
import {
  detectLegacyVbriefLayout,
  emitXbriefMigration,
  isPatchOnlyUpgrade,
  renderXbriefMigrationLine,
  runXbriefMigration,
} from "../xbrief-migrate/index.js";

const ENGINE_PACKAGE_FALLBACK = "0.0.0";

/**
 * Resolve the framework version for an upgrade (#2053).
 *
 * `resolveVersion({ frameworkRoot })` reads env / install-manifest / .deft-version
 * / git against the *engine* framework root. When `deft install-upgrade` runs from
 * a global npm install, that root is the npm package directory — which carries no
 * install manifest, no bare marker, and is not its own git repo — so the chain
 * dead-ends at `0.0.0-dev`. Recover by auto-detecting the *consumer project's*
 * deposited manifest, then fall back to the engine package.json version, before
 * surrendering to the dev fallback.
 */
function resolveUpgradeVersion(frameworkRoot: string, projectRoot: string): string {
  const primary = resolveVersion({ frameworkRoot });
  if (primary !== DEV_FALLBACK) return primary;

  const manifestPath = locateManifest(projectRoot, null);
  if (manifestPath) {
    try {
      const tag = manifestTagToVersion(parseInstallManifest(readFileSync(manifestPath, "utf8")));
      if (tag) return tag;
    } catch {
      // fall through to package.json fallback
    }
  }

  const pkgVersion = readCorePackageVersion();
  if (pkgVersion && pkgVersion !== ENGINE_PACKAGE_FALLBACK) return pkgVersion;

  return DEV_FALLBACK;
}

/**
 * The consumer's deposited framework install root (`.deft/core`, then legacy
 * `deft/`), if present. Used as the AGENTS.md render root and manifest target so
 * the refresh renders from the *deposited* templates that match the installed
 * payload -- not the (possibly newer) templates bundled in a global npm engine.
 */
function resolveInstallRoot(projectRoot: string): string | null {
  for (const candidate of [join(projectRoot, ".deft", "core"), join(projectRoot, "deft")]) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Prior `managed_by` provenance sentinel from an install manifest, if any (#2056). */
function readManagedByAt(installRoot: string): string | null {
  const manifestPath = join(installRoot, "VERSION");
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) return null;
  try {
    const value = (
      parseInstallManifest(readFileSync(manifestPath, "utf8")).managed_by ?? ""
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

export interface InstallUpgradeArgs {
  readonly projectRoot: string;
  readonly frameworkRoot: string;
  readonly migrate?: boolean;
  readonly force?: boolean;
}

export interface InstallUpgradeIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

function versionMarkerPaths(projectRoot: string): string[] {
  return [
    join(resolveLifecycleRoot(projectRoot), ".deft-version"),
    join(projectRoot, ".deft-version"),
  ];
}

function readVersionMarker(projectRoot: string): string | null {
  for (const candidate of versionMarkerPaths(projectRoot)) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    try {
      const value = readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function writeVersionMarker(targetDir: string, version: string): void {
  if (version === DEV_FALLBACK) return;
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, ".deft-version"), `${version}\n`, "utf8");
  } catch {
    // best-effort, mirrors Python
  }
}

function deriveInstallRootString(installRoot: string, projectRoot: string): string {
  try {
    return relative(projectRoot, installRoot).split("\\").join("/") || CANONICAL_INSTALL_ROOT;
  } catch {
    return resolve(installRoot).split("\\").join("/");
  }
}

function writeInstallManifestAt(
  installRoot: string,
  projectRoot: string,
  version: string,
): string | null {
  if (version.replace(/^v/, "") === DEV_FALLBACK) return null;
  const priorManagedBy = readManagedByAt(installRoot);
  const fields: InstallManifestFields = {
    ref: version.startsWith("v") ? version : `v${version}`,
    sha: "content-package",
    tag: version.startsWith("v") ? version : `v${version}`,
    installRoot: deriveInstallRootString(installRoot, projectRoot),
    fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    fetchedBy: "deft-upgrade",
    ...(priorManagedBy ? { managedBy: priorManagedBy } : {}),
  };
  try {
    mkdirSync(installRoot, { recursive: true });
    const body = buildInstallManifestText(fields);
    const path = join(installRoot, "VERSION");
    writeFileSync(path, body, "utf8");
    return path;
  } catch {
    return null;
  }
}

function migrateLegacyInstallManifest(
  projectRoot: string,
  canonicalManifestPath: string | null,
): void {
  if (canonicalManifestPath === null) return;
  const canonical = resolve(canonicalManifestPath);
  const expectedParent = resolve(projectRoot, ".deft", "core");
  if (resolve(canonical, "..") !== expectedParent) return;

  const legacy = join(projectRoot, ".deft", "VERSION");
  if (!existsSync(legacy) || !statSync(legacy).isFile()) return;

  try {
    const legacyVersion = manifestTagToVersion(parseInstallManifest(readFileSync(legacy, "utf8")));
    const canonicalVersion = manifestTagToVersion(
      parseInstallManifest(readFileSync(canonical, "utf8")),
    );
    if (legacyVersion !== null && legacyVersion === canonicalVersion) return;
    renameSync(legacy, join(projectRoot, ".deft", "VERSION.premigrate"));
  } catch {
    // best-effort
  }
}

function runAgentsRefresh(
  projectRoot: string,
  frameworkRoot: string,
  io: InstallUpgradeIo,
): number {
  const plan = agentsRefreshPlan(projectRoot, { frameworkRoot }) as Record<string, unknown>;
  const state = String(plan.state ?? "unknown");

  if (state === "current") {
    io.writeOut("AGENTS.md managed section is current — no changes.\n");
    return 0;
  }
  if (state === "template-missing" || state === "template-malformed" || state === "unreadable") {
    io.writeErr(`agents:refresh failed: ${state}\n`);
    return 2;
  }
  const newContent = plan.new_content;
  if (typeof newContent !== "string") {
    io.writeErr("agents:refresh failed: plan produced no new_content\n");
    return 2;
  }
  const path = String(plan.path ?? join(projectRoot, "AGENTS.md"));
  writeFileSync(path, newContent, "utf8");
  io.writeOut(`AGENTS.md updated (state=${state}).\n`);
  return 0;
}

function handleLegacyXbriefLayout(
  args: InstallUpgradeArgs,
  io: InstallUpgradeIo,
  recorded: string | null,
  normalizedVersion: string,
): number {
  const detection = detectLegacyVbriefLayout(args.projectRoot);
  if (!detection.legacyLayout) {
    return 0;
  }

  io.writeOut(`${renderXbriefMigrationLine(args.projectRoot)}\n`);

  const patchInert = isPatchOnlyUpgrade(recorded, normalizedVersion);
  if (!args.migrate || patchInert) {
    return 0;
  }

  const outcome = runXbriefMigration(
    {
      projectRoot: args.projectRoot,
      frameworkRoot: args.frameworkRoot,
      force: args.force,
    },
    io,
  );
  const code = emitXbriefMigration(outcome, io, { projectRoot: args.projectRoot });
  return code;
}

/** Port of ``run upgrade`` / ``task install:upgrade`` for the consumer task surface (#1061 / #2022). */
export function runInstallUpgrade(args: InstallUpgradeArgs, io: InstallUpgradeIo): number {
  const projectRoot = resolve(args.projectRoot);
  const frameworkRoot = resolve(args.frameworkRoot);
  const version = resolveUpgradeVersion(frameworkRoot, projectRoot);
  const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;
  // Render AGENTS.md from the deposited install root so the managed section
  // matches the installed payload, not the engine's bundled templates (which a
  // global npm `deft` may carry at a different version). Falls back to the engine
  // framework root when no deposit is present.
  const installRoot = resolveInstallRoot(projectRoot);
  const agentsRoot = installRoot ?? frameworkRoot;

  io.writeOut(`Deft CLI v${normalizedVersion} - Upgrade\n\n`);

  const recorded = readVersionMarker(projectRoot);
  if (recorded === normalizedVersion) {
    io.writeOut(`Project already at ${normalizedVersion}. Nothing to do.\n`);
    const xbriefCode = handleLegacyXbriefLayout(args, io, recorded, normalizedVersion);
    if (xbriefCode !== 0) return xbriefCode;
    return runAgentsRefresh(projectRoot, agentsRoot, io);
  }

  const legacy = detectPreCutoverLegacy(projectRoot);
  if (legacy.length > 0) {
    io.writeOut(
      `Pre-v0.20 document model detected (${legacy.join(", ")}). ${frozenPreCutoverMigrationGuidance()}\n`,
    );
  }

  const vbriefDir = resolveLifecycleRoot(projectRoot);
  const targetDir =
    existsSync(vbriefDir) && statSync(vbriefDir).isDirectory() ? vbriefDir : projectRoot;
  writeVersionMarker(targetDir, normalizedVersion);

  const writtenManifestPath =
    installRoot !== null
      ? writeInstallManifestAt(installRoot, projectRoot, normalizedVersion)
      : null;
  migrateLegacyInstallManifest(projectRoot, writtenManifestPath);

  if (normalizedVersion === DEV_FALLBACK) {
    // #2053: the marker + manifest writers above no-op on the dev fallback, so do
    // not claim a marker update that never happened.
    io.writeOut(
      "Could not resolve a published framework version (resolved 0.0.0-dev); " +
        ".deft-version marker and install manifest were left unchanged. On a consumer " +
        "install, ensure <project>/.deft/core/VERSION carries a real tag, or upgrade the " +
        "engine with `npm i -g @deftai/directive@latest`.\n",
    );
  } else if (recorded === null) {
    io.writeOut(`Recorded framework version ${normalizedVersion} in .deft-version.\n`);
  } else {
    io.writeOut(`Updated .deft-version from ${recorded} to ${normalizedVersion}.\n`);
  }
  io.writeOut(
    `If legacy SPECIFICATION.md or PROJECT.md content remains, see UPGRADING.md § Frozen pre-v0.20 document-model migration (#2068).\n`,
  );

  const xbriefCode = handleLegacyXbriefLayout(args, io, recorded, normalizedVersion);
  if (xbriefCode !== 0) return xbriefCode;
  return runAgentsRefresh(projectRoot, agentsRoot, io);
}
