import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { CANONICAL_UPGRADE_COMMAND } from "./constants.js";
import { locateManifest, parseInstallManifest } from "./manifest.js";
import type { OutputSink } from "./output.js";
import { readTextSafe, resolveDefaultFrameworkRoot } from "./paths.js";
import type { Finding } from "./types.js";

export interface PayloadStalenessSeams {
  readonly readText?: (path: string) => string | null;
  readonly isFile?: (path: string) => boolean;
  readonly frameworkRoot?: string;
  readonly runGitLsRemote?: (deftDir: string, ref: string) => { ok: boolean; stdout: string };
}

function isDeftFrameworkRepo(projectRoot: string, readText = readTextSafe): boolean {
  try {
    const agents = join(projectRoot, "AGENTS.md");
    const text = readText(agents);
    return text !== null && text.includes("Deft — Development Framework (deft repo)");
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
    addFinding({ severity: "skip", message: "no manifest", check: checkName, status: "skip" });
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
    });
    return;
  }

  const manifest = parseInstallManifest(text);
  const installedSha = (manifest.sha ?? "").trim();
  const ref = (manifest.ref ?? manifest.tag ?? "").trim();
  if (!installedSha) {
    sink.info(`${checkName}: skip -- manifest has no sha (incomplete provenance)`);
    addFinding({
      severity: "skip",
      message: "no sha in manifest",
      check: checkName,
      status: "skip",
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

  let remoteResult: { ok: boolean; stdout: string };
  try {
    remoteResult = runLsRemote(deftDir, ref);
  } catch {
    sink.info(`${checkName}: skip -- could not probe remote (Error)`);
    addFinding({
      severity: "skip",
      message: "remote probe failed",
      check: checkName,
      status: "skip",
    });
    return;
  }

  if (!remoteResult.ok) {
    sink.info(`${checkName}: skip -- git ls-remote failed (no network or no origin)`);
    addFinding({
      severity: "skip",
      message: "ls-remote unavailable",
      check: checkName,
      status: "skip",
    });
    return;
  }

  const remoteSha = parseRemoteSha(remoteResult.stdout);
  if (!remoteSha) {
    sink.info(`${checkName}: skip -- ls-remote produced no sha`);
    addFinding({
      severity: "skip",
      message: "no remote sha",
      check: checkName,
      status: "skip",
    });
    return;
  }

  if (installedSha === remoteSha) {
    sink.info(`${checkName}: current (sha matches remote)`);
    return;
  }

  const msg = `Framework payload is stale (installed sha ${installedSha.slice(0, 8)}... behind remote ${remoteSha.slice(0, 8)}... for ref '${ref}'). Recommendation: run the canonical headless upgrader \`${CANONICAL_UPGRADE_COMMAND}\` from your project root to pull the latest payload (drop \`--json\` for human-readable output). On an installer binary predating the headless flags, download the latest deft-install from GitHub Releases first.`;
  sink.warn(msg);
  addFinding({
    severity: "warning",
    message: msg,
    check: checkName,
    status: "stale",
    installed_sha: installedSha,
    remote_sha: remoteSha,
    ref,
    suggestion: CANONICAL_UPGRADE_COMMAND,
  });
}
