/**
 * Launcher–runtime Contract 1 constants (UNIFIED §A5.5 / R4 / AC4.*, #5490).
 */
import type { DataStatusValue, EntryPointSpec, SetupOperation } from "./types.js";

/** Contract 1 integer carried on runtime package.json as `directive.contract`. */
export const CONTRACT_NUMBER = 1 as const;

/** package.json key holding `{ contract: number }` on the runtime package. */
export const CONTRACT_PACKAGE_JSON_KEY = "directive" as const;

/**
 * Highest contract this launcher codebase speaks.
 * For Contract 1 draft, equals CONTRACT_NUMBER (AC4.6).
 */
export const LAUNCHER_MAX_SUPPORTED_CONTRACT = CONTRACT_NUMBER;

/** Exit codes everywhere — launcher and runtime (AC4.5 / INIT-23). */
export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const SETUP_OPERATIONS: readonly SetupOperation[] = ["install", "repair", "upgrade"];

/** Documented special `--from` tokens; exact version strings are also valid. */
export const SETUP_FROM_VALUES: readonly string[] = ["none", "old-style"];

export const DataStatus = {
  Current: "current",
  MigrationNeeded: "migration_needed",
  DiagnosisFailed: "diagnosis_failed",
} as const satisfies Record<string, DataStatusValue>;

export const DATA_STATUS_VALUES: readonly DataStatusValue[] = [
  DataStatus.Current,
  DataStatus.MigrationNeeded,
  DataStatus.DiagnosisFailed,
];

/** Contract 1 entry points beyond ordinary pass-through (AC4.3). */
export const ENTRY_POINTS: readonly EntryPointSpec[] = [
  {
    name: "setup",
    argv: [
      "setup",
      "--operation",
      "<install|repair|upgrade>",
      "--from",
      "<version|old-style|none>",
      "--root",
      "<path>",
    ],
  },
  {
    name: "migrate",
    argv: ["migrate", "--from", "<version>", "--root", "<path>"],
  },
  {
    name: "uninstall",
    argv: ["uninstall", "--root", "<path>"],
  },
  {
    name: "doctor",
    argv: ["doctor"],
  },
];
