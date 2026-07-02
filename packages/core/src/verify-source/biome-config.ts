/**
 * biome-config.ts -- guard against #2190 (biome check . reports
 * recommended-preset diagnostics as errors vs warnings non-deterministically
 * on a pinned biome version).
 *
 * A preset-inherited rule severity can silently change tier across a biome
 * version bump (or, per #2190, apparently even across runs on the identical
 * pinned version). Pinning `noUnusedVariables` / `noNonNullAssertion` to an
 * explicit non-"error" severity in biome.json makes the tier config-owned so
 * it cannot flip a required CI check to failing on pre-existing diagnostics.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The two rules #2190 observed flipping severity in CI (see docs/analysis/2026-07-02-2190-biome-determinism.md). */
export const GUARDED_RULES: ReadonlyArray<{
  readonly group: string;
  readonly rule: string;
}> = [
  { group: "correctness", rule: "noUnusedVariables" },
  { group: "style", rule: "noNonNullAssertion" },
];

/** Severity levels biome accepts that never fail the build. */
const NON_ERROR_LEVELS = new Set(["warn", "info", "off"]);

export interface RuleSeverityFinding {
  readonly group: string;
  readonly rule: string;
  /** The literal severity value found, or null when the rule has no explicit entry. */
  readonly severity: string | null;
}

export interface BiomeConfigGuardResult {
  readonly code: 0 | 1 | 2;
  readonly findings: readonly RuleSeverityFinding[];
  readonly message: string;
}

function extractSeverity(rulesNode: unknown, group: string, rule: string): string | null {
  if (typeof rulesNode !== "object" || rulesNode === null) {
    return null;
  }
  const groupNode = (rulesNode as Record<string, unknown>)[group];
  if (typeof groupNode !== "object" || groupNode === null) {
    return null;
  }
  const ruleNode = (groupNode as Record<string, unknown>)[rule];
  if (typeof ruleNode === "string") {
    return ruleNode;
  }
  if (typeof ruleNode === "object" && ruleNode !== null) {
    const level = (ruleNode as Record<string, unknown>).level;
    return typeof level === "string" ? level : null;
  }
  return null;
}

/**
 * Parse a biome.json document (already JSON.parse'd) and report the explicit
 * severity declared for each guarded rule.
 */
export function findRuleSeverities(
  biomeConfig: unknown,
  rules: ReadonlyArray<{ readonly group: string; readonly rule: string }> = GUARDED_RULES,
): RuleSeverityFinding[] {
  const linter =
    typeof biomeConfig === "object" && biomeConfig !== null
      ? (biomeConfig as Record<string, unknown>).linter
      : null;
  const rulesNode =
    typeof linter === "object" && linter !== null
      ? (linter as Record<string, unknown>).rules
      : null;
  return rules.map(({ group, rule }) => ({
    group,
    rule,
    severity: extractSeverity(rulesNode, group, rule),
  }));
}

/**
 * Evaluate biome.json at `projectRoot` and fail closed when a guarded rule
 * has no explicit severity, or an explicit severity of "error".
 */
export function evaluateBiomeConfigGuard(projectRoot = "."): BiomeConfigGuardResult {
  const path = join(projectRoot, "biome.json");
  let raw: string;
  try {
    raw = readFileSync(path, { encoding: "utf8" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 2, findings: [], message: `biome-config: cannot read ${path}: ${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 2, findings: [], message: `biome-config: ${path} is not valid JSON: ${msg}` };
  }

  const findings = findRuleSeverities(parsed);
  const bad = findings.filter((f) => f.severity === null || !NON_ERROR_LEVELS.has(f.severity));
  if (bad.length > 0) {
    const lines = bad.map(
      (f) =>
        `  linter.rules.${f.group}.${f.rule}: ${f.severity === null ? "not explicitly set (inherits preset default)" : `"${f.severity}"`}`,
    );
    return {
      code: 1,
      findings,
      message:
        "biome-config: guarded rule(s) lack an explicit non-error severity in biome.json (#2190 " +
        "-- a preset-inherited severity can flip to error non-deterministically):\n" +
        `${lines.join("\n")}\n` +
        '  Fix: declare "warn" (or "info") explicitly under linter.rules.<group>.<rule> in biome.json.',
    };
  }

  return {
    code: 0,
    findings,
    message: `biome-config: ${findings.length} guarded rule(s) have explicit non-error severities (#2190).`,
  };
}
