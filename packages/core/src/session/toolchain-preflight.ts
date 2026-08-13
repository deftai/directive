/**
 * Done-gate toolchain preflight at session start (#3282).
 *
 * Verifies the framework done-gate's own toolchain (task binary, package
 * manager, node, optional CLI dist) up front so agents get a named cause +
 * remedy in one turn instead of reverse-engineering `directive check` failures.
 *
 * Never bootstraps tooling the PRODUCT does not need. Failures name cause and
 * remedy without embedding env values.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  allGatesCliDispatchable,
  GLOBAL_CLI_REMEDY,
  isCliNativeGate,
} from "../check/cli-native-gates.js";
import { isFrameworkRepoRoot, isFrameworkSourceContext } from "../check/context.js";
import {
  type CheckGateSpec,
  CONSUMER_CHECK_GATES,
  checkGateId,
  FRAMEWORK_CHECK_GATES,
} from "../check/gate-lists.js";
import { defaultWhich } from "../doctor/which.js";

export const TOOLCHAIN_PREFLIGHT_TOOLS = ["task", "pnpm", "node", "git"] as const;
export type ToolchainPreflightTool = (typeof TOOLCHAIN_PREFLIGHT_TOOLS)[number];

export type ToolchainPreflightStatus = "ok" | "missing" | "degraded";

/** How a missing tool affects check dispatch (#3335). */
export type ToolchainPreflightImpact = "none" | "degraded";

export interface ToolchainPreflightFinding {
  readonly tool: ToolchainPreflightTool | "cli_dist";
  readonly present: boolean;
  /** Machine-stable cause code (never embeds env values). */
  readonly cause: string | null;
  /** Operator/agent remedy command or instruction. */
  readonly remedy: string | null;
  /**
   * Missing-tool impact. `none` = present false but no install remedy and
   * check does not skip CLI-native gates (#3335).
   */
  readonly impact?: ToolchainPreflightImpact | null;
}

export interface ToolchainPreflightResult {
  readonly status: ToolchainPreflightStatus;
  readonly ok: boolean;
  /** True when missing tools would force check into degraded/skip mode. */
  readonly degraded: boolean;
  readonly findings: readonly ToolchainPreflightFinding[];
  /** Human lines for session:start stdout (named cause + remedy). */
  readonly lines: readonly string[];
  /**
   * Gate ids that check should skip when this preflight is degraded.
   * Product-ordering of remaining gates is owned by #3284.
   */
  readonly skipGateIds: readonly string[];
}

export interface ToolchainPreflightOptions {
  readonly projectRoot?: string;
  readonly frameworkRoot?: string;
  /** which(name) seam for tests. */
  readonly which?: (name: string) => string | null;
  /** existsSync seam for tests. */
  readonly exists?: (path: string) => boolean;
  /**
   * When true (default), also probe for a built CLI dist under frameworkRoot
   * (framework-source dogfood). Consumers without a local dist are fine when
   * a global `deft`/`directive` is on PATH.
   */
  readonly probeCliDist?: boolean;
  /** Active check composition. Defaults from consumer vs framework context. */
  readonly composedGates?: readonly CheckGateSpec[];
  /**
   * Consumer deposit (not framework source). When omitted, inferred from
   * frameworkRoot vs projectRoot (#3335 / #3324).
   */
  readonly consumerDeposit?: boolean;
}

const REMEDY: Record<ToolchainPreflightTool, string> = {
  task: "Install go-task: https://taskfile.dev/installation/ (e.g. winget install Task.Task / brew install go-task)",
  pnpm: "Enable pnpm via corepack: corepack enable && corepack prepare pnpm@latest --activate",
  node: "Install Node 20+ (see .nvmrc); then corepack enable",
  git: "Install Git: https://git-scm.com/downloads",
};

const CAUSE: Record<ToolchainPreflightTool, string> = {
  task: "go-task binary not found on PATH",
  pnpm: "pnpm binary not found on PATH",
  node: "node binary not found on PATH",
  git: "git binary not found on PATH",
};

/**
 * Gates that specifically need a package manager / built dist.
 * When task/node is missing, the orchestrator skips *all* scheduled gates
 * (dynamic from gate-lists), not this static list — avoids hardcode drift.
 */
export const PNPM_DEPENDENT_GATE_IDS: readonly string[] = [
  "toolchain:check",
  "toolchain:check-consumer",
  "ts:check-lane",
];

/** Sentinel skip id meaning "every gate in the active check composition". */
export const SKIP_ALL_GATES = "*";

function probeTool(
  tool: ToolchainPreflightTool,
  which: (name: string) => string | null,
): ToolchainPreflightFinding {
  const present = which(tool) !== null;
  return {
    tool,
    present,
    cause: present ? null : CAUSE[tool],
    remedy: present ? null : REMEDY[tool],
  };
}

function probeCliDist(
  frameworkRoot: string | undefined,
  which: (name: string) => string | null,
  exists: (path: string) => boolean,
): ToolchainPreflightFinding {
  const globalCli = which("deft") !== null || which("directive") !== null;
  if (globalCli) {
    return { tool: "cli_dist", present: true, cause: null, remedy: null };
  }
  if (frameworkRoot) {
    const distBin = join(frameworkRoot, "packages", "cli", "dist", "bin.js");
    if (exists(distBin)) {
      return { tool: "cli_dist", present: true, cause: null, remedy: null };
    }
    return {
      tool: "cli_dist",
      present: false,
      cause: "CLI dist missing and no global deft/directive on PATH",
      remedy: "Run `task build` (framework source) or `npm i -g @deftai/directive@latest`",
    };
  }
  return {
    tool: "cli_dist",
    present: false,
    cause: "no global deft/directive on PATH",
    remedy: "Install: npm i -g @deftai/directive@latest",
  };
}

function formatFindingLine(finding: ToolchainPreflightFinding): string {
  if (finding.present) {
    return `[deft preflight] ${finding.tool}: ok`;
  }
  if (finding.impact === "none") {
    const cause = finding.cause ?? "absent";
    return `[deft preflight] ${finding.tool}: absent (impact: none) — ${cause}`;
  }
  const cause = finding.cause ?? "missing";
  const remedy = finding.remedy ?? "install the tool";
  return `[deft preflight] ${finding.tool}: MISSING — cause: ${cause}; remedy: ${remedy}`;
}

function inferConsumerDeposit(options: ToolchainPreflightOptions): boolean {
  if (options.consumerDeposit !== undefined) return options.consumerDeposit;
  const project = options.projectRoot;
  if (project === undefined) return false;
  // Same-path roots are framework-source only when the tree is the source repo.
  if (isFrameworkRepoRoot(project)) return false;
  const framework = options.frameworkRoot ?? project;
  return !isFrameworkSourceContext(framework, project);
}

/**
 * Run done-gate toolchain preflight. Pure probe — never installs or builds.
 */
export function runToolchainPreflight(
  options: ToolchainPreflightOptions = {},
): ToolchainPreflightResult {
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? existsSync;
  const consumerDeposit = inferConsumerDeposit(options);
  const composed =
    options.composedGates ?? (consumerDeposit ? CONSUMER_CHECK_GATES : FRAMEWORK_CHECK_GATES);
  const allCli = allGatesCliDispatchable(composed);
  const findings: ToolchainPreflightFinding[] = [];

  for (const tool of TOOLCHAIN_PREFLIGHT_TOOLS) {
    findings.push(probeTool(tool, which));
  }

  if (options.probeCliDist !== false) {
    findings.push(probeCliDist(options.frameworkRoot ?? options.projectRoot, which, exists));
  }

  const cliPresent = findings.some((f) => f.tool === "cli_dist" && f.present);
  const taskMissing = findings.some((f) => f.tool === "task" && !f.present);
  const pnpmMissing = findings.some((f) => f.tool === "pnpm" && !f.present);
  const nodeMissing = findings.some((f) => f.tool === "node" && !f.present);

  // #3335: in a deposit whose composed gates are all CLI-dispatchable, a
  // missing task binary is impact none — no install-go-task remedy.
  if (taskMissing && allCli) {
    const idx = findings.findIndex((f) => f.tool === "task");
    const prior = findings[idx];
    if (idx >= 0 && prior !== undefined) {
      findings[idx] = {
        ...prior,
        impact: "none",
        remedy: cliPresent || nodeMissing ? null : GLOBAL_CLI_REMEDY,
        cause: cliPresent
          ? "go-task absent; CLI-native gates dispatch via global deft/directive (#3335)"
          : "go-task absent and no global deft/directive CLI",
      };
    }
  }

  const missingCritical = findings.filter((f) => {
    if (f.present || f.impact === "none") return false;
    return f.tool === "task" || f.tool === "pnpm" || f.tool === "node";
  });

  const skip = new Set<string>();
  if (nodeMissing) {
    skip.add(SKIP_ALL_GATES);
  } else if (taskMissing && !allCli) {
    if (!cliPresent) {
      skip.add(SKIP_ALL_GATES);
    } else {
      for (const spec of composed) {
        const id = checkGateId(spec);
        if (!isCliNativeGate(id)) skip.add(id);
      }
    }
  } else if (taskMissing && allCli && !cliPresent) {
    skip.add(SKIP_ALL_GATES);
  } else if (pnpmMissing) {
    for (const id of PNPM_DEPENDENT_GATE_IDS) {
      skip.add(id);
    }
  }

  const degraded = missingCritical.length > 0 || (taskMissing && allCli && !cliPresent);
  const ok = !degraded;
  const status: ToolchainPreflightStatus = ok ? "ok" : "degraded";

  const lines: string[] = [];
  lines.push(`[deft preflight] toolchain status: ${status}`);
  for (const finding of findings) {
    if (!finding.present) {
      lines.push(formatFindingLine(finding));
    }
  }
  if (ok) {
    lines.push(
      taskMissing && allCli
        ? "[deft preflight] done-gate toolchain ready (CLI dispatch; go-task not required) (#3335)"
        : "[deft preflight] done-gate toolchain ready (task, pnpm, node)",
    );
  } else {
    lines.push(
      "[deft preflight] degraded mode: directive check will skip toolchain-dependent gates " +
        "with a named skip report rather than bootstrapping product-unneeded tooling (#3282)",
    );
    if (skip.size > 0) {
      lines.push(
        `[deft preflight] gates subject to skip when degraded: ${[...skip].sort().join(", ")}`,
      );
    }
  }

  return {
    status,
    ok,
    degraded,
    findings,
    lines,
    skipGateIds: [...skip].sort(),
  };
}

/** Serialize preflight for run-summary / ritual-state (no env values). */
export function toolchainPreflightToDict(
  result: ToolchainPreflightResult,
): Record<string, unknown> {
  return {
    status: result.status,
    ok: result.ok,
    degraded: result.degraded,
    findings: result.findings.map((f) => ({
      tool: f.tool,
      present: f.present,
      cause: f.cause,
      remedy: f.remedy,
      ...(f.impact !== undefined ? { impact: f.impact } : {}),
    })),
    skip_gate_ids: [...result.skipGateIds],
  };
}
