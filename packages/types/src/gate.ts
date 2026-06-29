/** Three-state exit codes used by deterministic deft gates. */
export type GateExitCode = 0 | 1 | 2;

export const GATE_EXIT_OK = 0 as const;
export const GATE_EXIT_VIOLATION = 1 as const;
export const GATE_EXIT_CONFIG_ERROR = 2 as const;

/** Minimal gate result envelope for downstream tooling. */
export interface GateResult {
  readonly code: GateExitCode;
  readonly message: string;
}
