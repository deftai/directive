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
 * host. The anchor is read from the commit, not from the working tree or the
 * index: a consumer can commit the generated registration and leave the
 * manifest merely present, staged, or edited, and that is the case that strands
 * the clone.
 *
 * Warn-only. Refusing `deft init` / `deft update` on this condition would be
 * the same lockout from the other side, so the deposit still writes and
 * reports. Absence of the runtime stays a deny — fail-open-on-absence was
 * refuted as unimplementable and as a bypass primitive (#3156).
 *
 * Refs #3785, #3736, #3571, #2752, #2264, #3156.
 */

import { execFileSync } from "node:child_process";
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

/**
 * Spec prefixes that name a location instead of a release. Each resolves
 * against something outside the tree -- a path, a symlink target, a workspace
 * member -- so the clone that receives the registration cannot install from it.
 */
export const LOCATION_SPEC_PREFIXES = [
  "file:",
  "link:",
  "portal:",
  "workspace:",
  "git+file:",
] as const;

/** Prefixes any clone can fetch: a registry alias or a remote repository. */
const REMOTE_SPEC_PREFIXES = [
  "npm:",
  "http:",
  "https:",
  "git:",
  "git+http:",
  "git+https:",
  "git+ssh:",
  "github:",
  "gitlab:",
  "bitbucket:",
] as const;

/**
 * Whether a clone could install `deft-hook` from this spec.
 *
 * Allowlist, not denylist. Location forms are open-ended -- `file:`,
 * `git+file:`, `../directive`, `/opt/directive`, `C:\src\directive`, `~/dev` --
 * so enumerating them leaves the next shape uncovered, and an uncovered shape
 * silences the warning. Anything that is not recognisably a registry release or
 * a fetchable remote is therefore treated as not travelling. A bare
 * `owner/repo` shorthand is refused on the same rule: it warns where the
 * runtime might in fact arrive, which is the harmless direction for a
 * warn-only probe.
 */
function reconstitutesForAClone(rawSpec: string): boolean {
  const spec = rawSpec.trim();
  if (spec.length === 0) return false;
  const lower = spec.toLowerCase();
  if (LOCATION_SPEC_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  if (REMOTE_SPEC_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  // Bare paths: relative, home-anchored, POSIX-absolute, or a Windows drive.
  if (/^[.~/\\]/.test(spec) || /^[a-z]:[\\/]/i.test(spec)) return false;
  // Anything else with a separator is a path or a repository shorthand, not a
  // version, a range, or a dist-tag.
  return !(spec.includes("/") || spec.includes("\\"));
}

export type GitLsFilesProbe = (projectDir: string, paths: readonly string[]) => string | null;

/** Contents of a path as committed at `HEAD`, or null when there is none. */
export type CommittedFileProbe = (projectDir: string, path: string) => string | null;

export interface HookRuntimeTravelSeams {
  readonly gitLsFiles?: GitLsFilesProbe;
  readonly readCommittedFile?: CommittedFileProbe;
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
  try {
    // Ask git rather than looking for `.git`: a project deposited into a
    // subdirectory of a repository has no `.git` of its own, yet its
    // registration is trackable by the parent. `ls-files` answers from any
    // depth, relative to this directory, and declines outside a repository.
    //
    // `--cached` reports what is in the index, `--others --exclude-standard`
    // what a first `deft init` just wrote and the next `git add` would sweep
    // in; ignored paths are omitted, since they cannot reach a clone.
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

function defaultReadCommittedFile(projectDir: string, path: string): string | null {
  try {
    // `HEAD:./<path>` resolves relative to this directory, so a project nested
    // in a repository reads its own manifest rather than the parent's.
    return execFileSync("git", ["show", `HEAD:./${path}`], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    // No commit, no such path in it, or no repository: nothing is committed
    // here that a clone would receive.
    return null;
  }
}

/** The `@deftai/directive` spec as committed, or null when none is. */
function committedRuntimeSpec(manifest: string | null): string | null {
  if (manifest === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pkg = parsed as Record<string, unknown>;
  for (const block of ["devDependencies", "dependencies"] as const) {
    const deps = pkg[block];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) continue;
    const spec = (deps as Record<string, unknown>)[PIN_DEPENDENCY_NAME];
    if (typeof spec === "string" && spec.trim().length > 0) return spec.trim();
  }
  return null;
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

/** Whether the runtime travels with the registration, and if not, why not. */
type AnchorState =
  /** A commit declares an installable `@deftai/directive`. */
  | { readonly kind: "travels" }
  /** No declaration on `@deftai/directive` anywhere. */
  | { readonly kind: "absent" }
  /** Declared in the working tree or the index, but not in any commit. */
  | { readonly kind: "uncommitted" }
  /** Committed, but pinned to something a clone cannot install from. */
  | { readonly kind: "non-portable"; readonly spec: string };

function causeLine(anchor: AnchorState): string {
  if (anchor.kind === "uncommitted") {
    return `  ${RUNTIME_ANCHOR_MANIFEST} declares ${PIN_DEPENDENCY_NAME} but is not committed, so a fresh`;
  }
  if (anchor.kind === "non-portable") {
    return `  ${RUNTIME_ANCHOR_MANIFEST} pins ${PIN_DEPENDENCY_NAME} to \`${anchor.spec}\`, which no clone can install, so a fresh`;
  }
  return `  No ${RUNTIME_ANCHOR_MANIFEST} dependency on ${PIN_DEPENDENCY_NAME} travels with this tree, so a fresh`;
}

function fixLine(anchor: AnchorState): string {
  if (anchor.kind === "uncommitted") {
    return `  Fix: commit ${RUNTIME_ANCHOR_MANIFEST} so the runtime travels with the registration.`;
  }
  if (anchor.kind === "non-portable") {
    return `  Fix: pin ${PIN_DEPENDENCY_NAME} to a published version so a clone can install it.`;
  }
  return `  Fix: commit a ${RUNTIME_ANCHOR_MANIFEST} dependency on ${PIN_DEPENDENCY_NAME} so the runtime travels too.`;
}

/**
 * Judge the anchor from the commit, not the working tree or the index.
 *
 * A clone receives commits. A manifest that is merely present, merely staged,
 * or edited-but-uncommitted declares the runtime to this machine only, and the
 * consumer is free to commit the generated registration without it.
 */
function resolveAnchorState(committedSpec: string | null, workingSpec: string | null): AnchorState {
  if (committedSpec === null) {
    return workingSpec === null ? { kind: "absent" } : { kind: "uncommitted" };
  }
  if (!reconstitutesForAClone(committedSpec)) {
    return { kind: "non-portable", spec: committedSpec };
  }
  return { kind: "travels" };
}

function buildWarning(
  traveling: readonly HookRegistrationRef[],
  failClosed: readonly HookRegistrationRef[],
  anchor: AnchorState,
): string {
  const listed = traveling
    .map((entry) => `${entry.path}${isFailClosed(entry.host) ? " (fail-closed)" : ""}`)
    .join(", ");
  const cause = causeLine(anchor);
  const lines = [
    `\u26a0 Hook registration travels without its runtime (#3785): ${listed}`,
    cause,
    "  clone, CI runner, or container cannot obtain the `deft-hook` command these files name.",
  ];
  if (failClosed.length > 0) {
    lines.push(
      "  Fail-closed hosts then deny every mutation on an opaque exit 127, and no Directive",
      "  code runs to say why. There is no in-session recovery on a host without Node.",
    );
  }
  lines.push(fixLine(anchor));
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

  // The two sides are judged asymmetrically, deliberately. A registration is
  // dangerous as soon as it is trackable: one `git add` sends it to every
  // clone. An anchor counts only once a commit carries it, because a clone
  // receives commits -- present, staged, and edited-but-uncommitted manifests
  // all declare the runtime to this machine alone.
  const readCommittedFile = seams.readCommittedFile ?? defaultReadCommittedFile;
  const committedSpec = committedRuntimeSpec(
    readCommittedFile(projectRoot, RUNTIME_ANCHOR_MANIFEST),
  );
  const anchor = resolveAnchorState(committedSpec, (seams.readPin ?? readPin)(projectRoot).rawSpec);
  const runtimeTravels = anchor.kind === "travels";

  const travelingRegistrations = enabled.filter((entry) => traveling.has(entry.path));
  const failClosedRegistrations = travelingRegistrations.filter((entry) =>
    isFailClosed(entry.host),
  );
  const unsafe = travelingRegistrations.length > 0 && !runtimeTravels;
  return {
    travelingRegistrations: travelingRegistrations.map((entry) => entry.path),
    failClosedRegistrations: failClosedRegistrations.map((entry) => entry.path),
    runtimeTravels,
    warning: unsafe ? buildWarning(travelingRegistrations, failClosedRegistrations, anchor) : null,
  };
}
