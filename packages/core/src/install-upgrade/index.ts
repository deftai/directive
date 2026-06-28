import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { manifestTagToVersion, parseInstallManifest } from "../doctor/manifest.js";
import {
  buildInstallManifestText,
  CANONICAL_INSTALL_ROOT,
  type InstallManifestFields,
} from "../init-deposit/scaffold.js";
import { agentsRefreshPlan } from "../platform/agents-md.js";
import { DEV_FALLBACK } from "../platform/constants.js";
import { resolveVersion } from "../platform/resolve-version.js";
import { detectPreCutoverLegacy } from "../vbrief-validate/precutover.js";

export interface InstallUpgradeArgs {
  readonly projectRoot: string;
  readonly frameworkRoot: string;
}

export interface InstallUpgradeIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

function versionMarkerPaths(projectRoot: string): string[] {
  return [join(projectRoot, "vbrief", ".deft-version"), join(projectRoot, ".deft-version")];
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
  const fields: InstallManifestFields = {
    ref: version.startsWith("v") ? version : `v${version}`,
    sha: "content-package",
    tag: version.startsWith("v") ? version : `v${version}`,
    installRoot: deriveInstallRootString(installRoot, projectRoot),
    fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    fetchedBy: "deft-upgrade",
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

/** Port of ``run upgrade`` / ``task install:upgrade`` for the consumer task surface (#1061 / #2022). */
export function runInstallUpgrade(args: InstallUpgradeArgs, io: InstallUpgradeIo): number {
  const projectRoot = resolve(args.projectRoot);
  const frameworkRoot = resolve(args.frameworkRoot);
  const version = resolveVersion({ frameworkRoot });
  const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;

  io.writeOut(`Deft CLI v${normalizedVersion} - Upgrade\n\n`);

  const recorded = readVersionMarker(projectRoot);
  if (recorded === normalizedVersion) {
    io.writeOut(`Project already at ${normalizedVersion}. Nothing to do.\n`);
    return runAgentsRefresh(projectRoot, frameworkRoot, io);
  }

  const legacy = detectPreCutoverLegacy(projectRoot);
  if (legacy.length > 0) {
    io.writeOut(
      `Pre-v0.20 document model detected (${legacy.join(", ")}). Run \`task migrate:vbrief\` first -- it migrates legacy artifacts and creates the lifecycle folder structure. This command only records the framework version.\n`,
    );
  }

  const vbriefDir = join(projectRoot, "vbrief");
  const targetDir =
    existsSync(vbriefDir) && statSync(vbriefDir).isDirectory() ? vbriefDir : projectRoot;
  writeVersionMarker(targetDir, normalizedVersion);

  let writtenManifestPath: string | null = null;
  for (const installCandidate of [join(projectRoot, ".deft", "core"), join(projectRoot, "deft")]) {
    if (existsSync(installCandidate) && statSync(installCandidate).isDirectory()) {
      writtenManifestPath = writeInstallManifestAt(
        installCandidate,
        projectRoot,
        normalizedVersion,
      );
      break;
    }
  }
  migrateLegacyInstallManifest(projectRoot, writtenManifestPath);

  if (recorded === null) {
    io.writeOut(`Recorded framework version ${normalizedVersion} in .deft-version.\n`);
  } else {
    io.writeOut(`Updated .deft-version from ${recorded} to ${normalizedVersion}.\n`);
  }
  io.writeOut(
    "If legacy SPECIFICATION.md or PROJECT.md content remains, run `task migrate:vbrief` to complete the upgrade.\n",
  );

  return runAgentsRefresh(projectRoot, frameworkRoot, io);
}
