import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { agentsRefreshPlan } from "../doctor/agents-md.js";
import { evaluate as evaluateEncoding } from "../encoding/evaluate.js";
import { readCorePackageVersion } from "../engine-version.js";
import { containedWrite } from "../fs/contained-write.js";
import { resolveProjectDefinitionPath } from "../layout/resolve.js";
import { healthMetricsHistoryPath } from "../metrics/resolve-metrics-home.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";
import { classifyOnboarding, detectPriorState } from "../triage/welcome/prior-state.js";
import { validateLinks } from "../validate-content/index.js";
import { evaluateConformance } from "../vbrief-validate/conformance.js";
import { validateWipCapOnPlan } from "../vbrief-validate/plan-hooks.js";
import { evaluateContentManifest } from "../verify-source/content-manifest.js";

export const HEALTH_SCHEMA_VERSION = 1 as const;
/** Relative path under the resolved metrics home for eval:health history (#2545). */
export const HEALTH_HISTORY_REL = "health/health-history.jsonl";

/** One static Tier-0 gate probe aggregated into the health score. */
export interface GateProbeResult {
  readonly id: string;
  readonly title: string;
  readonly pass: boolean;
  readonly exitCode: number;
  readonly detail?: string;
  readonly skipped?: boolean;
  readonly skipReason?: string;
}

/** Evidence for a contradictory / unsatisfiable gate pair (#1694 class). */
export interface ContradictionEvidence {
  readonly id: string;
  readonly kind: "unsatisfiable-nudge";
  readonly summary: string;
  readonly signals: readonly string[];
}

/** Versioned Tier-0 health run persisted for trending (#1703). */
export interface HealthReport {
  readonly schemaVersion: typeof HEALTH_SCHEMA_VERSION;
  readonly version: string;
  readonly recordedAt: string;
  readonly score: number;
  readonly gates: readonly GateProbeResult[];
  readonly contradictions: readonly ContradictionEvidence[];
}

export interface EvaluateHealthOptions {
  readonly projectRoot?: string;
  readonly persist?: boolean;
  readonly now?: () => Date;
  readonly frameworkSource?: boolean;
}

export interface EvaluateHealthResult {
  readonly code: 0 | 1 | 2;
  readonly report: HealthReport | null;
  readonly message: string;
}

function sanitizeOneLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

function isFrameworkSourceCheckout(projectRoot: string): boolean {
  const manifest = resolve(projectRoot, "conventions/content-manifest.json");
  const cliPkg = resolve(projectRoot, "packages/cli/package.json");
  return existsSync(manifest) && existsSync(cliPkg);
}

function loadPlan(projectRoot: string): { plan: unknown; filepath: string } | null {
  let filepath: string;
  try {
    filepath = resolveProjectDefinitionPath(projectRoot);
  } catch {
    return null; // No xbrief/ layout; no project definition.
  }
  if (!existsSync(filepath)) {
    return null;
  }
  try {
    const data: unknown = JSON.parse(readFileSync(filepath, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    return { plan: (data as { plan?: unknown }).plan, filepath };
  } catch {
    return null;
  }
}

function probeEncoding(projectRoot: string): GateProbeResult {
  const result = evaluateEncoding(projectRoot, { mode: "all" });
  return {
    id: "encoding",
    title: "verify:encoding",
    pass: result.exitCode === 0,
    exitCode: result.exitCode,
    detail: result.exitCode === 0 ? undefined : result.message.split("\n")[0],
  };
}

function probeLinks(projectRoot: string): GateProbeResult {
  const result = validateLinks.evaluate({
    cwd: projectRoot,
    strict: false,
    argv: [],
    linkCheckStrict: process.env.LINK_CHECK_STRICT === "1",
  });
  return {
    id: "links",
    title: "verify:links",
    pass: result.code === 0,
    exitCode: result.code,
    detail: result.code === 0 ? undefined : result.message.split("\n")[0],
  };
}

function probeVbriefConformance(projectRoot: string): GateProbeResult {
  const result = evaluateConformance(projectRoot, { mode: "all" });
  return {
    id: "vbrief-conformance",
    title: "verify:vbrief-conformance",
    pass: result.exitCode === 0,
    exitCode: result.exitCode,
    detail: result.exitCode === 0 ? undefined : result.message.split("\n")[0],
  };
}

function probeAgentsMdFreshness(projectRoot: string): GateProbeResult {
  const plan = agentsRefreshPlan(projectRoot);
  const state = String(plan.state ?? "unknown");
  const pass = state === "current";
  return {
    id: "agents-md-freshness",
    title: "AGENTS.md managed-section freshness",
    pass,
    exitCode: pass ? 0 : 1,
    detail: pass ? undefined : `state=${state}`,
  };
}

function probeContentManifest(projectRoot: string): GateProbeResult {
  const result = evaluateContentManifest(projectRoot, { root: projectRoot });
  return {
    id: "content-manifest",
    title: "verify:content-manifest",
    pass: result.code === 0,
    exitCode: result.code,
    detail: result.code === 0 ? undefined : result.message.split("\n")[0],
  };
}

/** Absolute path to the versioned health history ledger (#2545). */
export function healthHistoryPath(projectRoot: string): string | null {
  return healthMetricsHistoryPath(projectRoot);
}

/** Detect the canonical wipCap unsatisfiable-nudge contradiction (#1694). */
export function detectWipCapUnsatisfiableNudge(projectRoot: string): ContradictionEvidence | null {
  const loaded = loadPlan(projectRoot);
  if (loaded === null) {
    return null;
  }
  const { plan, filepath } = loaded;
  const policy = readPlanPolicy(plan);
  const wipCapPresent =
    typeof policy === "object" &&
    policy !== null &&
    !Array.isArray(policy) &&
    "wipCap" in (policy as Record<string, unknown>);
  if (wipCapPresent) {
    return null;
  }

  const state = detectPriorState(projectRoot);
  const [, missing] = classifyOnboarding(state);
  if (!missing.includes("wipCap")) {
    return null;
  }

  const validatorErrors = validateWipCapOnPlan(plan, filepath);
  if (validatorErrors.length > 0) {
    return null;
  }

  return {
    id: "wipCap-unsatisfiable-nudge",
    kind: "unsatisfiable-nudge",
    summary:
      "Onboarding completeness treats absent plan.policy.wipCap as incomplete, but omit-by-design accepts absence as valid (#1694 / #1186 D1).",
    signals: [
      "classifyOnboarding: wipCap listed in missing onboarding signals",
      "validateWipCapOnPlan: omitted wipCap is valid",
      "triage:welcome --onboard nudge cannot clear without violating omit-by-design contract",
    ],
  };
}

/** Run all registered contradictory-gate detectors. */
export function detectContradictoryGates(projectRoot: string): ContradictionEvidence[] {
  const wipCap = detectWipCapUnsatisfiableNudge(projectRoot);
  return wipCap === null ? [] : [wipCap];
}

/** Compute a 0-100 score from gate pass rate minus contradiction penalty. */
export function computeHealthScore(
  gates: readonly GateProbeResult[],
  contradictions: readonly ContradictionEvidence[],
): number {
  const active = gates.filter((g) => !g.skipped);
  if (active.length === 0) {
    return contradictions.length > 0 ? 0 : 100;
  }
  const passed = active.filter((g) => g.pass).length;
  const base = Math.round((passed / active.length) * 100);
  const penalty = contradictions.length * 15;
  return Math.max(0, base - penalty);
}

/** Append one health run to the versioned ledger (#1703 Tier 0 / #2545). */
export function persistHealthRun(projectRoot: string, report: HealthReport): void {
  const path = healthHistoryPath(projectRoot);
  if (path === null) {
    return;
  }
  // #2980 wave C: product write sink routes through containedWrite.
  // Project-local metrics: contain under projectRoot. Platform/env home: under ledger parent.
  const projectAbs = resolve(projectRoot);
  const targetAbs = resolve(path);
  const rel = relative(projectAbs, targetAbs);
  const nested = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  if (nested) {
    containedWrite({
      root: projectAbs,
      target: targetAbs,
      data: `${JSON.stringify(report)}\n`,
      mode: "append",
    });
    return;
  }
  const parent = dirname(targetAbs);
  mkdirSync(parent, { recursive: true });
  containedWrite({
    root: resolve(parent),
    target: basename(targetAbs),
    data: `${JSON.stringify(report)}\n`,
    mode: "append",
  });
}

function collectStaticGates(projectRoot: string, frameworkSource: boolean): GateProbeResult[] {
  const gates: GateProbeResult[] = [
    probeEncoding(projectRoot),
    probeLinks(projectRoot),
    probeVbriefConformance(projectRoot),
    probeAgentsMdFreshness(projectRoot),
  ];

  if (frameworkSource) {
    gates.push(probeContentManifest(projectRoot));
  } else {
    gates.push({
      id: "content-manifest",
      title: "verify:content-manifest",
      pass: true,
      exitCode: 0,
      skipped: true,
      skipReason: "framework-source-only gate",
    });
  }

  return gates;
}

function formatHumanReport(report: HealthReport): string {
  const lines = [
    `eval:health v${report.version} score=${report.score}/100 (${report.recordedAt})`,
    ...report.gates.map((g) => {
      const status = g.skipped ? "SKIP" : g.pass ? "PASS" : "FAIL";
      const suffix = g.skipped
        ? ` (${sanitizeOneLine(g.skipReason ?? "")})`
        : g.detail
          ? ` -- ${sanitizeOneLine(g.detail)}`
          : "";
      return `  [${status}] ${g.title}${suffix}`;
    }),
  ];
  if (report.contradictions.length > 0) {
    lines.push("  Contradictory gates:");
    for (const c of report.contradictions) {
      lines.push(`    - ${c.id}: ${sanitizeOneLine(c.summary)}`);
    }
  }
  return lines.join("\n");
}

/** Aggregate Tier-0 static gates into a versioned framework health score (#1703). */
export function evaluateHealth(options: EvaluateHealthOptions = {}): EvaluateHealthResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const frameworkSource = options.frameworkSource ?? isFrameworkSourceCheckout(projectRoot);
  const now = options.now ?? (() => new Date());
  const persist = options.persist ?? true;

  const gates = collectStaticGates(projectRoot, frameworkSource);
  const contradictions = detectContradictoryGates(projectRoot);
  const score = computeHealthScore(gates, contradictions);
  const report: HealthReport = {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    version: readCorePackageVersion(),
    recordedAt: now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    score,
    gates,
    contradictions,
  };

  if (persist) {
    const ledgerPath = healthHistoryPath(projectRoot);
    if (ledgerPath !== null) {
      try {
        persistHealthRun(projectRoot, report);
      } catch (err: unknown) {
        const persistError = `eval:health: failed to persist health history: ${String(err)}`;
        const healthy = score === 100 && contradictions.length === 0;
        return {
          code: healthy ? 0 : 1,
          report,
          message: `${formatHumanReport(report)}\n${persistError}`,
        };
      }
    }
  }

  const healthy = score === 100 && contradictions.length === 0;
  return {
    code: healthy ? 0 : 1,
    report,
    message: formatHumanReport(report),
  };
}
