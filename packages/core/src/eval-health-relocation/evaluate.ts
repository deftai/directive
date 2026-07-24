import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { evaluateHealth, type HealthReport } from "../eval/health.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { resolveEvalPath } from "../layout/resolve.js";
import { matchAny } from "../orchestration/pathspec.js";

export type OutputStream = "stdout" | "stderr" | "none";

/** Glob patterns that classify a change as epic #2369 rule-relocation (#2373). */
export const RULE_RELOCATION_PATH_PATTERNS = [
  "AGENTS.md",
  "content/templates/agents-entry.md",
  "content/skills/**/SKILL.md",
  "content/packs/**",
] as const;

/** Committed no-regression baseline relative to `xbrief/.eval/`. */
export const HEALTH_BASELINE_REL = "results/eval-health-baseline.json";

/** Result of verify:eval-health-relocation; three-state exit contract. */
export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  /** True when the diff did not touch rule-relocation paths (gate skipped). */
  readonly skipped?: boolean;
}

export interface EvaluateOptions {
  readonly projectRoot?: string;
  /** Git ref for `git diff --name-only` (CI / branch comparison). */
  readonly baseRef?: string;
  /** Use `git diff --cached --name-only` (pre-commit / staged). */
  readonly staged?: boolean;
  /** Explicit path list (tests / overrides). */
  readonly paths?: readonly string[];
  readonly quiet?: boolean;
  /** Write the current eval:health report as the committed baseline. */
  readonly seedBaseline?: boolean;
  /** Test hook: override eval:health collection. */
  readonly healthEvaluator?: (projectRoot: string) => HealthReport | null;
}

/** Validate a parsed baseline JSON object before use. */
export function parseHealthBaseline(parsed: unknown): HealthReport | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.score !== "number" || !Array.isArray(record.gates)) {
    return null;
  }
  if (!Array.isArray(record.contradictions)) {
    return null;
  }
  return parsed as HealthReport;
}

/** True when *path* matches a rule-relocation home. */
export function isRuleRelocationPath(path: string): boolean {
  return matchAny(RULE_RELOCATION_PATH_PATTERNS, path);
}

/** Classify a path list for rule-relocation coverage. */
export function classifyRuleRelocationPaths(paths: readonly string[]): {
  readonly isRelocation: boolean;
  readonly matchedPaths: readonly string[];
} {
  const matchedPaths = paths.filter(isRuleRelocationPath);
  return { isRelocation: matchedPaths.length > 0, matchedPaths };
}

/** Absolute path to the committed eval-health baseline snapshot. */
export function healthBaselinePath(projectRoot: string): string {
  return resolveEvalPath(projectRoot, HEALTH_BASELINE_REL);
}

/** Read the committed baseline snapshot, if present. */
export function readHealthBaseline(projectRoot: string): HealthReport | null {
  const path = healthBaselinePath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseHealthBaseline(parsed);
  } catch {
    return null;
  }
}

/** Persist a health report as the committed baseline (#2373 Wave 2 seed). */
export function writeHealthBaseline(projectRoot: string, report: HealthReport): void {
  const path = healthBaselinePath(projectRoot);
  assertWriteTargetSafe(projectRoot, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report)}\n`, "utf8");
}

function gitNameOnlyDiff(projectRoot: string, args: string[]): string[] | { error: string } {
  try {
    const stdout = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err: unknown) {
    return { error: String(err) };
  }
}

/** Collect changed paths from git (base ref or staged index). */
export function collectChangedPaths(
  projectRoot: string,
  options: { baseRef?: string; staged?: boolean },
): string[] | { error: string } {
  if (options.staged) {
    return gitNameOnlyDiff(projectRoot, ["--cached"]);
  }
  if (options.baseRef !== undefined && options.baseRef.length > 0) {
    return gitNameOnlyDiff(projectRoot, [options.baseRef, "HEAD"]);
  }
  return [];
}

/**
 * Detect eval:health regression against a committed baseline.
 *
 * Fail-closed rules (#2373):
 * - score must not drop below baseline
 * - gates that passed in the baseline must still pass
 * - no new contradictory-gate ids beyond the baseline set
 */
export function detectHealthRegression(
  current: HealthReport,
  baseline: HealthReport,
): { pass: boolean; reasons: readonly string[] } {
  const reasons: string[] = [];

  if (current.score < baseline.score) {
    reasons.push(`framework health score dropped ${baseline.score}->${current.score}`);
  }

  const baselineGates = new Map(
    baseline.gates.filter((gate) => !gate.skipped).map((gate) => [gate.id, gate]),
  );
  for (const [id, baseGate] of baselineGates) {
    if (!baseGate.pass) {
      continue;
    }
    const currentGate = current.gates.find((gate) => gate.id === id && !gate.skipped);
    if (currentGate === undefined) {
      reasons.push(`gate '${id}' missing from current eval:health report`);
      continue;
    }
    if (!currentGate.pass) {
      reasons.push(`gate '${id}' regressed (baseline pass -> current fail)`);
    }
  }

  const baselineContradictionIds = new Set(baseline.contradictions.map((c) => c.id));
  for (const contradiction of current.contradictions) {
    if (!baselineContradictionIds.has(contradiction.id)) {
      reasons.push(`new contradictory gate '${contradiction.id}'`);
    }
  }

  return { pass: reasons.length === 0, reasons };
}

function formatSkipMessage(matchedPaths: readonly string[]): string {
  return (
    "✓ verify:eval-health-relocation: no rule-relocation paths in diff " +
    `(checked ${RULE_RELOCATION_PATH_PATTERNS.length} patterns; ` +
    `diff had ${matchedPaths.length} relocation match${matchedPaths.length === 1 ? "" : "es"}).`
  );
}

function formatPassMessage(score: number, matchedPaths: readonly string[]): string {
  return (
    `✓ verify:eval-health-relocation: eval:health no-regression OK ` +
    `(score=${score}/100; relocation paths: ${matchedPaths.join(", ")}).`
  );
}

function formatRegressionMessage(
  reasons: readonly string[],
  matchedPaths: readonly string[],
  baseline: HealthReport,
  current: HealthReport,
): string {
  const detail = reasons.map((reason) => `   - ${reason}`).join("\n");
  return (
    "❌ verify:eval-health-relocation: eval:health regression on rule-relocation PR " +
    `(#2373 / epic #2369).\n` +
    `   Baseline score: ${baseline.score}/100; current: ${current.score}/100.\n` +
    `   Matched relocation paths: ${matchedPaths.join(", ")}\n` +
    `${detail}\n` +
    "   Remediation: restore gate pass states / score, or bump the committed baseline\n" +
    `   at ${HEALTH_BASELINE_REL} only after a deliberate, reviewed health change.\n` +
    "   Run `task eval:health` for the full gate breakdown."
  );
}

function runHealthEvaluator(
  projectRoot: string,
  healthEvaluator: EvaluateOptions["healthEvaluator"],
): HealthReport | null {
  if (healthEvaluator !== undefined) {
    return healthEvaluator(projectRoot);
  }
  const healthResult = evaluateHealth({
    projectRoot,
    persist: false,
    frameworkSource: true,
  });
  return healthResult.report;
}

/**
 * Conditional fail-closed gate for epic #2369 rule-relocation PRs (#2373).
 *
 * Skips (exit 0) when the diff does not touch relocation homes. When relocation
 * paths are present, requires eval:health no-regression against the committed
 * baseline at `xbrief/.eval/results/eval-health-baseline.json`.
 */
export function evaluate(options: EvaluateOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const quiet = options.quiet ?? false;

  if (options.seedBaseline) {
    const report = runHealthEvaluator(projectRoot, options.healthEvaluator);
    if (report === null) {
      return {
        code: 2,
        message: "❌ verify:eval-health-relocation: eval:health returned no report.",
        stream: "stderr",
      };
    }
    try {
      writeHealthBaseline(projectRoot, report);
    } catch (err) {
      if (err instanceof ProjectionContainmentError) {
        return {
          code: 2,
          message: `❌ verify:eval-health-relocation: ${err.message}`,
          stream: "stderr",
        };
      }
      throw err;
    }
    return {
      code: 0,
      message:
        `✓ verify:eval-health-relocation: seeded baseline at ${HEALTH_BASELINE_REL} ` +
        `(score=${report.score}/100).`,
      stream: "stdout",
    };
  }

  let paths: string[];
  if (options.paths !== undefined) {
    paths = [...options.paths];
  } else if (options.baseRef !== undefined || options.staged) {
    const collected = collectChangedPaths(projectRoot, {
      baseRef: options.baseRef,
      staged: options.staged,
    });
    if ("error" in collected) {
      return {
        code: 2,
        message:
          "❌ verify:eval-health-relocation: could not read git diff " +
          `(project_root=${projectRoot}): ${collected.error}`,
        stream: "stderr",
      };
    }
    paths = collected;
  } else {
    return { code: 0, message: "", stream: "none", skipped: true };
  }

  const { isRelocation, matchedPaths } = classifyRuleRelocationPaths(paths);
  if (!isRelocation) {
    if (quiet) {
      return { code: 0, message: "", stream: "none", skipped: true };
    }
    return {
      code: 0,
      message: formatSkipMessage(matchedPaths),
      stream: "stdout",
      skipped: true,
    };
  }

  const current = runHealthEvaluator(projectRoot, options.healthEvaluator);
  if (current === null) {
    return {
      code: 2,
      message: "❌ verify:eval-health-relocation: eval:health returned no report.",
      stream: "stderr",
    };
  }
  const baseline = readHealthBaseline(projectRoot);
  if (baseline === null) {
    return {
      code: 2,
      message:
        "❌ verify:eval-health-relocation: missing committed baseline " +
        `at ${HEALTH_BASELINE_REL}.\n` +
        "   Seed once with: task verify:eval-health-relocation -- --seed-baseline\n" +
        "   (after `task eval:health` is green on master). Baseline seeding is intentional\n" +
        "   and does not weaken verify:agents-md-budget.",
      stream: "stderr",
    };
  }

  const regression = detectHealthRegression(current, baseline);
  if (!regression.pass) {
    return {
      code: 1,
      message: formatRegressionMessage(regression.reasons, matchedPaths, baseline, current),
      stream: "stderr",
    };
  }

  if (quiet) {
    return { code: 0, message: "", stream: "none" };
  }
  return {
    code: 0,
    message: formatPassMessage(current.score, matchedPaths),
    stream: "stdout",
  };
}
