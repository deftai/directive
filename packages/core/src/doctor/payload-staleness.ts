import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { CANONICAL_UPGRADE_COMMAND, NPM_PACKAGE_NAME } from "./constants.js";
import { locateManifest, parseInstallManifest } from "./manifest.js";
import type { OutputSink } from "./output.js";
import { readTextSafe, resolveDefaultFrameworkRoot } from "./paths.js";
import type { Finding } from "./types.js";

export interface PayloadStalenessSeams {
  readonly readText?: (path: string) => string | null;
  readonly isFile?: (path: string) => boolean;
  readonly frameworkRoot?: string;
  readonly runGitLsRemote?: (deftDir: string, ref: string) => { ok: boolean; stdout: string };
  readonly runNpmViewVersion?: () => { ok: boolean; version: string };
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

function parseSemver(version: string): number[] {
  const normalized = version.trim().replace(/^v/i, "");
  const parts: number[] = [];
  for (const segment of normalized.split(".")) {
    const numeric = Number.parseInt(segment.split("-")[0] ?? "", 10);
    if (Number.isNaN(numeric)) {
      break;
    }
    parts.push(numeric);
  }
  return parts.length > 0 ? parts : [0];
}

function semverLessThan(left: string, right: string): boolean {
  const a = parseSemver(left);
  const b = parseSemver(right);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) {
      return true;
    }
    if (av > bv) {
      return false;
    }
  }
  return false;
}

function manifestVersion(ref: string, tag: string): string {
  const candidate = (tag || ref).trim().replace(/^refs\/tags\//, "");
  const normalized = candidate.replace(/^v/i, "");
  if (!/^\d+(?:\.\d+)*/.test(normalized)) {
    return "";
  }
  return normalized;
}

function defaultNpmViewVersion(): { ok: boolean; version: string } {
  const proc = spawnSync("npm", ["view", NPM_PACKAGE_NAME, "version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const version = (proc.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
  return { ok: proc.status === 0 && version.length > 0, version };
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

function emitStale(
  checkName: string,
  installedLabel: string,
  remoteLabel: string,
  ref: string,
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  extras: Record<string, unknown> = {},
  behindWord: "remote" | "npm registry" = "remote",
): void {
  const msg =
    `Framework payload is stale (installed ${installedLabel} behind ${behindWord} ${remoteLabel} for ref '${ref}'). ` +
    `Recommendation: run \`${CANONICAL_UPGRADE_COMMAND}\` from any shell with Node ≥ 20.`;
  sink.warn(msg);
  addFinding({
    severity: "warning",
    message: msg,
    check: checkName,
    status: "stale",
    ref,
    suggestion: CANONICAL_UPGRADE_COMMAND,
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

  if (remoteResult.ok) {
    const remoteSha = parseRemoteSha(remoteResult.stdout);
    if (remoteSha) {
      if (installedSha === remoteSha) {
        sink.info(`${checkName}: current (sha matches remote)`);
        return;
      }
      emitStale(
        checkName,
        `sha ${installedSha.slice(0, 8)}...`,
        `sha ${remoteSha.slice(0, 8)}...`,
        ref,
        sink,
        addFinding,
        { installed_sha: installedSha, remote_sha: remoteSha, resolver: "git-ls-remote" },
      );
      return;
    }
  }

  const npmResult = runNpmView();
  const installedVersion = manifestVersion(ref, tag);
  if (npmResult.ok && installedVersion) {
    if (semverLessThan(installedVersion, npmResult.version)) {
      emitStale(
        checkName,
        `v${installedVersion}`,
        `v${npmResult.version}`,
        ref,
        sink,
        addFinding,
        {
          installed_version: installedVersion,
          remote_version: npmResult.version,
          resolver: "npm-view",
        },
        "npm registry",
      );
      return;
    }
    if (installedVersion === npmResult.version.replace(/^v/i, "")) {
      sink.info(`${checkName}: current (version matches npm registry)`);
      return;
    }
    sink.info(`${checkName}: current (installed version >= npm registry)`);
    return;
  }

  const reason = remoteResult.ok
    ? "ls-remote produced no sha and npm registry fallback unavailable"
    : "could not reach remote (git ls-remote / npm view both unavailable)";
  sink.info(`${checkName}: skip -- ${reason}`);
  emitUnverified(checkName, reason, sink, addFinding);
}
