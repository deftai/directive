/**
 * Hard effort-budget detection and bank-the-pass guidance (#3266).
 *
 * When a host/harness declares max-turns or max-cost, agents must bank the
 * *stated* acceptance pass before self-imposed deepening. Detection is
 * advisory at session start (env / flags / host capability pointer #1461);
 * skill text in deft-directive-build and pre-pr owns the behavioral rule.
 *
 * Composes dual-stop (#2442): dual-stop is the failure/budget envelope;
 * this module is the success-side analog (do not gold-plate past the bar
 * when remaining budget cannot also fund a fix for deeper findings).
 *
 * Fail-loud (#1006): when deepening is skipped for budget, summaries must
 * say so — never silent gold-plate or silent skip.
 */

/** Canonical max-turns env (hard turn budget). */
export const ENV_MAX_TURNS = "DEFT_MAX_TURNS";
/** Canonical max cost/budget env (opaque cost units from the host). */
export const ENV_MAX_BUDGET = "DEFT_MAX_BUDGET";
/** Remaining turns when the host updates mid-run. */
export const ENV_REMAINING_TURNS = "DEFT_REMAINING_TURNS";
/** Remaining cost units when the host updates mid-run. */
export const ENV_REMAINING_BUDGET = "DEFT_REMAINING_BUDGET";
/**
 * Explicit hard-cap flag when the host has a limit but does not expose a number
 * (truthy → hard-capped with unknown numeric ceiling).
 */
export const ENV_HARD_BUDGET = "DEFT_HARD_BUDGET";

/** Additional env keys accepted as max-turns aliases (harness / CLI common). */
export const MAX_TURNS_ENV_ALIASES = [
  ENV_MAX_TURNS,
  "MAX_TURNS",
  "AGENT_MAX_TURNS",
  "DEFT_AGENT_MAX_TURNS",
  "CURSOR_MAX_TURNS",
] as const;

/** Additional env keys accepted as max-budget/cost aliases. */
export const MAX_BUDGET_ENV_ALIASES = [
  ENV_MAX_BUDGET,
  "MAX_BUDGET",
  "AGENT_BUDGET",
  "DEFT_AGENT_BUDGET",
  "AGENT_MAX_BUDGET",
] as const;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type EffortBudgetKind = "none" | "max-turns" | "max-cost" | "both" | "hard-flag";

/** Whether the session is under a detectable hard cap. */
export type EffortBudgetPosture = "unbounded" | "hard-capped";

/**
 * Recommended self-verification depth given budget + stated-AC status.
 * - stated-only: bank the stated bar; do not start self-imposed suites
 * - stated-then-deepen: stated bar first; deepen only with remaining budget
 * - unconstrained-deepen: no hard budget signal; dual-stop still applies
 */
export type VerificationDepthPolicy =
  | "stated-only"
  | "stated-then-deepen"
  | "unconstrained-deepen";

export interface HardEffortBudget {
  readonly detected: boolean;
  readonly posture: EffortBudgetPosture;
  readonly kind: EffortBudgetKind;
  /** Hard max turns when known; null if only a flag or cost cap is present. */
  readonly maxTurns: number | null;
  /** Hard max cost units when known (opaque host units). */
  readonly maxBudget: number | null;
  /** Remaining turns when the host exposes them; else equals maxTurns. */
  readonly remainingTurns: number | null;
  /** Remaining cost units when exposed; else equals maxBudget. */
  readonly remainingBudget: number | null;
  /** Env keys / host signals that contributed. */
  readonly sources: readonly string[];
}

export interface DetectHardEffortBudgetInput {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional host capability descriptor fragment (#1461 pointer).
   * Accepts maxTurns / max_turns / maxBudget / max_budget / hardBudget.
   */
  readonly hostDescriptor?: Readonly<Record<string, unknown>> | null;
}

export interface RecommendVerificationDepthInput {
  readonly budget: HardEffortBudget;
  /** Whether stated acceptance criteria (issue/xBRIEF AC) are already met. */
  readonly statedAcceptanceMet: boolean;
  /**
   * Reserve for a fix after a deeper finding (turns). Default 3 — if remaining
   * is below this, do not start self-imposed deepening.
   */
  readonly deepenReserveTurns?: number;
  /** Reserve for a fix after a deeper finding (cost units). Default null (ignore). */
  readonly deepenReserveBudget?: number | null;
}

function envTruthy(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

function parsePositiveNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function firstNumericFromEnv(
  environ: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): { value: number | null; source: string | null } {
  for (const key of keys) {
    const value = parsePositiveNumber(environ[key]);
    if (value !== null) {
      return { value, source: `env:${key}` };
    }
  }
  return { value: null, source: null };
}

function hostNumeric(
  host: Readonly<Record<string, unknown>> | null | undefined,
  keys: readonly string[],
): { value: number | null; source: string | null } {
  if (!host) return { value: null, source: null };
  for (const key of keys) {
    const raw = host[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return { value: raw, source: `host:${key}` };
    }
    if (typeof raw === "string") {
      const n = parsePositiveNumber(raw);
      if (n !== null) return { value: n, source: `host:${key}` };
    }
  }
  return { value: null, source: null };
}

function hostTruthy(
  host: Readonly<Record<string, unknown>> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!host) return null;
  for (const key of keys) {
    const raw = host[key];
    if (raw === true) return `host:${key}`;
    if (typeof raw === "string" && envTruthy(raw)) return `host:${key}`;
    if (typeof raw === "number" && raw === 1) return `host:${key}`;
  }
  return null;
}

/**
 * Detect a hard turn/cost budget from env and optional host descriptor (#3266).
 * Defaults to unbounded when no signal is present.
 */
export function detectHardEffortBudget(
  input: DetectHardEffortBudgetInput = {},
): HardEffortBudget {
  const environ = input.environ ?? process.env;
  const host = input.hostDescriptor ?? null;
  const sources: string[] = [];

  const turnsEnv = firstNumericFromEnv(environ, MAX_TURNS_ENV_ALIASES);
  const budgetEnv = firstNumericFromEnv(environ, MAX_BUDGET_ENV_ALIASES);
  const turnsHost = hostNumeric(host, ["maxTurns", "max_turns", "maxTurnLimit"]);
  const budgetHost = hostNumeric(host, ["maxBudget", "max_budget", "maxCost", "max_cost"]);

  // Prefer explicit DEFT_* then first alias; host fills gaps only.
  const maxTurns = turnsEnv.value ?? turnsHost.value;
  const maxBudget = budgetEnv.value ?? budgetHost.value;
  if (turnsEnv.source) sources.push(turnsEnv.source);
  else if (turnsHost.source) sources.push(turnsHost.source);
  if (budgetEnv.source) sources.push(budgetEnv.source);
  else if (budgetHost.source) sources.push(budgetHost.source);

  const remainingTurnsEnv = firstNumericFromEnv(environ, [
    ENV_REMAINING_TURNS,
    "REMAINING_TURNS",
  ]);
  const remainingBudgetEnv = firstNumericFromEnv(environ, [
    ENV_REMAINING_BUDGET,
    "REMAINING_BUDGET",
  ]);
  if (remainingTurnsEnv.source) sources.push(remainingTurnsEnv.source);
  if (remainingBudgetEnv.source) sources.push(remainingBudgetEnv.source);

  const remainingTurns = remainingTurnsEnv.value ?? maxTurns;
  const remainingBudget = remainingBudgetEnv.value ?? maxBudget;

  let hardFlag = false;
  if (envTruthy(environ[ENV_HARD_BUDGET])) {
    hardFlag = true;
    sources.push(`env:${ENV_HARD_BUDGET}`);
  } else {
    const hostFlag = hostTruthy(host, ["hardBudget", "hard_budget", "hasHardBudget"]);
    if (hostFlag) {
      hardFlag = true;
      sources.push(hostFlag);
    }
  }

  const hasTurns = maxTurns !== null;
  const hasCost = maxBudget !== null;
  let kind: EffortBudgetKind = "none";
  if (hasTurns && hasCost) kind = "both";
  else if (hasTurns) kind = "max-turns";
  else if (hasCost) kind = "max-cost";
  else if (hardFlag) kind = "hard-flag";

  const detected = kind !== "none";
  return {
    detected,
    posture: detected ? "hard-capped" : "unbounded",
    kind,
    maxTurns,
    maxBudget,
    remainingTurns: detected ? remainingTurns : null,
    remainingBudget: detected ? remainingBudget : null,
    sources,
  };
}

/**
 * Recommend self-verification depth: bank stated AC before deepening (#3266).
 */
export function recommendVerificationDepth(
  input: RecommendVerificationDepthInput,
): VerificationDepthPolicy {
  const { budget, statedAcceptanceMet } = input;
  if (!budget.detected) {
    return "unconstrained-deepen";
  }
  if (!statedAcceptanceMet) {
    // Hard budget + AC open → only work that banks the stated pass.
    return "stated-only";
  }

  const reserveTurns = input.deepenReserveTurns ?? 3;
  const reserveBudget = input.deepenReserveBudget ?? null;

  const turnsOk =
    budget.remainingTurns === null || budget.remainingTurns >= reserveTurns;
  const costOk =
    reserveBudget === null ||
    budget.remainingBudget === null ||
    budget.remainingBudget >= reserveBudget;

  // hard-flag with no numbers: after AC is met, allow stated-then-deepen only
  // when remaining is unknown — agent still must fail-loud if it skips.
  if (budget.kind === "hard-flag") {
    return "stated-then-deepen";
  }

  if (turnsOk && costOk) {
    return "stated-then-deepen";
  }
  return "stated-only";
}

/**
 * Operator-visible note when self-imposed deepening is skipped for budget (#1006).
 */
export function formatDeepeningSkippedNote(budget: HardEffortBudget, reason?: string): string {
  const detail =
    reason?.trim() ||
    "remaining budget is insufficient to both deepen verification and fix a found defect";
  const sources = budget.sources.length > 0 ? ` sources=${budget.sources.join(",")}` : "";
  const rem =
    budget.remainingTurns !== null
      ? ` remaining_turns=${budget.remainingTurns}`
      : budget.remainingBudget !== null
        ? ` remaining_budget=${budget.remainingBudget}`
        : "";
  return (
    `[deft effort-budget] deepening_skipped=true reason=${detail}` +
    ` posture=${budget.posture} kind=${budget.kind}${rem}${sources} (#3266/#1006)`
  );
}

/** Session-start / JSON payload shape. */
export function effortBudgetToDict(budget: HardEffortBudget): Record<string, unknown> {
  return {
    detected: budget.detected,
    posture: budget.posture,
    kind: budget.kind,
    max_turns: budget.maxTurns,
    max_budget: budget.maxBudget,
    remaining_turns: budget.remainingTurns,
    remaining_budget: budget.remainingBudget,
    sources: [...budget.sources],
  };
}

/**
 * Format operator-facing effort-budget lines for session:start (#3266).
 * Always emits one summary line; adds bank-the-pass guidance when hard-capped.
 */
export function formatEffortBudgetLines(budget: HardEffortBudget): string[] {
  if (!budget.detected) {
    return [
      "[deft effort-budget] posture=unbounded — no hard max-turns/max-budget signal " +
        `(env ${ENV_MAX_TURNS}/${ENV_MAX_BUDGET} or host descriptor) (#3266)`,
    ];
  }

  const parts: string[] = [
    `[deft effort-budget] posture=${budget.posture}`,
    `kind=${budget.kind}`,
  ];
  if (budget.maxTurns !== null) parts.push(`max_turns=${budget.maxTurns}`);
  if (budget.remainingTurns !== null && budget.remainingTurns !== budget.maxTurns) {
    parts.push(`remaining_turns=${budget.remainingTurns}`);
  }
  if (budget.maxBudget !== null) parts.push(`max_budget=${budget.maxBudget}`);
  if (budget.remainingBudget !== null && budget.remainingBudget !== budget.maxBudget) {
    parts.push(`remaining_budget=${budget.remainingBudget}`);
  }
  if (budget.sources.length > 0) parts.push(`sources=${budget.sources.join(",")}`);

  const lines: string[] = [`${parts.join(" ")} (#3266)`];
  lines.push(
    "[deft effort-budget] bank stated acceptance pass before self-imposed deepening; " +
      "scale verification depth with remaining budget; fail-loud when deepening is skipped (#3266/#1006)",
  );
  return lines;
}

/**
 * Detect + format; fail-open for session-start callers.
 */
export function maybeFormatEffortBudgetLines(
  input: DetectHardEffortBudgetInput = {},
): { budget: HardEffortBudget; lines: string[] } {
  const budget = detectHardEffortBudget(input);
  return { budget, lines: formatEffortBudgetLines(budget) };
}
