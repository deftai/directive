/**
 * Literal acceptance-command verification (#3267).
 *
 * Capture exact stated shell commands from the task statement at intake;
 * run them verbatim before done. Self-chosen verification is supplementary.
 * Extends #973 machine-verifiable-spec. Survives ceremony dial rapid/minimal
 * (#3214) — verification depth is constant (#3156).
 */

/** Where a literal command was recovered from. */
export type LiteralAcceptanceSource =
  | "task_statement"
  | "verify_commands"
  | "plan_item"
  | "explicit"
  | "metadata";

/**
 * Sources trusted for automatic shell execution (#3267 Greptile P1).
 * `task_statement` (raw issue/task text) is capture-only until an agent promotes
 * the exact command into swarm.verify_commands / plan item / explicit metadata.
 */
export const EXECUTABLE_LITERAL_SOURCES: readonly LiteralAcceptanceSource[] = [
  "verify_commands",
  "plan_item",
  "explicit",
  "metadata",
];

/**
 * One executable acceptance command exactly as stated (no paraphrase).
 * `command` is the shell string to run with the same flags/cwd as written.
 */
export interface LiteralAcceptanceCommand {
  /** Exact command string from the task statement (not reworded). */
  readonly command: string;
  /**
   * Working directory relative to project root when stated; null/omit = project root.
   * Absolute paths are allowed when the statement uses them.
   */
  readonly cwd?: string | null;
  /** Expected stdout substring when the statement names expected output. */
  readonly expectedStdout?: string | null;
  /** Expected process exit code (default 0). */
  readonly expectedExitCode?: number;
  readonly source: LiteralAcceptanceSource;
  /** Short provenance (heading, field path, or line context). */
  readonly sourceSpan?: string | null;
}

/** Result of running one stored command. */
export interface LiteralAcceptanceRunResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Shell-shaped command that was refused by the safety allowlist (#3267 residual).
 * Operators must see these — silent drop hides ambient-authority / shape mistakes.
 */
export interface RejectedLiteralCommand {
  readonly command: string;
  readonly reason: string;
  readonly sourceSpan?: string | null;
}

/** Aggregate evaluate / done-gate result. */
export interface LiteralAcceptanceGateResult {
  readonly ok: boolean;
  /** 0 = pass or no commands; 1 = command failed; 2 = config / input error. */
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly commands: readonly LiteralAcceptanceCommand[];
  readonly runs: readonly LiteralAcceptanceRunResult[];
  /** Safety-rejected shell-shaped lines (fail-loud ledger; may be empty). */
  readonly rejected?: readonly RejectedLiteralCommand[];
  /**
   * Prose/fence/inline-derived rejections demoted to advisory (#3484 / #3511).
   * Reported, never blocking — consumers MUST NOT read these back as a blocking
   * ledger, and must not sniff the rendered message for their reasons (#3497).
   */
  readonly advisoryRejected?: readonly RejectedLiteralCommand[];
}

/** Metadata key for operator-visible rejected command ledger (#3267). */
export const LITERAL_ACCEPTANCE_REJECTED_METADATA_KEY = "literal_acceptance_rejected" as const;

/** Injectable shell runner for tests (default: spawnSync shell). */
export type LiteralAcceptanceRunner = (input: {
  readonly command: string;
  readonly cwd: string;
}) => {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Metadata key on plan.metadata for captured literal commands (#3267). */
export const LITERAL_ACCEPTANCE_METADATA_KEY = "literal_acceptance_commands" as const;

/** Alternate camelCase key accepted on read. */
export const LITERAL_ACCEPTANCE_METADATA_KEY_CAMEL = "literalAcceptanceCommands" as const;
