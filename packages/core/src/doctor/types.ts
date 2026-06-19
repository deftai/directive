export const EXIT_CLEAN = 0;
export const EXIT_DRIFT = 1;
export const EXIT_CONFIG_ERROR = 2;

export type CheckStatus = "pass" | "fail" | "skip" | "error";

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface DoctorResult {
  readonly projectRoot: string;
  readonly installRoot: string | null;
  readonly exitCode: number;
  readonly checks: readonly CheckResult[];
  readonly errors: readonly string[];
}

export interface Finding {
  readonly severity: "error" | "warning" | "skip";
  readonly message: string;
  readonly check?: string;
  readonly tool?: string;
  readonly suggestion?: string | null;
  readonly status?: string;
  readonly [key: string]: unknown;
}

export interface DoctorFlags {
  readonly session: boolean;
  readonly fix: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly full: boolean;
  readonly help: boolean;
  readonly projectRoot: string | null;
  readonly unknown: readonly string[];
}

export interface ThrottleDecision {
  readonly skip: boolean;
  readonly dirty: boolean;
  readonly lastRunAt: Date | null;
  readonly lastExitCode: number;
  readonly lastFindingCount: number;
  readonly lastErrorCount: number;
  readonly nextEligibleAt: Date | null;
  readonly ageHours: number;
}

export interface DoctorState {
  readonly lastRunAt: Date;
  readonly lastExitCode: number;
  readonly lastFindingCount: number;
  readonly lastErrorCount: number;
}

export interface DoctorSeams {
  readonly whichFn?: (cmd: string) => string | null;
  readonly frameworkRoot?: string;
  readonly readText?: (path: string) => string | null;
  readonly isDir?: (path: string) => boolean;
  readonly isFile?: (path: string) => boolean;
  readonly runGitLsRemote?: (deftDir: string, ref: string) => { ok: boolean; stdout: string };
  readonly agentsRefreshPlan?: (projectRoot: string) => Record<string, unknown>;
  readonly readState?: (projectRoot: string) => DoctorState | null;
  readonly writeState?: (
    projectRoot: string,
    payload: {
      exitCode: number;
      findingCount: number;
      errorCount: number;
      now?: Date;
    },
  ) => string | null;
  readonly isTty?: () => boolean;
  readonly readYn?: (prompt: string, defaultYes: boolean) => boolean;
  readonly writeText?: (path: string, content: string) => void;
  readonly now?: () => Date;
}
