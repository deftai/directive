/**
 * Hook-runtime travel warning (#3785).
 *
 * Directive keeps the agent-hook registration files trackable by design and
 * born-ignores the deposit that implements them. When a registration is
 * git-tracked and nothing in the tree lets a clone obtain `deft-hook`, the
 * registration travels and the runtime does not. A fresh clone, CI runner, or
 * container without a global install then fail-closes every mutation on an
 * opaque exit 127, and no Directive code runs to explain it.
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
  /** Enabled registrations git-tracked in this repository. */
  readonly trackedRegistrations: readonly string[];
  /** Subset of {@link trackedRegistrations} deposited fail-closed. */
  readonly failClosedRegistrations: readonly string[];
  /** A committed manifest declares `@deftai/directive`, so a clone can install it. */
  readonly runtimeTravels: boolean;
  /** Null when the pairing is safe or git could not answer. */
  readonly warning: string | null;
}

function defaultGitLsFiles(projectDir: string, paths: readonly string[]): string | null {
  // `.git` is a directory in a clone and a file in a linked worktree. Absent
  // means the deposit root is not a repository root, so tracked-ness has no
  // answer worth reporting -- and the probe costs nothing.
  if (!existsSync(join(projectDir, ".git"))) return null;
  try {
    return execFileSync("git", ["ls-files", "--", ...paths], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // CREATE_NO_WINDOW on win32; harmless elsewhere (#2563).
      windowsHide: true,
    });
  } catch {
    // git absent, or not a repository: the tracked/untracked question has no
    // answer here, so the caller stays silent rather than guessing.
    return null;
  }
}

/** Tracked paths as reported by git, or null when git could not answer. */
function trackedPaths(output: string | null): ReadonlySet<string> | null {
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
  tracked: readonly HookRegistrationRef[],
  failClosed: readonly HookRegistrationRef[],
): string {
  const listed = tracked
    .map((entry) => `${entry.path}${isFailClosed(entry.host) ? " (fail-closed)" : ""}`)
    .join(", ");
  const lines = [
    `\u26a0 Hook registration travels without its runtime (#3785): ${listed}`,
    `  No committed ${RUNTIME_ANCHOR_MANIFEST} dependency on ${PIN_DEPENDENCY_NAME}, so a fresh clone,`,
    "  CI runner, or container cannot obtain the `deft-hook` command these files name.",
  ];
  if (failClosed.length > 0) {
    lines.push(
      "  Fail-closed hosts then deny every mutation on an opaque exit 127, and no Directive",
      "  code runs to say why. There is no in-session recovery on a host without Node.",
    );
  }
  lines.push(
    `  Fix: commit a ${RUNTIME_ANCHOR_MANIFEST} dependency on ${PIN_DEPENDENCY_NAME} so the runtime travels with the tree.`,
  );
  if (failClosed.length > 0) {
    lines.push(`  Unused host: ${recoveryHosts(failClosed)}.`);
  }
  lines.push(
    "  \u2297 Do not hand-edit `failClosed` in the deposited file -- the next `deft update` restores it.",
    "  Detail: .deft/core/docs/hook-runtime-unavailable.md",
  );
  return lines.join("\n");
}

/**
 * Report whether any enabled agent-hook registration is git-tracked while no
 * committed manifest lets a clone install the runtime it names.
 *
 * Disabled hosts are excluded: their registration is stripped, so a tracked
 * leftover cannot deny anything.
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
  const tracked = trackedPaths(gitLsFiles(projectRoot, probePaths));
  if (tracked === null) {
    return {
      trackedRegistrations: [],
      failClosedRegistrations: [],
      runtimeTravels: false,
      warning: null,
    };
  }

  const pin = (seams.readPin ?? readPin)(projectRoot);
  // A range spec reconstitutes as well as an exact pin for this purpose: either
  // way `npm install` resolves the runtime. The manifest itself must be tracked,
  // otherwise the declaration does not travel either.
  const runtimeTravels = pin.rawSpec !== null && tracked.has(RUNTIME_ANCHOR_MANIFEST);

  const trackedRegistrations = enabled.filter((entry) => tracked.has(entry.path));
  const failClosedRegistrations = trackedRegistrations.filter((entry) => isFailClosed(entry.host));
  const unsafe = trackedRegistrations.length > 0 && !runtimeTravels;
  return {
    trackedRegistrations: trackedRegistrations.map((entry) => entry.path),
    failClosedRegistrations: failClosedRegistrations.map((entry) => entry.path),
    runtimeTravels,
    warning: unsafe ? buildWarning(trackedRegistrations, failClosedRegistrations) : null,
  };
}
