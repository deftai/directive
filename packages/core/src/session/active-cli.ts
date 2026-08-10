/**
 * Active CLI path / engine-version check after global upgrade (#3233).
 *
 * A global `npm i -g` can land under one npm prefix while a higher-precedence
 * PATH entry still runs an older `deft` / `directive`. The upgrade looks
 * complete, but bare CLI invocations keep the stale engine.
 *
 * This module resolves every PATH candidate, probes engine versions, and
 * fail-closes when the shell-active binary does not match the upgrade target
 * or is shadowed by a newer lower-precedence install.
 */

import { spawnSync } from "node:child_process";
import { CANONICAL_UPGRADE_COMMAND } from "../doctor/constants.js";
import { defaultWhichAll } from "../doctor/which.js";
import { compareSemver } from "../resolution/pin.js";
import {
  quoteWin32CommandForShell,
  shouldUseShellForCommand,
} from "../verify-env/command-spawn.js";

/** Bare CLI names operators invoke after upgrade. */
export const ACTIVE_CLI_COMMANDS = ["deft", "directive"] as const;
export type ActiveCliCommand = (typeof ACTIVE_CLI_COMMANDS)[number];

const SEMVER_IN_TEXT_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

export interface CliCandidate {
  readonly command: ActiveCliCommand;
  readonly path: string;
  readonly version: string | null;
  /** Zero-based PATH precedence within this command (0 = shell-active). */
  readonly precedence: number;
}

export interface ActiveCliCheckSeams {
  readonly whichAll?: (name: string) => string[];
  readonly probeVersion?: (executablePath: string) => string | null;
  readonly commands?: readonly ActiveCliCommand[];
}

export interface ActiveCliCheckResult {
  /** True when no shadowing / target mismatch was detected. */
  readonly ok: boolean;
  /** 0 = ok, 1 = shadow/mismatch (fail closed), 2 = probe config error (unused; reserved). */
  readonly code: number;
  readonly active: CliCandidate | null;
  readonly candidates: readonly CliCandidate[];
  readonly targetVersion: string | null;
  /** Single-line summary for ritual / exit message. */
  readonly message: string;
  /** Multi-line stderr diagnostic (paths, versions, remediation). */
  readonly lines: readonly string[];
}

function parseVersionFromOutput(out: string): string | null {
  const match = SEMVER_IN_TEXT_RE.exec(out);
  return match?.[1] ?? null;
}

/** Probe engine version from a resolved CLI path (`--version`). */
export function probeCliEngineVersion(executablePath: string): string | null {
  const shell = shouldUseShellForCommand(executablePath);
  const cmd =
    shell && process.platform === "win32"
      ? quoteWin32CommandForShell(executablePath)
      : executablePath;
  try {
    const result = spawnSync(cmd, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
      windowsHide: true,
    });
    if (result.status !== 0) {
      return null;
    }
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    return parseVersionFromOutput(stdout);
  } catch {
    return null;
  }
}

function collectCandidates(seams: ActiveCliCheckSeams): CliCandidate[] {
  const whichAll = seams.whichAll ?? ((name: string) => defaultWhichAll(name));
  const probe = seams.probeVersion ?? probeCliEngineVersion;
  const commands = seams.commands ?? ACTIVE_CLI_COMMANDS;
  const out: CliCandidate[] = [];
  for (const command of commands) {
    const paths = whichAll(command);
    paths.forEach((path, precedence) => {
      out.push({
        command,
        path,
        version: probe(path),
        precedence,
      });
    });
  }
  return out;
}

function formatCandidateLine(c: CliCandidate): string {
  const ver = c.version ?? "unknown";
  const mark = c.precedence === 0 ? " (active)" : "";
  return `  - ${c.path} → engine ${ver}${mark} [${c.command}]`;
}

function remediationLines(params: {
  active: CliCandidate | null;
  targetVersion: string | null;
  newerCandidates: readonly CliCandidate[];
}): string[] {
  const lines: string[] = [
    "[deft session] Remediation (higher-precedence CLI shadows the upgraded install):",
    "  1. Align every global prefix to the same engine version, e.g.:",
    `     ${CANONICAL_UPGRADE_COMMAND}`,
    "     (or `pnpm add -g @deftai/directive@latest` when pnpm owns the active prefix)",
  ];
  if (params.active !== null) {
    lines.push(
      `  2. Confirm the shell-active binary: re-open the shell, then`,
      `     \`${params.active.command} --version\` must report` +
        (params.targetVersion !== null
          ? ` engine @${params.targetVersion}.`
          : " the upgraded engine version."),
    );
    lines.push(
      `  3. If PATH still prefers a stale prefix, put the upgraded npm/pnpm bin dir`,
      `     ahead of ${params.active.path}, or uninstall/upgrade that shadowing install.`,
    );
  } else {
    lines.push(
      "  2. Ensure the upgraded npm/pnpm global bin directory is on PATH, then re-run",
      "     `deft --version` / `directive --version`.",
    );
  }
  if (params.newerCandidates.length > 0) {
    lines.push("  Competing installs (not shell-active but newer or target-matching):");
    for (const c of params.newerCandidates) {
      lines.push(formatCandidateLine(c));
    }
  }
  return lines;
}

/**
 * Fail-closed check: shell-active `deft`/`directive` must match `targetVersion`
 * when provided, and must not be older than another PATH candidate (#3233).
 *
 * When no CLI is on PATH, returns ok=true (absence is covered by verify:tools /
 * engine ladder — this gate only catches shadowing after a multi-prefix install).
 */
export function checkActiveCliAgainstTarget(
  targetVersion: string | null = null,
  seams: ActiveCliCheckSeams = {},
): ActiveCliCheckResult {
  const candidates = collectCandidates(seams);
  if (candidates.length === 0) {
    return {
      ok: true,
      code: 0,
      active: null,
      candidates,
      targetVersion,
      message: "active CLI check skipped (no deft/directive on PATH)",
      lines: [],
    };
  }

  // Group by command; each bare name has its own PATH-active binary.
  const byCommand = new Map<ActiveCliCommand, CliCandidate[]>();
  for (const c of candidates) {
    const list = byCommand.get(c.command) ?? [];
    list.push(c);
    byCommand.set(c.command, list);
  }

  const failures: string[] = [];
  const diagnostic: string[] = ["[deft session] CLI candidates on PATH (precedence order):"];
  for (const c of candidates) {
    diagnostic.push(formatCandidateLine(c));
  }

  let primaryActive: CliCandidate | null = null;
  const competing: CliCandidate[] = [];

  for (const [command, list] of byCommand) {
    const active = list.find((c) => c.precedence === 0) ?? list[0];
    if (!active) continue;
    if (primaryActive === null) {
      primaryActive = active;
    }

    if (targetVersion !== null && targetVersion.length > 0) {
      if (active.version === null) {
        failures.push(
          `shell-active ${command} at ${active.path} did not report an engine version ` +
            `(expected ${targetVersion})`,
        );
      } else if (active.version !== targetVersion) {
        failures.push(
          `shell-active ${command} is engine ${active.version} at ${active.path}, ` +
            `but upgrade target is ${targetVersion}`,
        );
        for (const other of list) {
          if (other.precedence === 0) continue;
          if (
            other.version === targetVersion ||
            compareSemver(other.version, active.version) === 1
          ) {
            competing.push(other);
          }
        }
      }
    }

    // Multi-prefix skew: a lower-precedence candidate is strictly newer than active.
    for (const other of list) {
      if (other.precedence === 0) continue;
      const cmp = compareSemver(other.version, active.version);
      if (cmp === 1) {
        failures.push(
          `shell-active ${command} is engine ${active.version ?? "unknown"} at ${active.path}, ` +
            `but a lower-precedence install is newer (${other.version ?? "unknown"} at ${other.path})`,
        );
        competing.push(other);
      }
    }
  }

  if (failures.length === 0) {
    const activeVer = primaryActive?.version ?? "unknown";
    const activePath = primaryActive?.path ?? "(none)";
    return {
      ok: true,
      code: 0,
      active: primaryActive,
      candidates,
      targetVersion,
      message:
        targetVersion !== null
          ? `active CLI engine ${activeVer} matches target ${targetVersion} (${activePath})`
          : `active CLI engine ${activeVer} is not shadowed (${activePath})`,
      lines: [],
    };
  }

  // Dedup competing by path.
  const seenPath = new Set<string>();
  const uniqueCompeting = competing.filter((c) => {
    if (seenPath.has(c.path)) return false;
    seenPath.add(c.path);
    return true;
  });

  const summary =
    `stale higher-precedence CLI after upgrade: ${failures[0]}` +
    (failures.length > 1 ? ` (+${failures.length - 1} more)` : "");
  const lines = [
    `[deft session] FAIL: ${summary}`,
    ...diagnostic,
    ...remediationLines({
      active: primaryActive,
      targetVersion,
      newerCandidates: uniqueCompeting,
    }),
  ];

  return {
    ok: false,
    code: 1,
    active: primaryActive,
    candidates,
    targetVersion,
    message: summary,
    lines,
  };
}
