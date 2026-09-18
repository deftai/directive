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
    "Install the missing consumer tool reported by the gate; use npm from Node or enable pnpm with Corepack as declared by package.json",
  "ts:check-lane": "Fix lint/type/test failures; re-run task ts:check-lane",
  "vbrief:validate": "Fix xBRIEF/vBRIEF schema errors reported by the gate",
  "verify-strategy-output":
    "Re-run strategy output or fix non-conformant scope filenames / PROJECT-DEFINITION",
  "verify:test-boundary":
    "Move tests to the allowed placement or update plan.policy test-boundary allowlist",
  "verify:scope-provenance": "Record approved scope provenance for the failing paths",
  "verify:consumer-check-contract": "Align consumer Taskfile includes with the required gate graph",
  "verify:evaluator-surface":
    "Add xbrief/evaluator-surface-disposition.json covering the changed evaluator paths (disclosure only; not #3164 authorization)",
  "verify:observable-scope":
    "Restore the baseline markup structure or amend the observable scope through explicit human-presence mint (scope:record-observable-scope)",
  "verify:intent-constraint":
    "Link the hard constraint and rejection scope to a base-approved requirement or decision via scope:record-intent-constraint, or remove the behavior. Tests and in-scope file paths are not authority. Headless/C1 that adds a throw fails closed with no operator on the TTY.",
  "verify:consumer-test-lane":
    "Fix the project's declared test command, or set plan.policy.testCommand; do not invent a suite",
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

/** Suite gates the hang detector may wrap (#4230 / #4744). */
const SUITE_HANG_DETECTOR_GATES: ReadonlySet<string> = new Set([
  "ts:check-lane",
  "verify:consumer-test-lane",
]);

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
  hangTimeout?: boolean,
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
    .map((l) => stripAnsi(l).trim())
    .filter((l) => l.length > 0);
  const useful: string[] = [];
  for (const line of combined) {
    if (looksLikeEnvLeak(line)) continue;
    if (line.startsWith("check:")) continue;
    if (isGoTaskWrapperNoise(line)) continue;
    useful.push(line);
  }
  const hangCause = extractHangDetectorCause(useful, exitCode, gateId, hangTimeout);
  if (hangCause !== null) {
    return hangCause;
  }
  const gateHint = gateId?.trim() ?? "";
  if (gateHint === "toolchain:check" || gateHint === "toolchain:check-consumer") {
    const toolFailure = useful.find((line) =>
      /^(?:package manager|go|uv|git|gh|node|npm|pnpm|task): (?:NOT FOUND|FAILED|ERROR)\b/i.test(
        line,
      ),
    );
    if (toolFailure !== undefined) {
      return sanitizeCauseLine(toolFailure);
    }
  }
  // Prefer vitest summaries over earlier `FAIL:` CLI path prints (#4506).
  // `Tests N failed` wins when present; else `FAIL` + whitespace + test file.
  // Colon `FAIL:` path prints are not vitest-shaped.
  const testsFailed = useful.find((line) => /^Tests\s+\d+\s+failed/.test(line));
  if (testsFailed !== undefined) {
    return sanitizeCauseLine(testsFailed);
  }
  const vitestFailFile = useful.find((line) => /^FAIL\s+\S+\.(test|spec)\./.test(line));
  if (vitestFailFile !== undefined) {
    return sanitizeCauseLine(vitestFailFile);
  }
  const failureSignal = useful.find((line) => /\bFAIL\b/.test(line) || /\bTests?\b/.test(line));
  if (failureSignal !== undefined) {
    return sanitizeCauseLine(failureSignal);
  }
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

/** Strip CSI/SGR so vitest color still matches preferred summaries (#4506). */
function stripAnsi(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line.charCodeAt(i) !== 27 || line[i + 1] !== "[") {
      out += line[i];
      continue;
    }
    i += 2;
    while (i < line.length) {
      const code = line.charCodeAt(i);
      if (code >= 64 && code <= 126) break;
      i += 1;
    }
  }
  return out;
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

/** Last ts:check-lane last-file tick in captured output, if any (#4744). */
function lastCompletedTestFile(useful: readonly string[]): string | null {
  for (let i = useful.length - 1; i >= 0; i -= 1) {
    const line = useful[i] as string;
    const match = /^ts:check-lane last-file (.+) \((\d+)\/(\d+) files\)$/.exec(line);
    const file = match?.[1]?.trim() ?? "";
    if (file.length > 0) return file;
  }
  return null;
}

/**
 * Exit 124 is hang-detector only on the suite-gate path, an explicit hangTimeout
 * flag, or a last-file tick in the capture. A killed suite has no Tests N failed
 * summary, so a later FAIL: fixture print must not win (#4744).
 */
function extractHangDetectorCause(
  useful: readonly string[],
  exitCode: number,
  gateId?: string,
  hangTimeout?: boolean,
): string | null {
  if (exitCode !== 124) return null;
  const lastFile = lastCompletedTestFile(useful);
  const gateHint = gateId?.trim() ?? "";
  const hangPath =
    hangTimeout === true || SUITE_HANG_DETECTOR_GATES.has(gateHint) || lastFile !== null;
  if (!hangPath) return null;
  if (lastFile !== null) {
    return `hang detector timeout (exit 124); last completed test file: ${lastFile}`;
  }
  return "hang detector timeout (exit 124); last completed test file unknown";
}

export function remedyForGate(gateId: string, cause: string): string {
  if (/hang detector timeout/i.test(cause)) {
    return "Cheapen remaining Windows vitest --coverage cost; do not raise RELEASE_CHECK_TIMEOUT_MS";
  }
  if (/global deft\/directive CLI not found/i.test(cause)) {
    return CLI_SPAWN_ERROR_REMEDY;
  }
  if (/task binary not found|cannot spawn go-task/i.test(cause)) {
    if (
      gateId.startsWith("verify:") ||
      gateId.startsWith("verify-") ||
      gateId === "doctor" ||
      gateId === "toolchain:check-consumer"
    ) {
      return CLI_SPAWN_ERROR_REMEDY;
    }
    return SPAWN_ERROR_REMEDY;
  }
  if (/Unsupported DEFT_PACKAGE_MANAGER value/i.test(cause)) {
    return "Set DEFT_PACKAGE_MANAGER to npm or pnpm, or unset it to use package.json; then re-run the consumer check";
  }
  if (/\bpnpm(?: binary not found|: (?:NOT FOUND|FAILED|ERROR))/i.test(cause)) {
    return "Enable pnpm: corepack enable && corepack prepare pnpm@latest --activate";
  }
  if (/\bnpm(?: binary not found|: (?:NOT FOUND|FAILED|ERROR))/i.test(cause)) {
    return "Install or repair Node 20+ (npm is bundled), then re-run the consumer check";
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
  readonly hangTimeout?: boolean;
}): NamedCauseMessage {
  const cause = extractGateCause(
    input.stdout ?? "",
    input.stderr ?? "",
    input.exitCode,
    input.spawnError,
    input.gateId,
    input.hangTimeout,
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
