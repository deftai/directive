import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { detectCanonicalVendoredManifest, isNpmManaged } from "../init-deposit/migrate.js";
import { isPublishable } from "../release/version.js";
import type { PackageManager } from "../resolution/package-manager.js";
import {
  CANONICAL_UPGRADE_COMMAND,
  NPM_PACKAGE_NAME,
  upgradeCommandFor,
  VENDORED_NPM_DEPOSIT_UPGRADE_COMMAND,
} from "./constants.js";
import { locateManifest, parseInstallManifest } from "./manifest.js";
import type { OutputSink } from "./output.js";
import { readTextSafe, resolveDefaultFrameworkRoot } from "./paths.js";
import { evaluateReleaseAvailability } from "./release-availability.js";
import type { Finding } from "./types.js";

export interface PayloadStalenessSeams {
  readonly readText?: (path: string) => string | null;
  readonly isFile?: (path: string) => boolean;
  readonly frameworkRoot?: string;
  readonly runGitLsRemote?: (deftDir: string, ref: string) => { ok: boolean; stdout: string };
  readonly runNpmViewVersion?: () => { ok: boolean; version: string };
  /**
   * Active package manager for rendering the upgrade recommendation (#2197).
   * Defaults to npm so existing behaviour/tests are unchanged; the doctor entry
   * detects the manager and threads it here so a pnpm consumer sees the pnpm
   * upgrade one-liner (`pnpm add -g @deftai/directive@latest`).
   */
  readonly packageManager?: PackageManager;
}

function isDeftFrameworkRepo(projectRoot: string, readText = readTextSafe): boolean {
  try {
    const agents = join(projectRoot, "AGENTS.md");
    const text = readText(agents);
    return text?.includes("Deft — Development Framework (deft repo)") ?? false;
  } catch {
    return false;
  }
}

function parseRemoteSha(stdout: string): string {
  let remoteSha = "";
  let peeledSha = "";
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const refname = parts[1] ?? "";
      if (refname.endsWith("^{}")) {
        peeledSha = parts[0] ?? "";
      } else if (!remoteSha) {
        remoteSha = parts[0] ?? "";
      }
    }
  }
  if (peeledSha) {
    return peeledSha;
  }
  if (remoteSha) {
    return remoteSha;
  }
  const firstLine = stdout.split("\n").find((ln) => ln.trim()) ?? "";
  return firstLine.trim().split(/\s+/)[0] ?? "";
}

function defaultNpmViewVersion(): { ok: boolean; version: string } {
  const proc = spawnSync("npm", ["view", NPM_PACKAGE_NAME, "version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const version = (proc.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
  return { ok: proc.status === 0 && version.length > 0, version };
}

function emitReleaseAvailable(
  checkName: string,
  installedVersion: string,
  latestVersion: string,
  ref: string,
  upgradeCommand: string,
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
): void {
  const msg =
    `Newer framework release available (installed v${installedVersion}; ` +
    `latest v${latestVersion} from npm registry). ` +
    `Recommendation: run \`${upgradeCommand}\`.`;
  sink.warn(msg);
  addFinding({
    severity: "warning",
    message: msg,
    check: checkName,
    status: "stale",
    staleness_kind: "newer-release",
    ref,
    installed_version: installedVersion,
    latest_version: latestVersion,
    remote_version: latestVersion,
    resolver: "npm-view",
    suggestion: upgradeCommand,
  });
}

function emitUnverified(
  checkName: string,
  reason: string,
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
): void {
  const msg = `payload currency UNVERIFIED — ${reason}`;
  sink.warn(msg);
  addFinding({
    severity: "warning",
    message: msg,
    check: checkName,
    status: "unverified",
  });
}

function resolveUpgradeCommand(
  projectRoot: string,
  manifest: Record<string, string>,
  isFile: (path: string) => boolean,
  pm: PackageManager = "npm",
): string {
  const vendored =
    detectCanonicalVendoredManifest(projectRoot, isFile) !== null && isNpmManaged(manifest);
  if (pm === "pnpm") {
    // Same registry, same tarball -- only the command form differs (#2197).
    const upgrade = upgradeCommandFor("pnpm");
    return vendored ? `${upgrade} && deft update` : upgrade;
  }
  return vendored ? VENDORED_NPM_DEPOSIT_UPGRADE_COMMAND : CANONICAL_UPGRADE_COMMAND;
}

function emitStale(
  checkName: string,
  installedLabel: string,
  remoteLabel: string,
  ref: string,
  upgradeCommand: string,
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  extras: Record<string, unknown> = {},
): void {
  const msg =
    `Framework payload is stale (installed ${installedLabel} behind remote ${remoteLabel} for ref '${ref}'). ` +
    `Recommendation: run \`${upgradeCommand}\` from any shell with Node ≥ 20.`;
  sink.warn(msg);
  addFinding({
    severity: "warning",
    message: msg,
    check: checkName,
    status: "stale",
    ref,
    suggestion: upgradeCommand,
    ...extras,
  });
}

export function runPayloadStalenessCheck(
  projectRoot: string,
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  seams: PayloadStalenessSeams = {},
): void {
  const checkName = "payload-staleness";
  const readText = seams.readText ?? readTextSafe;
  const isFile = seams.isFile ?? ((p: string) => readText(p) !== null);

  if (isDeftFrameworkRepo(projectRoot, readText)) {
    sink.info(`${checkName}: skip -- running inside deft framework repo`);
    addFinding({
      severity: "skip",
      message: "inside framework repo (no install manifest)",
      check: checkName,
      status: "skip",
      reason: "not-applicable",
    });
    return;
  }

  const frameworkRoot = seams.frameworkRoot ?? resolveDefaultFrameworkRoot();
  let manifestPath: string | null = join(frameworkRoot, "VERSION");
  if (!isFile(manifestPath)) {
    manifestPath = locateManifest(projectRoot, null, isFile);
  }
  if (manifestPath === null) {
    const legacyMarker = join(projectRoot, ".deft-version");
    if (isFile(legacyMarker)) {
      manifestPath = legacyMarker;
    }
  }
  if (manifestPath === null || !isFile(manifestPath)) {
    sink.info(`${checkName}: skip -- no install manifest found (pre-v0.28 or legacy state)`);
    addFinding({
      severity: "skip",
      message: "no manifest",
      check: checkName,
      status: "skip",
      reason: "not-applicable",
    });
    return;
  }

  const text = readText(manifestPath);
  if (text === null) {
    sink.info(`${checkName}: skip -- could not read manifest`);
    addFinding({
      severity: "skip",
      message: "manifest unreadable",
      check: checkName,
      status: "skip",
      reason: "not-applicable",
    });
    return;
  }

  const manifest = parseInstallManifest(text);
  const activePm: PackageManager = seams.packageManager ?? "npm";
  const upgradeCommand = resolveUpgradeCommand(projectRoot, manifest, isFile, activePm);
  const installedSha = (manifest.sha ?? "").trim();
  const ref = (manifest.ref ?? manifest.tag ?? "").trim();
  const tag = (manifest.tag ?? "").trim();
  if (!installedSha) {
    sink.info(`${checkName}: skip -- manifest has no sha (incomplete provenance)`);
    addFinding({
      severity: "skip",
      message: "no sha in manifest",
      check: checkName,
      status: "skip",
      reason: "not-applicable",
    });
    return;
  }
  if (!ref) {
    sink.info(`${checkName}: skip -- manifest has no ref or tag (cannot resolve remote sha)`);
    addFinding({
      severity: "skip",
      message: "no ref/tag in manifest",
      check: checkName,
      status: "skip",
      reason: "not-applicable",
    });
    return;
  }

  const deftDir = dirname(manifestPath);
  const runLsRemote =
    seams.runGitLsRemote ??
    ((dir: string, r: string) => {
      const proc = spawnSync("git", ["-C", dir, "ls-remote", "origin", r], {
        encoding: "utf8",
        timeout: 15_000,
      });
      return { ok: proc.status === 0, stdout: proc.stdout ?? "" };
    });
  const runNpmView = seams.runNpmViewVersion ?? defaultNpmViewVersion;

  let remoteResult: { ok: boolean; stdout: string };
  try {
    remoteResult = runLsRemote(deftDir, ref);
  } catch {
    remoteResult = { ok: false, stdout: "" };
  }

  const remoteSha = remoteResult.ok ? parseRemoteSha(remoteResult.stdout) : "";
  if (remoteSha && installedSha !== remoteSha) {
    emitStale(
      checkName,
      `sha ${installedSha.slice(0, 8)}...`,
      `sha ${remoteSha.slice(0, 8)}...`,
      ref,
      upgradeCommand,
      sink,
      addFinding,
      {
        installed_sha: installedSha,
        remote_sha: remoteSha,
        resolver: "git-ls-remote",
        staleness_kind: "pinned-ref-moved",
      },
    );
    return;
  }

  const normalizedRef = ref.trim().replace(/^refs\/tags\//, "");
  const normalizedTag = tag.trim().replace(/^refs\/tags\//, "");
  // Branch pins (ref not a publishable tag) must not fall through to npm via a stale tag (#2538).
  const installedCandidate = isPublishable(normalizedRef)
    ? normalizedTag || normalizedRef
    : normalizedRef;
  const applicability = evaluateReleaseAvailability(installedCandidate, null);
  if (applicability.status === "not-applicable") {
    if (remoteSha && installedSha === remoteSha) {
      sink.info(`${checkName}: current (sha matches remote; ref is not a release tag)`);
      return;
    }
    const reason = remoteResult.ok
      ? "ls-remote produced no sha; ref is not a release tag"
      : "could not reach remote; ref is not a release tag";
    sink.info(`${checkName}: skip -- ${reason}`);
    emitUnverified(checkName, reason, sink, addFinding);
    return;
  }

  let npmResult: { ok: boolean; version: string };
  try {
    npmResult = runNpmView();
  } catch {
    npmResult = { ok: false, version: "" };
  }
  const availability = evaluateReleaseAvailability(
    installedCandidate,
    npmResult.ok ? npmResult.version : null,
  );
  if (availability.status === "available") {
    emitReleaseAvailable(
      checkName,
      availability.installedVersion,
      availability.latestVersion,
      ref,
      upgradeCommand,
      sink,
      addFinding,
    );
    return;
  }
  if (availability.status === "current") {
    sink.info(`${checkName}: current (installed release >= npm latest)`);
    return;
  }
  if (availability.status === "prerelease-ignored") {
    sink.info(`${checkName}: current (npm candidate is a prerelease; stable install retained)`);
    return;
  }

  const reason = remoteResult.ok
    ? "npm registry release lookup unavailable or returned a non-publishable version"
    : "could not reach remote (git ls-remote / npm view both unavailable)";
  sink.info(`${checkName}: skip -- ${reason}`);
  emitUnverified(checkName, reason, sink, addFinding);
}
