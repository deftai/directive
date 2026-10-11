/**
 * Wave 2d self-completing setup (AC8.6 / AC2.5).
 *
 * On an eligible ordinary runtime command or registered hook, when the ignored
 * wiring-ready.<V>.json marker is missing/stale, run the same setup entry as
 * repair (no seeds, pin unchanged). Doctor and its children suppress via
 * DEFT_DOCTOR_HOOK_DIAGNOSTIC. Cheap fast path when readiness is already valid.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCheapInSync } from "@deftai/directive-core/dist/install-health/cheap.js";
import { DEFT_DOCTOR_HOOK_DIAGNOSTIC as DOCTOR_DIAGNOSTIC_ENV } from "@deftai/directive-core/dist/install-health/constants.js";
import { GENERATION_REL } from "@deftai/directive-core/dist/install-health/ownership.js";
import { runSetup, type SetupResult } from "./setup.js";

/**
 * When set (non-empty, not "0"/"false"), hooks and helpers must not run
 * automatic setup or write readiness / Git config (AC9.10 / AC8.6).
 * Doctor sets this before spawning committed hook probes.
 */
export const DEFT_DOCTOR_HOOK_DIAGNOSTIC = DOCTOR_DIAGNOSTIC_ENV;

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
  "--version",
  "--help",
  "-h",
  "-V",
]);

export type SelfCompleteSkipReason =
  | "fast-path"
  | "doctor-diagnostic"
  | "ineligible"
  | "not-configured"
  | "fail-closed"
  | "no-version";

export interface SelfCompleteResult {
  readonly ran: boolean;
  readonly skipReason: SelfCompleteSkipReason | null;
  readonly setup: SetupResult | null;
}

export function isDoctorDiagnosticEnv(
  environ: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = environ[DEFT_DOCTOR_HOOK_DIAGNOSTIC];
  if (v === undefined || v === "") return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no";
}

/** True for ordinary product argv that may self-complete (AC8.6). */
export function isEligibleSelfCompleteCommand(argv: readonly string[]): boolean {
  const head = argv[0];
  if (head === undefined) return false;
  if (INELIGIBLE_HEADS.has(head)) return false;
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
 */
export function maybeSelfCompleteSetup(
  projectRoot: string,
  options: {
    readonly argv?: readonly string[];
    readonly environ?: NodeJS.ProcessEnv;
    /** Hooks are always eligible unless doctor-diagnostic. */
    readonly fromHook?: boolean;
  } = {},
): SelfCompleteResult {
  const environ = options.environ ?? process.env;
  if (isDoctorDiagnosticEnv(environ)) {
    return { ran: false, skipReason: "doctor-diagnostic", setup: null };
  }

  if (!options.fromHook) {
    const argv = options.argv ?? [];
    if (!isEligibleSelfCompleteCommand(argv)) {
      return { ran: false, skipReason: "ineligible", setup: null };
    }
  }

  // AC14.50: never-configured projects (no GENERATION) do not auto-activate.
  if (!existsSync(join(projectRoot, GENERATION_REL))) {
    return { ran: false, skipReason: "not-configured", setup: null };
  }

  const cheap = checkCheapInSync(projectRoot);
  if (cheap.failClosed) {
    return { ran: false, skipReason: "fail-closed", setup: null };
  }
  if (cheap.ok) {
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
  return { ran: true, skipReason: null, setup };
}
