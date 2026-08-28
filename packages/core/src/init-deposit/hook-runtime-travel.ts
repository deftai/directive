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
 * host. The anchor must be committed, not merely present: a consumer can commit
 * the generated registration and leave `package.json` behind, and that is the
 * case that strands the clone.
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
 * Spec prefixes that name a location instead of a published release. Each one
 * resolves against something outside the tree -- a path, a symlink target, a
 * workspace member -- so the clone that receives the registration cannot
 * install from it.
 */
export const NON_PORTABLE_SPEC_PREFIXES = ["file:", "link:", "portal:", "workspace:"] as const;

function reconstitutesFromRegistry(rawSpec: string): boolean {
  const spec = rawSpec.trim().toLowerCase();
  return !NON_PORTABLE_SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

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
  try {
    // Ask git rather than looking for `.git`: a project deposited into a
    // subdirectory of a repository has no `.git` of its own, yet its
    // registration is trackable by the parent. `ls-files` answers from any
    // depth, relative to this directory, and declines outside a repository.
    //
    // `--cached` reports what is in the index, `--others --exclude-standard`
    // what a first `deft init` just wrote and the next `git add` would sweep
    // in; ignored paths are omitted, since they cannot reach a clone. `-t` tags
    // the two apart as `H` and `?`.
    return execFileSync(
      "git",
      ["ls-files", "-t", "--cached", "--others", "--exclude-standard", "--", ...paths],
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

interface TravelReport {
  /** Paths in the index: committed, or staged for the next commit. */
  readonly tracked: ReadonlySet<string>;
  /** Paths present and not ignored: the next `git add` sweeps them in. */
  readonly untracked: ReadonlySet<string>;
}

/** Split `git ls-files -t` output by tag, or null when git could not answer. */
function travelReport(output: string | null): TravelReport | null {
  if (output === null) return null;
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line.length < 3) continue;
    const path = line.slice(2).trim();
    if (path.length === 0) continue;
    if (line.startsWith("? ")) untracked.add(path);
    else tracked.add(path);
  }
  return { tracked, untracked };
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

/** Why the runtime does not travel with the registration. */
type AnchorState =
  /** No declaration on `@deftai/directive` at all. */
  | { readonly kind: "absent" }
  /** Declared, but the manifest is not in the index. */
  | { readonly kind: "uncommitted" }
  /** Declared and committed, but pinned to something only this machine has. */
  | { readonly kind: "non-portable"; readonly spec: string };

function causeLine(anchor: AnchorState): string {
  if (anchor.kind === "uncommitted") {
    return `  ${RUNTIME_ANCHOR_MANIFEST} declares ${PIN_DEPENDENCY_NAME} but is not committed, so a fresh`;
  }
  if (anchor.kind === "non-portable") {
    return `  ${RUNTIME_ANCHOR_MANIFEST} pins ${PIN_DEPENDENCY_NAME} to \`${anchor.spec}\`, which resolves only here, so a fresh`;
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

function resolveAnchorState(
  spec: string | null,
  portable: boolean,
  report: TravelReport,
): AnchorState {
  if (spec === null) return { kind: "absent" };
  // A location spec never anchors, committed or not: naming where the runtime
  // lives on this machine tells a clone nothing it can install from.
  if (!portable) return { kind: "non-portable", spec };
  if (report.untracked.has(RUNTIME_ANCHOR_MANIFEST)) return { kind: "uncommitted" };
  return { kind: "absent" };
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
  const report = travelReport(gitLsFiles(projectRoot, probePaths));
  if (report === null) {
    return {
      travelingRegistrations: [],
      failClosedRegistrations: [],
      runtimeTravels: false,
      warning: null,
    };
  }

  const pin = (seams.readPin ?? readPin)(projectRoot);
  // The two sides are judged asymmetrically, deliberately. A registration is
  // dangerous as soon as it is trackable: one `git add` sends it to every
  // clone. An anchor only helps once it is in the index, because a consumer is
  // free to commit the generated registration and leave `package.json` behind
  // -- crediting an uncommitted manifest would silence the warning in exactly
  // that case. A range spec reconstitutes as well as an exact pin: either way
  // `npm install` resolves the runtime. A location spec does not reconstitute
  // at all, so it is not an anchor even when committed.
  const spec = pin.rawSpec;
  const portable = spec !== null && reconstitutesFromRegistry(spec);
  const runtimeTravels = portable && report.tracked.has(RUNTIME_ANCHOR_MANIFEST);
  const anchor = resolveAnchorState(spec, portable, report);

  const travels = (path: string): boolean => report.tracked.has(path) || report.untracked.has(path);
  const travelingRegistrations = enabled.filter((entry) => travels(entry.path));
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
