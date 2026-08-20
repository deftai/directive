/**
 * Named-cause + remedy formatting for check gate failures (#3282).
 *
 * Gate failures must never be bare exit 1: report gate name, cause, and remedy
 * without embedding env values.
 */

export interface NamedCauseMessage {
  readonly gateId: string;
  readonly exitCode: number;
  readonly cause: string;
  readonly remedy: string;
  readonly lines: readonly string[];
}

/** Per-gate remedy hints (static; no env interpolation). */
const GATE_REMEDIES: Readonly<Record<string, string>> = {
  "verify:branch":
    "Create a feature branch (`git switch -c feat/<name>`) or set plan.policy.allowDirectCommitsToMaster with confirmation",
  "verify:encoding":
    "Fix non-ASCII / encoding issues flagged by the gate; re-run task verify:encoding",
  "verify:cache-fresh": "Run task cache:fetch-all or task triage:bootstrap to refresh the cache",
  "verify:orphan-active":
    "Complete or cancel active xBRIEFs whose issues are closed / PRs merged (task scope:complete / scope:cancel)",
  "verify:wip-cap":
    "Demote stale pending scopes (task scope:demote) or raise plan.policy.wipCap deliberately",
  doctor: "Run task doctor and follow the named recovery steps",
  "toolchain:check":
    "Install missing maintainer tools reported by the gate (go, uv, git, gh, node, pnpm)",
  "toolchain:check-consumer":
    "Install missing consumer tools: go-task, git, gh, node, pnpm (corepack enable && corepack prepare pnpm@latest --activate)",
  "ts:check-lane": "Fix lint/type/test failures; re-run task ts:check-lane",
  "vbrief:validate": "Fix xBRIEF/vBRIEF schema errors reported by the gate",
  "verify-strategy-output":
    "Re-run strategy output or fix non-conformant scope filenames / PROJECT-DEFINITION",
  "verify:test-boundary":
    "Move tests to the allowed placement or update plan.policy test-boundary allowlist",
  "verify:scope-provenance": "Record approved scope provenance for the failing paths",
  "verify:consumer-check-contract": "Align consumer Taskfile includes with the required gate graph",
  "verify:forward-coverage":
    "Add tests for new source files and uncovered changed branches (task verify:forward-coverage)",
  "verify:scm-boundary": "Move SCM mutations off GraphQL-heavy paths or wait for rate-limit reset",
  "verify:license-sync": "Sync LICENSE / package license fields",
  "verify:agents-md-budget":
    "Trim AGENTS.md managed section or raise plan.policy.agentsMdBudget deliberately",
};

const SPAWN_ERROR_REMEDY =
  "Install go-task (https://taskfile.dev/installation/) and ensure `task` is on PATH; then re-run task check";

const CLI_SPAWN_ERROR_REMEDY = "Install: npm i -g @deftai/directive@latest";

/**
 * Extract a short cause from gate stdout/stderr without leaking env values.
 * Strips lines that look like KEY=value assignments.
 */
export function extractGateCause(
  stdout: string,
  stderr: string,
  exitCode: number,
  spawnError?: string,
  gateId?: string,
): string {
  if (spawnError !== undefined && spawnError.length > 0) {
    // Normalize common missing-binary messages without path dumps.
    if (/ENOENT|not found|not recognized/i.test(spawnError)) {
      if (/\b(deft|directive)(\.cmd)?\b/i.test(spawnError)) {
        return "global deft/directive CLI not found on PATH";
      }
      return "task binary not found on PATH (cannot spawn go-task)";
    }
    return sanitizeCauseLine(spawnError);
  }
  const combined = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const useful: string[] = [];
  for (const line of combined) {
    if (looksLikeEnvLeak(line)) continue;
    if (line.startsWith("check:")) continue;
    if (isGoTaskWrapperNoise(line)) continue;
    useful.push(line);
  }
  const gateHint = gateId?.trim() ?? "";
  if (gateHint.length > 0) {
    const named = useful.find((line) => line.includes(gateHint));
    if (named !== undefined) {
      return sanitizeCauseLine(named);
    }
  }
  if (useful.length > 0) {
    return sanitizeCauseLine(useful[0] as string);
  }
  return `gate exited ${exitCode} without a diagnostic message`;
}

/** go-task echoes `task: [engine:_ts-build] set -eu` plus the script body (#3449). */
function isGoTaskWrapperNoise(line: string): boolean {
  if (/^task: \[/.test(line)) return true;
  if (/^set -eu$/.test(line)) return true;
  if (/^: #/.test(line)) return true;
  if (/^# /.test(line) || /^#\t/.test(line)) return true;
  if (/^(bin|root_pkg|is_buildable_source|first_token|is_runtime_verb|global_cli)=/.test(line)) {
    return true;
  }
  if (/^(if |elif |else$|fi$|then$)/.test(line)) return true;
  return false;
}

function looksLikeEnvLeak(line: string): boolean {
  // Avoid echoing DEFT_*= or generic env dumps.
  if (/^[A-Z][A-Z0-9_]*=/.test(line)) return true;
  if (/\bDEFT_[A-Z0-9_]+\b/.test(line) && line.includes("=")) return true;
  return false;
}

function sanitizeCauseLine(line: string): string {
  // Cap length; collapse absolute home paths lightly.
  let out = line.replace(/\r/g, "").trim();
  if (out.length > 240) {
    out = `${out.slice(0, 237)}...`;
  }
  return out;
}

export function remedyForGate(gateId: string, cause: string): string {
  if (/global deft\/directive CLI not found/i.test(cause)) {
    return CLI_SPAWN_ERROR_REMEDY;
  }
  if (/task binary not found|cannot spawn go-task/i.test(cause)) {
    if (gateId.startsWith("verify:") || gateId.startsWith("verify-") || gateId === "doctor") {
      return CLI_SPAWN_ERROR_REMEDY;
    }
    return SPAWN_ERROR_REMEDY;
  }
  if (/pnpm binary not found|pnpm: NOT FOUND/i.test(cause)) {
    return "Enable pnpm: corepack enable && corepack prepare pnpm@latest --activate";
  }
  return (
    GATE_REMEDIES[gateId] ??
    `Re-run the gate for details: task ${gateId}  (or task check); fix the reported product/process defect`
  );
}

/**
 * Format named-cause failure lines for a single gate.
 */
export function formatNamedCauseFailure(input: {
  readonly gateId: string;
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly spawnError?: string;
}): NamedCauseMessage {
  const cause = extractGateCause(
    input.stdout ?? "",
    input.stderr ?? "",
    input.exitCode,
    input.spawnError,
    input.gateId,
  );
  const remedy = remedyForGate(input.gateId, cause);
  const lines = [
    `check: gate ${input.gateId} failed (exit ${input.exitCode})`,
    `  cause: ${cause}`,
    `  remedy: ${remedy}`,
  ];
  return {
    gateId: input.gateId,
    exitCode: input.exitCode,
    cause,
    remedy,
    lines,
  };
}

/**
 * Format degraded-mode skip report (which gates skipped and why).
 */
export function formatDegradedSkipReport(input: {
  readonly reason: string;
  readonly skipped: readonly { id: string; cause: string; remedy: string }[];
  readonly ran?: readonly string[];
  readonly failed?: readonly string[];
  /** Default 2 = config/environment (never green-pass skipped required gates). */
  readonly exitCode?: number;
}): readonly string[] {
  const exitCode = input.exitCode ?? 2;
  const lines: string[] = [
    `check: degraded mode — ${input.reason}`,
    `check: skipped ${input.skipped.length} gate(s) due to missing framework toolchain (#3282):`,
  ];
  for (const gate of input.skipped) {
    lines.push(`  - ${gate.id}: cause: ${gate.cause}; remedy: ${gate.remedy}`);
  }
  if (input.ran !== undefined && input.ran.length > 0) {
    lines.push(`check: ran: ${input.ran.join(", ")}`);
  }
  if (input.failed !== undefined && input.failed.length > 0) {
    lines.push(`check: failed: ${input.failed.join(", ")}`);
  }
  lines.push(
    `check: exit ${exitCode} (degraded/config) — skipped required gates are not a green pass; ` +
      "install missing tooling (see remedies above) and re-run task check",
  );
  return lines;
}
