/**
 * Active CLI path / engine-version check after global upgrade (#3233).
 *
 * A global `npm i -g` can land under one npm prefix while a higher-precedence
 * PATH entry still runs an older `deft` / `directive`. The upgrade looks
 * complete, but bare CLI invocations keep the stale engine.
 *
 * Shell-active binaries may be probed with `--version`. Lower-precedence PATH
 * candidates are inspected via package.json only (never executed) so gated
 * ritual cannot run unselected PATH entries (#3233 Greptile P1 security).
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CANONICAL_UPGRADE_COMMAND } from "../doctor/constants.js";
import { defaultWhichAll } from "../doctor/which.js";
import { readCorePackageVersion } from "../engine-version.js";
import { compareSemver } from "../resolution/pin.js";
import {
  quoteWin32CommandForShell,
  shouldUseShellForCommand,
} from "../verify-env/command-spawn.js";

/** Bare CLI names operators invoke after upgrade. */
export const ACTIVE_CLI_COMMANDS = ["deft", "directive"] as const;
export type ActiveCliCommand = (typeof ACTIVE_CLI_COMMANDS)[number];

/** Bounded semver extract — avoids ReDoS on long zero-runs (CodeQL). */
const SEMVER_IN_TEXT_RE = /\b(\d{1,6}\.\d{1,6}\.\d{1,6})\b/;
const ENGINE_PKG_NAMES = new Set(["@deftai/directive", "@deftai/directive-core"]);

export interface CliCandidate {
  readonly command: ActiveCliCommand;
  readonly path: string;
  readonly version: string | null;
  /** Zero-based PATH precedence within this command (0 = shell-active). */
  readonly precedence: number;
  /** How the version was obtained (for diagnostics / tests). */
  readonly versionSource: "exec" | "package-json" | "none";
}

export interface ActiveCliCheckSeams {
  readonly whichAll?: (name: string) => string[];
  /**
   * Optional override for version probing. When omitted, active binaries may
   * spawn `--version`; shadowed binaries use package.json only.
   */
  readonly probeVersion?: (executablePath: string, precedence: number) => string | null;
  readonly commands?: readonly ActiveCliCommand[];
  /** Override default upgrade-target resolution (tests). */
  readonly resolveDefaultTarget?: (candidates: readonly CliCandidate[]) => string | null;
  /** Inject in-process engine version for default-target resolution. */
  readonly inProcessVersion?: string | null;
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
  // Cap scan length so CodeQL polynomial-regex alerts cannot fire on huge text.
  const sample = out.length > 512 ? out.slice(0, 512) : out;
  const match = SEMVER_IN_TEXT_RE.exec(sample);
  return match?.[1] ?? null;
}

function isPublishableSemver(version: string | null | undefined): version is string {
  if (typeof version !== "string" || version.length === 0) return false;
  if (version === "0.0.0" || version.includes("0.0.0-dev") || version.includes("dev")) {
    return false;
  }
  return SEMVER_IN_TEXT_RE.test(version);
}

function tryReadPackageVersion(pkgPath: string): string | null {
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const rec = parsed as { name?: unknown; version?: unknown; dependencies?: unknown };
    const name = typeof rec.name === "string" ? rec.name : "";
    if (!ENGINE_PKG_NAMES.has(name)) return null;
    // Prefer directive-core dep when the CLI package version is a workspace/dev 0.0.0.
    if (name === "@deftai/directive" && rec.dependencies && typeof rec.dependencies === "object") {
      const core = (rec.dependencies as Record<string, unknown>)["@deftai/directive-core"];
      if (typeof core === "string") {
        const coreVer = parseVersionFromOutput(core);
        if (coreVer !== null && isPublishableSemver(coreVer)) return coreVer;
      }
    }
    return typeof rec.version === "string" && rec.version.length > 0 ? rec.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve engine version by walking the install tree for package.json (no exec).
 * Follows symlinks and win32 `.cmd` shims that embed a node path.
 */
export function readEngineVersionFromInstallTree(executablePath: string): string | null {
  const seeds: string[] = [executablePath];
  try {
    if (existsSync(executablePath)) {
      const st = lstatSync(executablePath);
      if (st.isSymbolicLink()) {
        try {
          const link = readlinkSync(executablePath);
          seeds.push(resolve(dirname(executablePath), link));
        } catch {
          /* ignore */
        }
      }
      try {
        seeds.push(realpathSync(executablePath));
      } catch {
        /* ignore */
      }
      // Win32 npm shims often contain a path to the real package bin.
      if (/\.(cmd|bat)$/i.test(executablePath)) {
        try {
          const text = readFileSync(executablePath, "utf8");
          const m =
            /%~dp0[\\/](\.\.[\\/].*?node_modules[\\/]@deftai[\\/]directive[\\/][^\s"']+)/i.exec(
              text,
            ) ??
            /([A-Za-z]:\\[^\r\n"']*node_modules[\\/]@deftai[\\/]directive[\\/][^\r\n"']+)/i.exec(
              text,
            ) ??
            /([^\s"']*node_modules[\\/]@deftai[\\/]directive[\\/][^\s"']+)/i.exec(text);
          if (m?.[1]) {
            seeds.push(resolve(dirname(executablePath), m[1].replace(/\//g, "\\")));
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  for (const seed of seeds) {
    let dir = dirname(seed);
    for (let i = 0; i < 12; i += 1) {
      const pkgPath = join(dir, "package.json");
      const ver = tryReadPackageVersion(pkgPath);
      if (ver !== null) {
        const parsed = parseVersionFromOutput(ver) ?? ver;
        if (isPublishableSemver(parsed) || SEMVER_IN_TEXT_RE.test(parsed)) {
          return parseVersionFromOutput(parsed) ?? parsed;
        }
      }
      // npm global: .../node_modules/@deftai/directive
      const nested = join(dir, "node_modules", "@deftai", "directive", "package.json");
      const nestedVer = tryReadPackageVersion(nested);
      if (nestedVer !== null) {
        return parseVersionFromOutput(nestedVer) ?? nestedVer;
      }
      const nestedCore = join(dir, "node_modules", "@deftai", "directive-core", "package.json");
      const nestedCoreVer = tryReadPackageVersion(nestedCore);
      if (nestedCoreVer !== null) {
        return parseVersionFromOutput(nestedCoreVer) ?? nestedCoreVer;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Probe shell-active CLI only via `--version` (never used for shadowed PATH entries). */
export function probeCliEngineVersion(executablePath: string): string | null {
  const fromTree = readEngineVersionFromInstallTree(executablePath);
  if (fromTree !== null) return fromTree;

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

/**
 * Version probe used by the default collector:
 * - precedence 0 (shell-active): package.json first, then `--version` spawn
 * - precedence > 0: package.json only (never execute shadowed PATH entries)
 */
export function probeCandidateVersion(executablePath: string, precedence: number): string | null {
  if (precedence > 0) {
    return readEngineVersionFromInstallTree(executablePath);
  }
  return probeCliEngineVersion(executablePath);
}

function collectCandidates(seams: ActiveCliCheckSeams): CliCandidate[] {
  const whichAll = seams.whichAll ?? ((name: string) => defaultWhichAll(name));
  const probe = seams.probeVersion ?? probeCandidateVersion;
  const commands = seams.commands ?? ACTIVE_CLI_COMMANDS;
  const out: CliCandidate[] = [];
  for (const command of commands) {
    const paths = whichAll(command);
    paths.forEach((path, precedence) => {
      const version = probe(path, precedence);
      out.push({
        command,
        path,
        version,
        precedence,
        versionSource: version === null ? "none" : precedence > 0 ? "package-json" : "exec",
      });
    });
  }
  return out;
}

function formatCandidateLine(c: CliCandidate): string {
  const ver = (c.version ?? "unknown").replace(/\r?\n/g, " ");
  const path = c.path.replace(/\r?\n/g, " ");
  const command = String(c.command).replace(/\r?\n/g, " ");
  const mark = c.precedence === 0 ? " (active)" : "";
  return `  - ${path} → engine ${ver}${mark} [${command}]`;
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

function maxPublishableVersion(versions: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!isPublishableSemver(v)) continue;
    if (best === null || compareSemver(v, best) === 1) {
      best = v;
    }
  }
  return best;
}

/**
 * Default upgrade target when callers omit `targetEngineVersion` (#3233 P1):
 * the max of (1) publishable in-process engine version and (2) versions from
 * **non-active** PATH candidates only. The shell-active CLI must never become
 * its own expected target (lone stale self-match).
 */
export function resolveDefaultActiveCliTarget(
  candidates: readonly CliCandidate[],
  inProcessVersion?: string | null,
): string | null {
  let inProcess = inProcessVersion;
  if (inProcess === undefined) {
    try {
      inProcess = readCorePackageVersion();
    } catch {
      inProcess = null;
    }
  }
  // Independent sources only — exclude precedence-0 (active) versions.
  const fromShadows = candidates.filter((c) => c.precedence > 0).map((c) => c.version);
  return maxPublishableVersion([isPublishableSemver(inProcess) ? inProcess : null, ...fromShadows]);
}

/**
 * Fail-closed check: shell-active `deft`/`directive` must match `targetVersion`
 * (or the resolved default target), and must not be older than another PATH
 * candidate (#3233).
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

  const resolveTarget =
    seams.resolveDefaultTarget ??
    ((cs: readonly CliCandidate[]) => resolveDefaultActiveCliTarget(cs, seams.inProcessVersion));
  const effectiveTarget =
    targetVersion !== null && targetVersion.length > 0 ? targetVersion : resolveTarget(candidates);

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

    if (effectiveTarget !== null && effectiveTarget.length > 0) {
      if (active.version === null) {
        failures.push(
          `shell-active ${command} at ${active.path} did not report an engine version ` +
            `(expected ${effectiveTarget})`,
        );
      } else if (active.version !== effectiveTarget) {
        // Fail when active is behind the target (or simply unequal for exact match).
        const cmp = compareSemver(active.version, effectiveTarget);
        if (cmp === -1 || cmp === null) {
          failures.push(
            `shell-active ${command} is engine ${active.version} at ${active.path}, ` +
              `but upgrade target is ${effectiveTarget}`,
          );
          for (const other of list) {
            if (other.precedence === 0) continue;
            if (
              other.version === effectiveTarget ||
              compareSemver(other.version, active.version) === 1
            ) {
              competing.push(other);
            }
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
      targetVersion: effectiveTarget,
      message:
        effectiveTarget !== null
          ? `active CLI engine ${activeVer} matches target ${effectiveTarget} (${activePath})`
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
      targetVersion: effectiveTarget,
      newerCandidates: uniqueCompeting,
    }),
  ];

  return {
    ok: false,
    code: 1,
    active: primaryActive,
    candidates,
    targetVersion: effectiveTarget,
    message: summary,
    lines,
  };
}
