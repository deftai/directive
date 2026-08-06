/**
 * verify:consumer-check-contract evaluation (#3145).
 *
 * Fail closed when the consumer check task or required CI workflows omit
 * configured Directive enforcement gates (test-boundary, scope-provenance,
 * and other required surfaces). Emits a concrete repair path.
 *
 * Three-state exit: 0 clean / 1 missing gates / 2 config.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { taskDefinedInTaskfileYaml } from "../check/consumer-gate-integrity.js";
import { type CheckGateSpec, CONSUMER_CHECK_GATES, checkGateId } from "../check/gate-lists.js";

/** Gates that #3145 requires on consumer check composition (beyond baseline). */
export const REQUIRED_CONSUMER_ENFORCEMENT_GATES: readonly string[] = [
  "verify:test-boundary",
  "verify:scope-provenance",
  "verify:consumer-check-contract",
];

export interface ConsumerCheckContractFinding {
  readonly gateId: string;
  readonly surface: "check-task" | "ci-workflow" | "verify-taskfile";
  readonly detail: string;
  readonly remediation: string;
}

export interface ConsumerCheckContractResult {
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly ConsumerCheckContractFinding[];
  readonly message: string;
}

export interface ConsumerCheckContractOptions {
  /** Override required gates under test. */
  readonly requiredGates?: readonly string[];
  /** Inject Taskfile text (root). */
  readonly rootTaskfileText?: string | null;
  /** Inject tasks/verify.yml text. */
  readonly verifyTaskfileText?: string | null;
  /** Inject CI workflow file contents: relPath -> text. */
  readonly ciWorkflows?: ReadonlyMap<string, string>;
  /**
   * Framework-source self-check: gates live in FRAMEWORK_CHECK_GATES / check:framework-source.
   * When true, also accept framework aggregate composition.
   */
  readonly frameworkSource?: boolean;
  /** When true, missing CI references warn only (default true for migration). */
  readonly ciWarnOnly?: boolean;
  readonly enforce?: boolean;
}

function readText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Escape a string for safe inclusion in a RegExp source (CodeQL js/incomplete-sanitization). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `text` mentions the gate as a task dep, script, or CLI invocation. */
export function textReferencesGate(text: string, gateId: string): boolean {
  const forms = [
    gateId,
    gateId.replace(":", "-"),
    `task ${gateId}`,
    `deft ${gateId}`,
    `directive ${gateId}`,
  ];
  const lower = text.toLowerCase();
  return forms.some((f) => lower.includes(f.toLowerCase()));
}

/**
 * True when a shell line is only assignment(s) (no executed command).
 * `CHECK_CMD="task check"` is pure assignment; `FOO=1 task check` is not.
 * Linear scan (no nested regex quantifiers — CodeQL js/redos).
 */
export function isPureAssignmentLine(cmd: string): boolean {
  let t = cmd.trim();
  if (t.length === 0) return false;
  if (/(?:&&|\|\||;)/.test(t)) return false;
  // export NAME=value
  if (/^export\s+/i.test(t)) {
    t = t.replace(/^export\s+/i, "").trim();
  }
  // Consume one or more NAME=value tokens; refuse leftover command words.
  let i = 0;
  let sawAssign = false;
  while (i < t.length) {
    while (i < t.length && /\s/.test(t[i] ?? "")) i += 1;
    if (i >= t.length) break;
    // NAME=
    const nameMatch = /^[A-Za-z_][\w]*=/.exec(t.slice(i));
    if (nameMatch === null) {
      // leftover command → env-prefix form (not pure)
      return false;
    }
    i += nameMatch[0].length;
    sawAssign = true;
    const ch = t[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i += 1;
      while (i < t.length && t[i] !== q) i += 1;
      if (i >= t.length) return false; // unclosed quote
      i += 1; // closing quote
    } else {
      // bare value until whitespace
      while (i < t.length && !/\s/.test(t[i] ?? "")) i += 1;
    }
  }
  return sawAssign;
}

/**
 * True when a shell/task line does not execute gates (echo, comment, pure assign).
 * Greptile conf gate: non-executing text must not satisfy composition (#3145).
 */
export function isNonExecutingCommandLine(line: string): boolean {
  const stripped = line.trim();
  if (stripped.length === 0) return true;
  if (stripped.startsWith("#")) return true;
  // go-task list item: - echo "..."
  const cmd = stripped.replace(/^-\s+/, "");
  if (/^echo\b/i.test(cmd)) return true;
  // Pure assignment even when RHS contains runner phrases (Greptile conf=1).
  if (isPureAssignmentLine(cmd)) return true;
  return false;
}

/** Executable run/script command lines from a workflow (skips comments). */
export function extractWorkflowRunCommands(text: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const m = stripped.match(/^(?:-\s*)?(?:run|script)\s*:\s*(.*)$/i);
    if (m === null) continue;
    const rest = (m[1] ?? "").trim();
    // Block scalar: run: | or run: >
    if (rest === "|" || rest === ">" || rest.startsWith("|") || rest.startsWith(">")) {
      const indent = raw.length - raw.trimStart().length;
      const body: string[] = [];
      let bodyBaseIndent: number | null = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        const lr = lines[j] ?? "";
        if (lr.trim().length === 0) {
          body.push("");
          continue;
        }
        const li = lr.length - lr.trimStart().length;
        if (li <= indent) break;
        if (bodyBaseIndent === null) bodyBaseIndent = li;
        body.push(lr.slice(bodyBaseIndent));
        i = j;
      }
      const joined = body.join("\n").trim();
      if (joined.length > 0) out.push(joined);
      continue;
    }
    if (rest.length > 0) {
      // Only strip outer wrapping quotes on the whole scalar — not a trailing
      // quote that closes an assignment value (CHECK_CMD="task check").
      let scalar = rest;
      if (
        (scalar.startsWith('"') && scalar.endsWith('"') && scalar.length >= 2) ||
        (scalar.startsWith("'") && scalar.endsWith("'") && scalar.length >= 2)
      ) {
        scalar = scalar.slice(1, -1);
      }
      out.push(scalar.trim());
    }
  }
  return out;
}

/**
 * Strip simple single/double-quoted segments so runner phrases inside printf/args
 * do not impersonate command-position invocations (Greptile conf=1).
 */
export function stripQuotedSegments(line: string): string {
  return line.replace(/'[^']*'|"[^"]*"/g, " ");
}

/**
 * True when a shell line discards or defers the primary command's exit status
 * via `||`, pipelines, `;` chains, or job-control backgrounding. Used for
 * dispatcher tokens that do not match the check-specific mask predicate.
 */
export function lineMasksShellStatus(line: string): boolean {
  const lower = stripQuotedSegments(line).toLowerCase();
  if (/\|\|/.test(lower)) return true;
  // Pipeline `|` but not `||` (already handled) and not fd redirs `2>&1` / `>&2`.
  const noFd = lower.replace(/\d*>&?\d+/g, " ").replace(/>&\d+/g, " ").replace(/&>\S*/g, " ");
  if (/\|/.test(noFd)) return true;
  if (/;/.test(lower)) return true;
  if (lineHasBackgroundJob(line)) return true;
  return false;
}

/**
 * True when a shell line uses job-control backgrounding (`cmd &`, `cmd & next`)
 * as opposed to fd redirection (`2>&1`, `&>file`). Backgrounded jobs return
 * before completion and do not propagate exit status — must not satisfy
 * composition (Greptile conf=3/4 residual, #3145).
 */
export function lineHasBackgroundJob(line: string): boolean {
  const s = stripQuotedSegments(line);
  // Strip common fd redirections that contain `&` without job control.
  const withoutRedir = s
    .replace(/\d*>&?\d+/g, " ")
    .replace(/&>\S*/g, " ")
    .replace(/>&\d+/g, " ");
  // Bare `&` that is not part of `&&`: trailing, or followed by another token.
  if (/(?:^|[^&])&\s*(?:#.*)?$/.test(withoutRedir)) return true;
  if (/(?:^|[^&])&\s+\S/.test(withoutRedir)) return true;
  return false;
}

/**
 * True when a shell line masks check failures (`|| true`, `| true`, `|| :`).
 * Such lines must not satisfy composition (Greptile conf=3).
 */
export function lineMasksCheckFailure(line: string): boolean {
  const lower = stripQuotedSegments(line).toLowerCase();
  const checkish =
    /(?:deft|directive)\s+check\b|task\s+(?:deft:)?check\b|(?:task\s+)?check:(?:consumer|framework-source)\b/;
  if (!checkish.test(lower)) return false;
  // Any pipeline after a check can hide nonzero status without pipefail (Greptile).
  if (/check\b[\s\S]*\|/.test(lower)) return true;
  // Any `|| fallback` after a check discards the check's exit status (Greptile conf=4).
  // Includes `|| true`, `|| :`, `|| echo ignored`, `|| exit 0`, etc.
  if (/check\b[\s\S]*\|\|/.test(lower)) return true;
  // Semicolon chain after check: `deft check; echo ignored` masks failure (Greptile conf=2).
  if (/check\b[\s\S]*;/.test(lower)) return true;
  // Background job after check (including mid-line `& echo done`).
  if (lineHasBackgroundJob(line)) return true;
  return false;
}

/**
 * True when `line` invokes a runner at command position (start / after chain),
 * not merely mentions it inside an argument, and does not mask failures.
 */
export function lineHasCommandPositionRunner(
  line: string,
  runnerPattern: RegExp,
): boolean {
  if (lineMasksCheckFailure(line)) return false;
  // Backgrounded gates/runners are not awaited (covers verify:* & forms too).
  if (lineHasBackgroundJob(line)) return false;
  const lower = stripQuotedSegments(line).toLowerCase().trim().replace(/^-\s+/, "");
  if (lower.length === 0) return false;
  // Known argument-only tools never execute our gates.
  if (/^(?:printf|print|echo|cat|true|false|:|test|\[)\b/.test(lower)) return false;
  // Command position: line start or after shell chain / env-prefix assignments.
  const withoutEnv = lower.replace(/^(?:[a-z_][\w]*=(?:\S+)\s+)*/i, "");
  if (runnerPattern.test(withoutEnv)) return true;
  // Chained: ... && task check  (but not || true — already rejected above)
  const chainParts = withoutEnv.split(/(?:&&|\|\||;)/);
  return chainParts.some((part) => runnerPattern.test(part.trim()));
}

/** True when a run command is a full check aggregate (not a single verify gate). */
export function runCommandIsFullCheck(cmd: string): boolean {
  // Scan executable lines only — echo/docs/printf-args do not execute gates.
  for (const raw of cmd.split("\n")) {
    if (isNonExecutingCommandLine(raw)) continue;
    const line = raw.trim().replace(/^-\s+/, "");
    // Word-boundary / command-position matches only.
    if (
      lineHasCommandPositionRunner(line, /^(?:sudo\s+)?(?:deft|directive)\s+check\b/)
    ) {
      return true;
    }
    if (lineHasCommandPositionRunner(line, /^(?:sudo\s+)?task\s+(?:deft:)?check\b/)) {
      return true;
    }
    if (
      lineHasCommandPositionRunner(
        line,
        /^(?:sudo\s+)?(?:task\s+)?check:consumer(?:\s|$)/,
      )
    ) {
      return true;
    }
    if (
      lineHasCommandPositionRunner(
        line,
        /^(?:sudo\s+)?(?:task\s+)?check:framework-source(?:\s|$)/,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when a run command invokes a specific verify gate id as an executable
 * task/CLI form — not a bare substring in echo/docs/printf args.
 */
export function runCommandInvokesGate(cmd: string, gateId: string): boolean {
  const gid = gateId.toLowerCase();
  const dashed = gateId.replace(":", "-").toLowerCase();
  const invokers = [
    new RegExp(`^(?:sudo\\s+)?(?:task|deft|directive)\\s+(?:deft:)?${escapeRegExp(gid)}\\b`, "i"),
    new RegExp(
      `^(?:sudo\\s+)?(?:task|deft|directive)\\s+(?:deft:)?${escapeRegExp(dashed)}\\b`,
      "i",
    ),
    new RegExp(`^(?:sudo\\s+)?npm\\s+run\\s+${escapeRegExp(gid)}\\b`, "i"),
  ];
  for (const raw of cmd.split("\n")) {
    if (isNonExecutingCommandLine(raw)) continue;
    const line = raw.trim().replace(/^-\s+/, "");
    if (invokers.some((re) => lineHasCommandPositionRunner(line, re))) return true;
  }
  return false;
}

/**
 * True when CI/workflow text has an executable `run:` line that invokes the full
 * check aggregate (not a single gate, not prose) — Greptile P1.
 */
export function workflowExecutesCheck(text: string): boolean {
  return extractWorkflowRunCommands(text).some(runCommandIsFullCheck);
}

/** Extract the body of a top-level go-task task (indent=2 key). */
export function extractTaskBody(taskfileText: string, taskName: string): string {
  const lines = taskfileText.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  let inTask = false;
  let taskIndent = 0;
  const taskRe = new RegExp(`^${escapeRegExp(taskName)}\\s*:`);
  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) {
      if (inTask) body.push(raw);
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (!inTask) {
      if (taskRe.test(stripped) && indent <= 2) {
        inTask = true;
        taskIndent = indent;
      }
      continue;
    }
    if (indent <= taskIndent && /^[\w:-]+:/.test(stripped)) {
      break;
    }
    body.push(raw);
  }
  return body.join("\n");
}

/**
 * Drop YAML/shell comment lines (and trailing `# ...` on otherwise empty marker
 * lines) before orchestrator matching so commented markers cannot grant trust.
 */
export function stripTaskBodyComments(body: string): string {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    // Full-line list item that is only a comment: - # ...
    if (/^-\s+#/.test(stripped)) continue;
    out.push(raw);
  }
  return out.join("\n");
}

/**
 * True when a Taskfile task body actually dispatches the check orchestrator.
 * ENGINE_CMD alone is inert metadata — require engine:invoke / dispatchTaskCheck
 * (or a command-position runner) so inert YAML cannot grant trust (Greptile).
 * Comments are stripped first so commented markers cannot bypass (Greptile conf=3).
 */
export function taskBodyInvokesCheckOrchestrator(body: string): boolean {
  if (body.trim().length === 0) return false;
  const live = stripTaskBodyComments(body);
  if (live.trim().length === 0) return false;

  let hasEngineInvoke = false;
  let hasDispatch = false;
  let hasEngineCheckCmd = false;
  let hasCommandRunner = false;

  for (const raw of live.split("\n")) {
    const stripped = raw.trim();
    if (!stripped) continue;
    if (isNonExecutingCommandLine(stripped)) continue;
    if (lineMasksCheckFailure(stripped)) continue;
    // YAML go-task form only: "- task: engine:invoke" (not inert ENGINE_INVOKE: keys).
    if (/^(?:-\s*)?task:\s*engine:invoke\b/.test(stripped)) {
      hasEngineInvoke = true;
    }
    // Exact YAML key form (not ENGINE_CMD_DOCS: or assignment noise).
    if (/^ENGINE_CMD:\s*['"]?check\b/.test(stripped)) {
      hasEngineCheckCmd = true;
    }
    // dispatchTaskCheck only as the command being invoked (not an arbitrary arg).
    const cmd = stripped.replace(/^-\s+/, "");
    const unquoted = stripQuotedSegments(cmd).trim();
    // Forms: dispatchTaskCheck ... | node path/dispatchTaskCheck.js | npx ...dispatchTaskCheck
    // Failure-masked dispatchers (`|| true`, pipelines, `;`, background) must not grant
    // orchestrator trust — same class as masked `task check` (Greptile conf=2, #3145).
    if (
      !lineMasksShellStatus(cmd) &&
      (/^(?:sudo\s+)?dispatchTaskCheck\b/.test(unquoted) ||
        /^(?:sudo\s+)?(?:node|npx)\s+\S*dispatchTaskCheck\S*/.test(unquoted))
    ) {
      hasDispatch = true;
    }
    if (
      lineHasCommandPositionRunner(cmd, /^(?:sudo\s+)?(?:deft|directive)\s+check\b/) ||
      lineHasCommandPositionRunner(cmd, /^(?:sudo\s+)?task\s+(?:deft:)?check\b/)
    ) {
      hasCommandRunner = true;
    }
  }

  // Framework Taskfile pattern: task: engine:invoke + ENGINE_CMD: 'check ...'
  if (hasEngineInvoke && hasEngineCheckCmd) return true;
  if (hasDispatch && hasEngineCheckCmd) return true;
  if (hasDispatch) return true;
  if (hasCommandRunner) return true;
  return false;
}

/** True when the check / check:consumer / check:framework-source task invokes orchestrator. */
export function taskfileInvokesCheckOrchestrator(text: string): boolean {
  for (const taskName of ["check", "check:consumer", "check:framework-source"]) {
    const body = extractTaskBody(text, taskName);
    if (taskBodyInvokesCheckOrchestrator(body)) return true;
  }
  return false;
}

/**
 * Extract dependency task names from a go-task task definition body snippet.
 * Best-effort line parser for `deps:` list entries.
 */
export function extractCheckDeps(taskfileText: string, taskName: string): string[] {
  const lines = taskfileText.replace(/\r\n/g, "\n").split("\n");
  const deps: string[] = [];
  let inTask = false;
  let taskIndent = 0;
  let inDeps = false;
  let depsIndent = 0;
  const taskRe = new RegExp(`^${escapeRegExp(taskName)}\\s*:`);

  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (!inTask) {
      if (taskRe.test(stripped) && indent === 2) {
        inTask = true;
        taskIndent = indent;
      }
      continue;
    }

    if (indent <= taskIndent && !stripped.startsWith("#") && /^[\w-]+:/.test(stripped)) {
      break;
    }

    if (/^deps\s*:/.test(stripped)) {
      inDeps = true;
      depsIndent = indent;
      continue;
    }

    if (inDeps) {
      if (indent <= depsIndent && !stripped.startsWith("-")) {
        inDeps = false;
      } else if (stripped.startsWith("-")) {
        // - verify:branch  OR  - task: verify:branch
        const m =
          stripped.match(/^-\s+task:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/) ??
          stripped.match(/^-\s+["']?([^"'#]+?)["']?\s*(?:#.*)?$/);
        if (m?.[1]) {
          deps.push(m[1].trim());
        }
      }
    }
  }
  return deps;
}

function remediationForMissing(gateId: string, surface: string): string {
  return (
    `Add \`${gateId}\` to the consumer ${surface} composition (Taskfile check deps ` +
    `and/or CI workflow invoking \`deft check\` / \`task ${gateId}\`). ` +
    "See content/docs/consumer-check-contract.md (#3145)."
  );
}

function configError(message: string): ConsumerCheckContractResult {
  return { exitCode: 2, findings: [], message };
}

/**
 * Evaluate whether required enforcement gates are composed into consumer check/CI.
 */
export function evaluateConsumerCheckContract(
  projectRoot: string,
  options: ConsumerCheckContractOptions = {},
): ConsumerCheckContractResult {
  const root = resolve(projectRoot);
  const required = options.requiredGates ?? REQUIRED_CONSUMER_ENFORCEMENT_GATES;
  const ciWarnOnly = options.ciWarnOnly ?? true;
  const enforce = options.enforce ?? true;

  const rootTfPath = join(root, "Taskfile.yml");
  const verifyTfPath = join(root, "tasks", "verify.yml");

  const rootText =
    options.rootTaskfileText !== undefined ? options.rootTaskfileText : readText(rootTfPath);
  const verifyText =
    options.verifyTaskfileText !== undefined ? options.verifyTaskfileText : readText(verifyTfPath);

  // If no Taskfile at all, config error only when enforce (else skip clean for non-task projects)
  if (rootText === null && options.rootTaskfileText === undefined) {
    if (!existsSync(rootTfPath) && options.frameworkSource !== true) {
      return {
        exitCode: 0,
        findings: [],
        message:
          "verify_consumer_check_contract: no Taskfile.yml found -- skipped (not a task-based consumer).",
      };
    }
  }

  if (rootText === null) {
    return configError(
      "verify_consumer_check_contract: Taskfile.yml unreadable.\n" +
        "  Recovery: restore Taskfile.yml or run from the project root.",
    );
  }
  // Narrow for nested helpers (TS does not carry null-check into closures).
  const rootTaskfile: string = rootText;

  const findings: ConsumerCheckContractFinding[] = [];
  const soft: ConsumerCheckContractFinding[] = [];

  // 1) verify.yml must define the local task keys for required gates
  if (verifyText !== null) {
    for (const gateId of required) {
      if (!gateId.startsWith("verify:")) continue;
      const local = gateId.slice("verify:".length);
      if (!taskDefinedInTaskfileYaml(verifyText, local)) {
        findings.push({
          gateId,
          surface: "verify-taskfile",
          detail: `tasks/verify.yml does not define task '${local}' for ${gateId}`,
          remediation: remediationForMissing(gateId, "tasks/verify.yml"),
        });
      }
    }
  } else if (options.frameworkSource === true || existsSync(join(root, "tasks"))) {
    findings.push({
      gateId: "verify:*",
      surface: "verify-taskfile",
      detail: "tasks/verify.yml missing while tasks/ directory or framework-source expected",
      remediation:
        "Restore tasks/verify.yml via `deft update` deposit repair. See UPGRADING.md (#3145).",
    });
  }

  // 2) Each defined check aggregate must compose required gates OR invoke full deft check.
  // Do NOT union deps across check / check:consumer / check:framework-source — a sibling
  // with full deps must not conceal omissions on the aggregate that actually runs (Greptile).
  const checkTargets = ["check", "check:consumer", "check:framework-source"] as const;

  const verifyDefinesRequired =
    verifyText !== null &&
    required.every((gateId) => {
      if (!gateId.startsWith("verify:")) return true;
      return taskDefinedInTaskfileYaml(verifyText, gateId.slice("verify:".length));
    });

  /** Exact dep match only — never substring (noop-verify:test-boundary must not count). */
  function depListsGate(deps: readonly string[], gateId: string): boolean {
    for (const d of deps) {
      const name = d.trim();
      if (name === gateId) return true;
      // go-task object form may normalize to bare task name already via extractCheckDeps
      if (name === `task ${gateId}` || name === `task:${gateId}`) return true;
    }
    return false;
  }

  /** True when this task body alone invokes the check orchestrator (not whole file). */
  function taskInvokesOrchestrator(taskName: string): boolean {
    return taskBodyInvokesCheckOrchestrator(extractTaskBody(rootTaskfile, taskName));
  }

  let anyAggregateDefined = false;
  for (const target of checkTargets) {
    const deps = extractCheckDeps(rootTaskfile, target);
    const body = extractTaskBody(rootTaskfile, target);
    const defined = deps.length > 0 || body.trim().length > 0;
    if (!defined) continue;
    anyAggregateDefined = true;

    const trustThis = taskInvokesOrchestrator(target) && verifyDefinesRequired;
    if (trustThis) continue;

    for (const gateId of required) {
      if (!depListsGate(deps, gateId)) {
        findings.push({
          gateId,
          surface: "check-task",
          detail:
            deps.length === 0
              ? `aggregate '${target}' has no deps and does not invoke a full check orchestrator covering ${gateId}`
              : `aggregate '${target}' deps do not include ${gateId}`,
          remediation: remediationForMissing(gateId, `check task (${target})`),
        });
      }
    }
  }

  // No check aggregates defined at all — still a composition gap when enforce
  // (unless trust via whole-file orchestrator is impossible without a body).
  if (!anyAggregateDefined) {
    // Preserve prior behavior for empty/missing check tasks: fail each required gate.
    const invokesAny = taskfileInvokesCheckOrchestrator(rootTaskfile);
    if (!(invokesAny && verifyDefinesRequired)) {
      for (const gateId of required) {
        findings.push({
          gateId,
          surface: "check-task",
          detail: `check aggregate has no deps and does not invoke a full check orchestrator covering ${gateId}`,
          remediation: remediationForMissing(gateId, "check task"),
        });
      }
    }
  }

  // Framework source: FRAMEWORK_CHECK_GATES should include the trio when enforce
  if (options.frameworkSource === true) {
    const baselineIds = CONSUMER_CHECK_GATES.map(checkGateId);
    void baselineIds;
    // Framework wiring is validated via verify.yml definitions (step 1) + gate-lists unit tests.
  }

  // 3) CI workflows (soft by default)
  let workflows: ReadonlyMap<string, string>;
  if (options.ciWorkflows !== undefined) {
    workflows = options.ciWorkflows;
  } else {
    const map = new Map<string, string>();
    const wfDir = join(root, ".github", "workflows");
    if (existsSync(wfDir)) {
      for (const name of readdirSync(wfDir)) {
        if (!/\.ya?ml$/i.test(name)) continue;
        const text = readText(join(wfDir, name));
        if (text !== null) map.set(`.github/workflows/${name}`, text);
      }
    }
    workflows = map;
  }

  if (workflows.size > 0) {
    const allCi = [...workflows.values()].join("\n");
    const runCmds = extractWorkflowRunCommands(allCi);
    const fullCheck =
      runCmds.some(runCommandIsFullCheck) &&
      verifyText !== null &&
      required.every((gateId) => {
        if (!gateId.startsWith("verify:")) return true;
        return taskDefinedInTaskfileYaml(verifyText, gateId.slice("verify:".length));
      });

    for (const gateId of required) {
      const direct = runCmds.some((c) => runCommandInvokesGate(c, gateId));
      // Single gate does NOT satisfy the whole trio (Greptile P1).
      const mentioned = direct || fullCheck;
      if (!mentioned) {
        const finding: ConsumerCheckContractFinding = {
          gateId,
          surface: "ci-workflow",
          detail: `CI workflows do not invoke ${gateId} or a full check entrypoint that composes it`,
          remediation: remediationForMissing(gateId, "CI workflow"),
        };
        if (ciWarnOnly) soft.push(finding);
        else findings.push(finding);
      }
    }
  }

  if (findings.length === 0 && soft.length === 0) {
    return {
      exitCode: 0,
      findings: [],
      message: `verify_consumer_check_contract: clean (${required.length} required gate(s) composed) (#3145).`,
    };
  }

  if (findings.length === 0) {
    const body = soft
      .map(
        (f) => `  ${f.gateId} [${f.surface}]\n    ${f.detail}\n    remediation: ${f.remediation}`,
      )
      .join("\n");
    return {
      exitCode: 0,
      findings: soft,
      message:
        `verify_consumer_check_contract: WARN ${soft.length} CI composition note(s) ` +
        `(not failing) (#3145).\n${body}`,
    };
  }

  if (!enforce) {
    const all = [...findings, ...soft];
    const body = all
      .map(
        (f) => `  ${f.gateId} [${f.surface}]\n    ${f.detail}\n    remediation: ${f.remediation}`,
      )
      .join("\n");
    return {
      exitCode: 0,
      findings: all,
      message: `verify_consumer_check_contract: WARN ${all.length} finding(s) (enforce off) (#3145).\n${body}`,
    };
  }

  const all = [...findings, ...soft];
  const body = all
    .map((f) => `  ${f.gateId} [${f.surface}]\n    ${f.detail}\n    remediation: ${f.remediation}`)
    .join("\n");

  return {
    exitCode: 1,
    findings: all,
    message: `verify_consumer_check_contract: ${findings.length} missing required gate(s) (#3145).\n${body}`,
  };
}

/** Exported for tests — gate list helper. */
export function requiredGatesFromConsumerList(
  gates: readonly CheckGateSpec[] = CONSUMER_CHECK_GATES,
): string[] {
  const ids = gates.map(checkGateId);
  return REQUIRED_CONSUMER_ENFORCEMENT_GATES.filter((g) => ids.includes(g));
}
