/**
 * Wave 2d self-completing setup (AC8.6 / AC2.5); Wave 2q AC14.20 rebuild.
 *
 * On an eligible ordinary runtime command or registered hook, when the ignored
 * wiring-ready.<V>.json marker is missing/stale, or GENERATION is missing on a
 * configured project (pin + wiring), run the same setup entry as repair (no
 * seeds, pin unchanged). Doctor and its children suppress via
 * DEFT_DOCTOR_HOOK_DIAGNOSTIC. release:run children suppress via
 * DEFT_SKIP_SELF_COMPLETE (#7327). Cheap fast path when readiness + GENERATION
 * are already valid.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCheapInSync } from "@deftai/directive-core/dist/install-health/cheap.js";
import { DEFT_DOCTOR_HOOK_DIAGNOSTIC as DOCTOR_DIAGNOSTIC_ENV } from "@deftai/directive-core/dist/install-health/constants.js";
import { GENERATION_REL } from "@deftai/directive-core/dist/install-health/ownership.js";
import { readRuntimePin } from "@deftai/directive-core/dist/install-health/readers.js";
import { hasDirectiveWiringEvidence } from "@deftai/directive-core/dist/install-health/wiring.js";
import { runSetup, type SetupResult } from "./setup.js";

/**
 * When set (non-empty, not "0"/"false"), hooks and helpers must not run
 * automatic setup or write readiness / Git config (AC9.10 / AC8.6).
 * Doctor sets this before spawning committed hook probes.
 */
export const DEFT_DOCTOR_HOOK_DIAGNOSTIC = DOCTOR_DIAGNOSTIC_ENV;

/**
 * When set (non-empty, not "0"/"false"/"no"), skip self-complete for this
 * process. release:run stamps this on every child verb so setupRitual's
 * session:start (and hooks it fires) cannot recreate GENERATION / wiring on a
 * tip pin+wiring tree and fail the cut's allowDirty=false gate (#7327).
 * Must match packages/core/src/release/run.ts.
 */
export const DEFT_SKIP_SELF_COMPLETE = "DEFT_SKIP_SELF_COMPLETE";

/** Process once-guard for git-hook update stderr lines (#5885 / D-023). */
const emittedGitHookLines = new Set<string>();

/** Test-only: clear the process once-guard for git-hook update lines. */
export function resetSelfCompleteGitHookDisclosureForTests(): void {
  emittedGitHookLines.clear();
}

/**
 * Automatic setup needs no approval, so it names each git hook it replaced
 * (D-023) and each file it kept, once per process.
 */
function discloseOnce(
  lines: readonly string[] | undefined,
  writeErr: (text: string) => void,
): void {
  if (lines === undefined || lines.length === 0) return;
  for (const line of lines) {
    if (emittedGitHookLines.has(line)) continue;
    emittedGitHookLines.add(line);
    writeErr(`${line}\n`);
  }
}

/** Installation-management and help heads that never trigger self-complete. */
const INELIGIBLE_HEADS = new Set([
  "install",
  "upgrade",
  "uninstall",
  "doctor",
  "init",
  "update",
  "remove",
  "setup",
  "migrate",
  "help",
  // #7327 Prefer-A: release:run readiness requires a clean tree at entry.
  // Self-complete (runSetup) writes GENERATION / .gitignore / .deft/directive
  // and would fail that check on a tip cut worktree that has pin+wiring only.
  "release:run",
  "release-run",
  "--version",
  "--help",
  "-h",
  "-V",
]);

export type SelfCompleteSkipReason =
  | "fast-path"
  | "doctor-diagnostic"
  | "skip-self-complete"
  | "ineligible"
  | "not-configured"
  | "fail-closed"
  | "no-version";

export interface SelfCompleteResult {
  readonly ran: boolean;
  readonly skipReason: SelfCompleteSkipReason | null;
  readonly setup: SetupResult | null;
}

function isTruthySkipEnv(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const lower = value.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no";
}

export function isDoctorDiagnosticEnv(environ: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthySkipEnv(environ[DEFT_DOCTOR_HOOK_DIAGNOSTIC]);
}

/** True when release:run (or a test) asked this process to skip self-complete (#7327). */
export function isSkipSelfCompleteEnv(environ: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthySkipEnv(environ[DEFT_SKIP_SELF_COMPLETE]);
}

/** True for ordinary product argv that may self-complete (AC8.6). */
export function isEligibleSelfCompleteCommand(argv: readonly string[]): boolean {
  const head = argv[0];
  if (head === undefined) return false;
  if (INELIGIBLE_HEADS.has(head)) return false;
  // #7327: router accepts space-form `release run` before self-complete; raw
  // head is `release`, which is not in INELIGIBLE_HEADS. Match the two-word
  // spelling so tip cuts stay tree-clean at readiness (same as release:run).
  if (head === "release" && argv[1] === "run") return false;
  return true;
}

function readOwnRuntimeVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Check readiness + cheap evidence; run repair-equivalent setup when missing/stale.
 * No-op when doctor diagnostic, ineligible command, never-configured, or fail-closed.
 * AC14.20: GENERATION missing with pin+wiring still rebuilds (not AC14.50).
 */
export function maybeSelfCompleteSetup(
  projectRoot: string,
  options: {
    readonly argv?: readonly string[];
    readonly environ?: NodeJS.ProcessEnv;
    /** Hooks are always eligible unless doctor-diagnostic. */
    readonly fromHook?: boolean;
    /** Stderr sink for preserved tracked-hook disclosure (#5885); never stdout. */
    readonly writeErr?: (text: string) => void;
  } = {},
): SelfCompleteResult {
  const environ = options.environ ?? process.env;
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));
  if (isDoctorDiagnosticEnv(environ)) {
    return { ran: false, skipReason: "doctor-diagnostic", setup: null };
  }
  // #7327: covers session:start / hooks under release:run (fromHook bypasses argv).
  if (isSkipSelfCompleteEnv(environ)) {
    return { ran: false, skipReason: "skip-self-complete", setup: null };
  }

  if (!options.fromHook) {
    const argv = options.argv ?? [];
    if (!isEligibleSelfCompleteCommand(argv)) {
      return { ran: false, skipReason: "ineligible", setup: null };
    }
  }

  const generationPresent = existsSync(join(projectRoot, GENERATION_REL));
  // AC14.50: never-configured (no GENERATION, and no pin+wiring) do not auto-activate.
  // AC14.20: configured project with GENERATION deleted must rebuild.
  if (!generationPresent) {
    const pin = readRuntimePin(projectRoot);
    const configured = pin.pinVersion !== null && hasDirectiveWiringEvidence(projectRoot);
    if (!configured) {
      return { ran: false, skipReason: "not-configured", setup: null };
    }
  }

  const cheap = checkCheapInSync(projectRoot);
  if (cheap.failClosed) {
    return { ran: false, skipReason: "fail-closed", setup: null };
  }
  // Fast path only when GENERATION is present and cheap identity+readiness hold.
  if (generationPresent && cheap.ok) {
    return { ran: false, skipReason: "fast-path", setup: null };
  }

  const version = cheap.installedVersion ?? cheap.pinVersion ?? readOwnRuntimeVersion();
  if (version === null) {
    return { ran: false, skipReason: "no-version", setup: null };
  }

  // Same entry as setup install/repair obligations; repair → no seeds (AC8.4 / AC8.6).
  const setup = runSetup({
    operation: "repair",
    from: version,
    root: projectRoot,
  });
  discloseOnce(setup.gitHookUpdates, writeErr);
  // Kept files (e.g. a user-edited retired core-guard workflow, #5835).
  discloseOnce(setup.preserved, writeErr);
  // #4960 / #5846: another core.hooksPath keeps Git hooks inactive; automatic
  // setup never takes it over, so name the fix (once per process).
  if (setup.gitHooksInactive?.includes("core.hooksPath is ")) {
    discloseOnce([setup.gitHooksInactive], writeErr);
  }
  return { ran: true, skipReason: null, setup };
}
