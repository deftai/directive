/**
 * Hook-runtime travel warning (#3785).
 *
 * Directive keeps the agent-hook registration files trackable by design and
 * born-ignores the deposit that implements them. When a registration travels
 * with the tree and nothing in that tree lets a clone obtain `deft-hook`, the
 * registration arrives and the runtime does not. A fresh clone, CI runner, or
 * container without a global install then fail-closes every mutation on an
 * opaque exit 127, and no Directive code runs to explain it.
 *
 * "Travels" means tracked OR trackable-and-not-ignored. A first `deft init`
 * writes the registration unstaged, so a tracked-only probe would go quiet on
 * exactly the run that precedes the commit carrying the fence into every clone.
 *
 * The committed `package.json` dependency on `@deftai/directive` (#2264) is the
 * existing reconstitution anchor. With it a clone can install the runtime the
 * registration names; without it the registration names a command no clone can
 * host.
 *
 * Warn-only. Refusing `deft init` / `deft update` on this condition would be
 * the same lockout from the other side, so the deposit still writes and
 * reports. Absence of the runtime stays a deny — fail-open-on-absence was
 * refuted as unimplementable and as a bypass primitive (#3156).
 *
 * Refs #3785, #3736, #3571, #2752, #2264, #3156.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  disableHostHooksInvocation,
  type HookHost,
  type HostHooksPolicy,
  isHostHookDepositEnabled,
} from "../policy/host-hooks.js";
import { PIN_DEPENDENCY_NAME, type PinReadResult, readPin } from "../resolution/pin.js";

/**
 * Hosts whose registration is deposited `failClosed: true`. Only these turn a
 * missing runtime into a denial; the rest fail open and merely lose the gate.
 */
export const FAIL_CLOSED_HOOK_HOSTS: readonly HookHost[] = ["cursor"];

/** Manifest carrying the committed runtime anchor. */
export const RUNTIME_ANCHOR_MANIFEST = "package.json";

export type GitLsFilesProbe = (projectDir: string, paths: readonly string[]) => string | null;

export interface HookRuntimeTravelSeams {
  readonly gitLsFiles?: GitLsFilesProbe;
  readonly readPin?: (projectRoot: string) => PinReadResult;
}

/** One deposited registration considered by the probe. */
export interface HookRegistrationRef {
  readonly host: HookHost;
  readonly path: string;
}

export interface HookRuntimeTravelResult {
  /** Enabled registrations that travel with this repository. */
  readonly travelingRegistrations: readonly string[];
  /** Subset of {@link travelingRegistrations} deposited fail-closed. */
  readonly failClosedRegistrations: readonly string[];
  /** A committed manifest declares `@deftai/directive`, so a clone can install it. */
  readonly runtimeTravels: boolean;
  /** Null when the pairing is safe or git could not answer. */
  readonly warning: string | null;
}

function defaultGitLsFiles(projectDir: string, paths: readonly string[]): string | null {
  // `.git` is a directory in a clone and a file in a linked worktree. Absent
  // means the deposit root is not a repository root, so travel has no answer
  // worth reporting -- and the probe costs nothing.
  if (!existsSync(join(projectDir, ".git"))) return null;
  try {
    // `--cached` catches an already-committed registration; `--others
    // --exclude-standard` catches one a first `deft init` just wrote, which is
    // untracked yet trackable and so lands in the consumer's next `git add`.
    // Ignored paths are omitted: they cannot reach a clone.
    return execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...paths],
      {
        cwd: projectDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
  } catch {
    // git absent, or not a repository: whether these paths travel has no answer
    // here, so the caller stays silent rather than guessing.
    return null;
  }
}

/** Paths that travel, as reported by git, or null when git could not answer. */
function travelingPaths(output: string | null): ReadonlySet<string> | null {
  if (output === null) return null;
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function isFailClosed(host: HookHost): boolean {
  return FAIL_CLOSED_HOOK_HOSTS.includes(host);
}

function recoveryHosts(failClosed: readonly HookRegistrationRef[]): string {
  const hosts = [...new Set(failClosed.map((entry) => entry.host))];
  return hosts
    .map((host) => `\`${disableHostHooksInvocation(` --host ${host} --confirm`)}\``)
    .join(" / ");
}

function buildWarning(
  traveling: readonly HookRegistrationRef[],
  failClosed: readonly HookRegistrationRef[],
): string {
  const listed = traveling
    .map((entry) => `${entry.path}${isFailClosed(entry.host) ? " (fail-closed)" : ""}`)
    .join(", ");
  const lines = [
    `\u26a0 Hook registration travels without its runtime (#3785): ${listed}`,
    `  No ${RUNTIME_ANCHOR_MANIFEST} dependency on ${PIN_DEPENDENCY_NAME} travels with this tree, so a fresh`,
    "  clone, CI runner, or container cannot obtain the `deft-hook` command these files name.",
  ];
  if (failClosed.length > 0) {
    lines.push(
      "  Fail-closed hosts then deny every mutation on an opaque exit 127, and no Directive",
      "  code runs to say why. There is no in-session recovery on a host without Node.",
    );
  }
  lines.push(
    `  Fix: commit a ${RUNTIME_ANCHOR_MANIFEST} dependency on ${PIN_DEPENDENCY_NAME} so the runtime travels too.`,
  );
  if (failClosed.length > 0) {
    lines.push(`  Or, accepting the capability cost: ${recoveryHosts(failClosed)}.`);
  }
  lines.push(
    "  \u2297 Do not hand-edit `failClosed` in the deposited file -- the next `deft update` restores it.",
    "  Detail: .deft/core/docs/hook-runtime-unavailable.md",
  );
  return lines.join("\n");
}

/**
 * Report whether any enabled agent-hook registration travels with this tree
 * while no manifest travelling alongside it lets a clone install the runtime it
 * names.
 *
 * Disabled hosts are excluded: their registration is stripped, so a leftover
 * copy cannot deny anything.
 */
export function inspectHookRuntimeTravel(
  projectRoot: string,
  registrations: readonly HookRegistrationRef[],
  hostHooksPolicy: HostHooksPolicy,
  seams: HookRuntimeTravelSeams = {},
): HookRuntimeTravelResult {
  const enabled = registrations.filter((entry) =>
    isHostHookDepositEnabled(entry.host, hostHooksPolicy),
  );
  const probePaths = [...enabled.map((entry) => entry.path), RUNTIME_ANCHOR_MANIFEST];
  const gitLsFiles = seams.gitLsFiles ?? defaultGitLsFiles;
  const traveling = travelingPaths(gitLsFiles(projectRoot, probePaths));
  if (traveling === null) {
    return {
      travelingRegistrations: [],
      failClosedRegistrations: [],
      runtimeTravels: false,
      warning: null,
    };
  }

  const pin = (seams.readPin ?? readPin)(projectRoot);
  // A range spec reconstitutes as well as an exact pin for this purpose: either
  // way `npm install` resolves the runtime. The manifest must travel too,
  // otherwise the declaration never reaches the clone that needs it.
  const runtimeTravels = pin.rawSpec !== null && traveling.has(RUNTIME_ANCHOR_MANIFEST);

  const travelingRegistrations = enabled.filter((entry) => traveling.has(entry.path));
  const failClosedRegistrations = travelingRegistrations.filter((entry) =>
    isFailClosed(entry.host),
  );
  const unsafe = travelingRegistrations.length > 0 && !runtimeTravels;
  return {
    travelingRegistrations: travelingRegistrations.map((entry) => entry.path),
    failClosedRegistrations: failClosedRegistrations.map((entry) => entry.path),
    runtimeTravels,
    warning: unsafe ? buildWarning(travelingRegistrations, failClosedRegistrations) : null,
  };
}
