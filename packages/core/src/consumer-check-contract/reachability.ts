/**
 * Gate reachability on pull_request for verify:consumer-check-contract (#4015).
 *
 * Parses each consumer workflow as a YAML job graph (not concatenated text).
 * Command extraction stays in evaluate.ts — callers pass run commands per job
 * via {@link attachRunCommands} / finding helpers so extractors are not forked.
 */

export type ReachabilityKind =
  | "skippable-if"
  | "continue-on-error"
  | "matrix-exclude"
  | "workflow-filter"
  | "unknown-uses"
  | "unknown-expression";

export interface ReachabilityFinding {
  readonly kind: ReachabilityKind;
  readonly workflowPath: string;
  readonly jobId: string | null;
  readonly detail: string;
  readonly remediation: string;
}

/** Job/step continue-on-error: literal false/true, or undecidable expression. */
export type ContinueOnErrorClass = false | true | "unknown";

export interface WorkflowStepNode {
  readonly ifExpr: string | null;
  readonly continueOnError: ContinueOnErrorClass;
  readonly runText: string | null;
}

export interface WorkflowJobNode {
  readonly id: string;
  readonly body: string;
  readonly ifExpr: string | null;
  readonly continueOnError: ContinueOnErrorClass;
  readonly hasMatrixExclude: boolean;
  readonly jobUses: string | null;
  readonly stepUses: readonly string[];
  /** Steps under `steps:` (for step-level if: / continue-on-error on gate runs). */
  readonly steps: readonly WorkflowStepNode[];
  /** Filled by caller via {@link attachRunCommands} (reuses evaluate extractors). */
  readonly runCommands: readonly string[];
}

export interface WorkflowPullRequestFilters {
  readonly hasPaths: boolean;
  readonly hasPathsIgnore: boolean;
  readonly hasBranches: boolean;
}

export interface WorkflowJobGraph {
  readonly jobs: readonly WorkflowJobNode[];
  readonly pullRequestFilters: WorkflowPullRequestFilters;
  readonly hasPullRequestTrigger: boolean;
}

export type ConditionClass = "accept" | "skippable" | "unknown";

/** Strip `${{ }}` wrappers and collapse whitespace for condition matching. */
export function normalizeGithubExpression(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 3; i += 1) {
    const m = s.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
    if (m === null) break;
    s = (m[1] ?? "").trim();
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Classify a job-level `if:` for pull_request reachability.
 * Accept: absent, always(), true, or PR-true-by-construction.
 * Unknown: github.event.* / vars / secrets (not statically decidable).
 * Skippable: anything else that can evaluate false on pull_request.
 */
export function classifyPullRequestCondition(ifExpr: string | null): ConditionClass {
  if (ifExpr === null) return "accept";
  const expr = normalizeGithubExpression(ifExpr);
  if (expr.length === 0) return "accept";
  const lower = expr.toLowerCase();

  if (lower === "always()" || lower === "true" || lower === "1") return "accept";

  if (/\bvars\s*\./.test(lower) || /\bsecrets\s*\./.test(lower)) return "unknown";
  if (/\bgithub\.event\s*\./.test(lower)) return "unknown";

  if (
    /^github\.event_name\s*==\s*['"]pull_request['"]$/.test(lower) ||
    /^['"]pull_request['"]\s*==\s*github\.event_name$/.test(lower) ||
    /^contains\s*\(\s*github\.event_name\s*,\s*['"]pull_request['"]\s*\)$/.test(lower)
  ) {
    return "accept";
  }

  // `always() && needs.…` can still be false on pull_request (output gates, etc.).
  return "skippable";
}

function parseContinueOnErrorValue(raw: string): ContinueOnErrorClass {
  const v = parseScalarRemainder(raw).trim();
  if (v.length === 0) return false;
  const normalized = normalizeGithubExpression(v).toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return "unknown";
}

function parseIfScalar(
  rest: string,
  lines: readonly string[],
  lineIndex: number,
  indent: number,
): string {
  const trimmed = rest.trim();
  if (trimmed === "|" || trimmed === ">" || trimmed.startsWith("|") || trimmed.startsWith(">")) {
    const collected: string[] = [];
    for (let j = lineIndex + 1; j < lines.length; j += 1) {
      const lr = lines[j] ?? "";
      if (lr.trim().length === 0) continue;
      if (lineIndent(lr) <= indent) break;
      collected.push(lr.trim());
    }
    return collected.join(" ");
  }
  return parseScalarRemainder(trimmed);
}

function lineIndent(raw: string): number {
  return raw.length - raw.trimStart().length;
}

function stripInlineComment(raw: string): string {
  const hash = raw.indexOf(" #");
  return (hash === -1 ? raw : raw.slice(0, hash)).trimEnd();
}

function parseScalarRemainder(rest: string): string {
  const t = stripInlineComment(rest).trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function extractTopLevelBlock(lines: readonly string[], key: string): string[] {
  const keyRe = new RegExp(`^${key}\\s*:`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = (lines[i] ?? "").trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (keyRe.test(stripped) && lineIndent(lines[i] ?? "") === 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) {
      out.push(raw);
      continue;
    }
    if (lineIndent(raw) === 0 && /^[\w"'][\w"'.-]*\s*:/.test(stripped)) break;
    out.push(raw);
  }
  return out;
}

function onMentionsPullRequest(onLines: readonly string[]): boolean {
  // Comments must not count as triggers (quoted 'on': + "# …pull_request…" false clean).
  for (const raw of onLines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (/\bpull_request\b/i.test(stripInlineComment(stripped))) return true;
  }
  return false;
}

function parsePullRequestFilters(onLines: readonly string[]): WorkflowPullRequestFilters {
  let prIndent: number | null = null;
  let inPr = false;
  let hasPaths = false;
  let hasPathsIgnore = false;
  let hasBranches = false;

  for (const raw of onLines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = lineIndent(raw);

    if (inPr && prIndent !== null && indent <= prIndent && /^[\w"']/.test(stripped)) {
      inPr = false;
      prIndent = null;
    }

    const prKey = /^['"]?pull_request['"]?\s*:\s*(.*)$/i.exec(stripped);
    if (prKey !== null) {
      inPr = true;
      prIndent = indent;
      const inline = (prKey[1] ?? "").toLowerCase();
      if (/\bpaths-ignore\b/.test(inline)) hasPathsIgnore = true;
      // `paths` but not the `paths-ignore` token (word-boundary on paths alone is too wide).
      if (/(?:^|[\s,{])paths\s*:/.test(inline) || /(?:^|[\s,{])paths\s*[[]/.test(inline)) {
        hasPaths = true;
      }
      if (/\bbranches\b/.test(inline)) hasBranches = true;
      continue;
    }

    if (!inPr || prIndent === null) continue;
    if (indent <= prIndent) continue;

    if (/^['"]?paths-ignore['"]?\s*:/i.test(stripped)) hasPathsIgnore = true;
    else if (/^['"]?paths['"]?\s*:/i.test(stripped)) hasPaths = true;
    if (/^['"]?branches(-ignore)?['"]?\s*:/i.test(stripped)) hasBranches = true;
  }

  return { hasPaths, hasPathsIgnore, hasBranches };
}

function parseJobNodes(jobBlockLines: readonly string[]): WorkflowJobNode[] {
  const jobs: WorkflowJobNode[] = [];
  let currentId: string | null = null;
  let currentLines: string[] = [];
  let jobIndent: number | null = null;

  const flush = (): void => {
    if (currentId === null) return;
    jobs.push(buildJobNode(currentId, currentLines.join("\n")));
    currentId = null;
    currentLines = [];
    jobIndent = null;
  };

  for (const raw of jobBlockLines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) {
      if (currentId !== null) currentLines.push(raw);
      continue;
    }
    const indent = lineIndent(raw);
    // Quoted keys (`"check":` / `'check':`) are valid workflow job ids.
    const jobKey = /^(?:["']([A-Za-z_][\w-]*)["']|([A-Za-z_][\w-]*))\s*:\s*(?:#.*)?$/.exec(
      stripped,
    );
    if (jobKey !== null && (jobIndent === null || indent === jobIndent || currentId === null)) {
      if (currentId === null) jobIndent = indent;
      if (indent === jobIndent) {
        flush();
        currentId = jobKey[1] ?? jobKey[2] ?? null;
        currentLines = [];
        continue;
      }
    }
    if (currentId !== null) currentLines.push(raw);
  }
  flush();
  return jobs;
}

function readBlockOrScalarRun(
  runRest: string,
  lines: readonly string[],
  lineIndex: number,
  indent: number,
): string | null {
  const trimmed = runRest.trim();
  if (trimmed === "|" || trimmed === ">" || trimmed.startsWith("|") || trimmed.startsWith(">")) {
    const collected: string[] = [];
    for (let j = lineIndex + 1; j < lines.length; j += 1) {
      const lr = lines[j] ?? "";
      if (lr.trim().length === 0) continue;
      if (lineIndent(lr) <= indent) break;
      collected.push(lr.trim());
    }
    const joined = collected.join("\n");
    return joined.length > 0 ? joined : null;
  }
  if (trimmed.length === 0) return null;
  return parseScalarRemainder(trimmed);
}

/** True when env:/with: value continues as a nested block (not inline scalar/flow). */
function opensNestedStepMap(valueRest: string): boolean {
  const rest = valueRest.trim();
  if (rest.length === 0) return true;
  if (rest === "|" || rest === ">" || rest.startsWith("|") || rest.startsWith(">")) return true;
  return false;
}

function parseJobSteps(lines: readonly string[], baseIndent: number | null): WorkflowStepNode[] {
  if (baseIndent === null) return [];
  // `steps:` is a job-level key (same indent as if: / runs-on:).
  let stepsKeyIndent: number | null = null;
  let stepsStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = lineIndent(raw);
    if (indent === baseIndent && /^steps\s*:/i.test(stripped)) {
      stepsKeyIndent = indent;
      stepsStart = i + 1;
      break;
    }
  }
  if (stepsKeyIndent === null || stepsStart < 0) return [];

  const steps: WorkflowStepNode[] = [];
  let inStep = false;
  let itemIndent: number | null = null;
  /** Indent of direct step keys (`if:`/`run:`/`env:`); nested map keys are deeper. */
  let stepFieldIndent: number | null = null;
  /** While set, skip lines deeper than this nest key (env:/with: children). */
  let nestKeyIndent: number | null = null;
  let stepIf: string | null = null;
  let stepCoe: ContinueOnErrorClass = false;
  let stepRun: string | null = null;

  const flushStep = (): void => {
    if (!inStep) return;
    steps.push({ ifExpr: stepIf, continueOnError: stepCoe, runText: stepRun });
    inStep = false;
    itemIndent = null;
    stepFieldIndent = null;
    nestKeyIndent = null;
    stepIf = null;
    stepCoe = false;
    stepRun = null;
  };

  for (let i = stepsStart; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = lineIndent(raw);

    // Sibling job-level key ends the steps block.
    if (indent <= stepsKeyIndent) {
      flushStep();
      break;
    }

    const listItem = /^-\s+(.*)$/.exec(stripped);
    if (listItem !== null && (itemIndent === null || indent === itemIndent)) {
      flushStep();
      inStep = true;
      itemIndent = indent;
      const rest = (listItem[1] ?? "").trim();
      // `- env:` / `- with:` — sibling fields align with the key after `- `.
      const nestInline = /^(?:env|with)\s*:\s*(.*)$/i.exec(rest);
      if (nestInline !== null) {
        const dashPrefix = /^-\s+/.exec(stripped);
        const fieldIndent = indent + (dashPrefix?.[0].length ?? 2);
        stepFieldIndent = fieldIndent;
        if (opensNestedStepMap(nestInline[1] ?? "")) nestKeyIndent = fieldIndent;
      }
      const inlineIf = /^if\s*:\s*(.*)$/i.exec(rest);
      if (inlineIf !== null) stepIf = parseIfScalar(inlineIf[1] ?? "", lines, i, indent);
      const inlineCoe = /^continue-on-error\s*:\s*(.*)$/i.exec(rest);
      if (inlineCoe !== null) stepCoe = parseContinueOnErrorValue(inlineCoe[1] ?? "");
      const inlineRun = /^(?:run|script)\s*:\s*(.*)$/i.exec(rest);
      if (inlineRun !== null) stepRun = readBlockOrScalarRun(inlineRun[1] ?? "", lines, i, indent);
      continue;
    }

    if (!inStep || itemIndent === null || indent <= itemIndent) continue;

    // Leave env:/with: nest when indent returns to the nest key column.
    if (nestKeyIndent !== null && indent <= nestKeyIndent) {
      nestKeyIndent = null;
    }
    if (nestKeyIndent !== null) continue;

    // Open nest for block-form env:/with: without locking indent from nested children.
    const nestField = /^(?:env|with)\s*:\s*(.*)$/i.exec(stripped);
    if (nestField !== null) {
      if (stepFieldIndent === null) stepFieldIndent = indent;
      if (indent !== stepFieldIndent) continue;
      if (opensNestedStepMap(nestField[1] ?? "")) nestKeyIndent = indent;
      continue;
    }

    // Only known direct step fields set/use stepFieldIndent (not nested map values).
    const ifMatch = /^if\s*:\s*(.*)$/i.exec(stripped);
    if (ifMatch !== null) {
      if (stepFieldIndent === null) stepFieldIndent = indent;
      if (indent !== stepFieldIndent) continue;
      stepIf = parseIfScalar(ifMatch[1] ?? "", lines, i, indent);
      continue;
    }
    const coe = /^continue-on-error\s*:\s*(.*)$/i.exec(stripped);
    if (coe !== null) {
      if (stepFieldIndent === null) stepFieldIndent = indent;
      if (indent !== stepFieldIndent) continue;
      stepCoe = parseContinueOnErrorValue(coe[1] ?? "");
      continue;
    }
    const runMatch = /^(?:run|script)\s*:\s*(.*)$/i.exec(stripped);
    if (runMatch !== null) {
      if (stepFieldIndent === null) stepFieldIndent = indent;
      if (indent !== stepFieldIndent) continue;
      stepRun = readBlockOrScalarRun(runMatch[1] ?? "", lines, i, indent);
      continue;
    }
    // Other direct step keys (name/uses/…) may establish the field column.
    if (/^(?:name|id|uses|shell|working-directory|timeout-minutes)\s*:/i.test(stripped)) {
      if (stepFieldIndent === null) stepFieldIndent = indent;
    }
  }
  flushStep();
  return steps;
}

function buildJobNode(id: string, body: string): WorkflowJobNode {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let ifExpr: string | null = null;
  let continueOnError: ContinueOnErrorClass = false;
  let hasMatrixExclude = false;
  let jobUses: string | null = null;
  const stepUses: string[] = [];

  let baseIndent: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = lineIndent(raw);
    if (baseIndent === null) baseIndent = indent;

    if (indent === baseIndent) {
      const ifMatch = /^if\s*:\s*(.*)$/i.exec(stripped);
      if (ifMatch !== null) {
        ifExpr = parseIfScalar(ifMatch[1] ?? "", lines, i, indent);
        continue;
      }
      const coe = /^continue-on-error\s*:\s*(.*)$/i.exec(stripped);
      if (coe !== null) {
        continueOnError = parseContinueOnErrorValue(coe[1] ?? "");
        continue;
      }
      const uses = /^uses\s*:\s*(.*)$/i.exec(stripped);
      if (uses !== null) {
        jobUses = parseScalarRemainder(uses[1] ?? "");
        continue;
      }
    }

    if (/^exclude\s*:/i.test(stripped) && baseIndent !== null && indent > baseIndent) {
      hasMatrixExclude = true;
    }

    const stepUsesMatch = /^(?:-\s*)?uses\s*:\s*(.*)$/i.exec(stripped);
    if (stepUsesMatch !== null && (baseIndent === null || indent > baseIndent)) {
      const u = parseScalarRemainder(stepUsesMatch[1] ?? "");
      if (u.length > 0) stepUses.push(u);
    }
  }

  return {
    id,
    body,
    ifExpr,
    continueOnError,
    hasMatrixExclude,
    jobUses,
    stepUses,
    steps: parseJobSteps(lines, baseIndent),
    runCommands: [],
  };
}

/**
 * Parse a GitHub Actions workflow YAML document into a job graph.
 * Indent-based structural parse — not a full YAML library (#4015 Bound).
 */
export function parseWorkflowJobGraph(text: string): WorkflowJobGraph {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let onLines = extractTopLevelBlock(lines, "on");
  if (onLines.length === 0) onLines = extractTopLevelBlock(lines, '"on"');
  if (onLines.length === 0) onLines = extractTopLevelBlock(lines, "'on'");
  let hasPr = onMentionsPullRequest(onLines);
  if (!hasPr) {
    for (const raw of lines) {
      const stripped = raw.trim();
      if (!stripped || stripped.startsWith("#")) continue;
      const code = stripInlineComment(stripped);
      if (/^['"]?on['"]?\s*:\s*.*\bpull_request\b/i.test(code) && lineIndent(raw) === 0) {
        hasPr = true;
        break;
      }
    }
  }
  const pullRequestFilters = parsePullRequestFilters(onLines);
  const jobBlock = extractTopLevelBlock(lines, "jobs");
  const jobs = parseJobNodes(jobBlock);
  return {
    jobs,
    pullRequestFilters,
    hasPullRequestTrigger: hasPr,
  };
}

/** Attach run:/script: commands extracted by the caller (reuse evaluate extractors). */
export function attachRunCommands(
  job: WorkflowJobNode,
  runCommands: readonly string[],
): WorkflowJobNode {
  return { ...job, runCommands };
}

export function looksLikeGateVehicle(job: WorkflowJobNode): boolean {
  if (/check|verify|gate|test|ci|lint|quality/i.test(job.id)) return true;
  if (job.jobUses !== null && /check|verify|gate|consumer|deft|directive/i.test(job.jobUses)) {
    return true;
  }
  return job.stepUses.some((u) => /check|verify|gate|consumer|deft|directive/i.test(u));
}

function remediationFor(workflowPath: string, jobId: string | null, repair: string): string {
  const jobPart = jobId !== null ? ` job '${jobId}'` : "";
  return `In ${workflowPath}${jobPart}: ${repair}`;
}

export interface JobGateCarry {
  readonly fullCheck: boolean;
  readonly gates: readonly string[];
}

/**
 * Emit reachability findings for one parsed workflow after run commands are attached.
 */
export function findingsForWorkflowGraph(
  workflowPath: string,
  graph: WorkflowJobGraph,
  jobCarry: ReadonlyMap<string, JobGateCarry>,
): readonly ReachabilityFinding[] {
  const findings: ReachabilityFinding[] = [];
  const filters = graph.pullRequestFilters;

  let anyRunGate = false;
  for (const job of graph.jobs) {
    const carried = jobCarry.get(job.id) ?? { fullCheck: false, gates: [] };
    if (carried.fullCheck || carried.gates.length > 0) anyRunGate = true;
  }

  // A gate that only runs on push/workflow_dispatch is not PR-reachable.
  if (anyRunGate && !graph.hasPullRequestTrigger) {
    findings.push({
      kind: "workflow-filter",
      workflowPath,
      jobId: null,
      detail:
        `Workflow ${workflowPath} has no pull_request trigger, so the gate never runs on a ` +
        "pull request; presence of the command alone must not read as clean",
      remediation: remediationFor(
        workflowPath,
        null,
        "add a pull_request trigger (or move the gate into a workflow that already runs on pull_request)",
      ),
    });
  }

  // Path/branch filters only matter on PR-triggered workflows that carry the gate.
  if (
    anyRunGate &&
    graph.hasPullRequestTrigger &&
    (filters.hasPaths || filters.hasPathsIgnore || filters.hasBranches)
  ) {
    const parts: string[] = [];
    if (filters.hasPaths) parts.push("paths");
    if (filters.hasPathsIgnore) parts.push("paths-ignore");
    if (filters.hasBranches) parts.push("branches");
    findings.push({
      kind: "workflow-filter",
      workflowPath,
      jobId: null,
      detail:
        `Workflow ${workflowPath} has pull_request ${parts.join("/")} filter(s) that can skip ` +
        "the whole workflow on a pull request; a required context that never reports stays " +
        "pending and blocks the merge",
      remediation: remediationFor(
        workflowPath,
        null,
        `remove or broaden pull_request ${parts.join("/")} filters so the gate workflow still runs on PRs ` +
          "(pending required checks otherwise block merge)",
      ),
    });
  }

  const pushConditionFinding = (
    jobId: string,
    scope: "job" | "step",
    cond: ConditionClass,
  ): void => {
    if (cond === "unknown") {
      findings.push({
        kind: "unknown-expression",
        workflowPath,
        jobId,
        detail:
          `Gate ${scope} '${jobId}' in ${workflowPath} has an undecidable if: expression ` +
          `(github.event.*/vars/secrets); reachability is unknown — never clean`,
        remediation: remediationFor(
          workflowPath,
          jobId,
          "replace undecidable if: (github.event.*/vars/secrets) with always() or a PR-true-by-construction condition",
        ),
      });
    } else if (cond === "skippable") {
      findings.push({
        kind: "skippable-if",
        workflowPath,
        jobId,
        detail:
          `Gate ${scope} '${jobId}' in ${workflowPath} has an if: condition that can evaluate ` +
          "false on pull_request, so the gate may be skipped on the merge path",
        remediation: remediationFor(
          workflowPath,
          jobId,
          "remove the skippable if: or use if: always() / a condition true on pull_request by construction",
        ),
      });
    }
  };

  const pushContinueOnErrorFinding = (
    jobId: string,
    scope: "job" | "step",
    coe: ContinueOnErrorClass,
  ): void => {
    if (coe === false) return;
    if (coe === "unknown") {
      findings.push({
        kind: "continue-on-error",
        workflowPath,
        jobId,
        detail:
          `Gate ${scope} '${jobId}' in ${workflowPath} sets continue-on-error to an expression ` +
          "that may evaluate true, so a failed gate may not fail the workflow on pull_request",
        remediation: remediationFor(
          workflowPath,
          jobId,
          `set continue-on-error: false (or remove it) on the gate ${scope}`,
        ),
      });
      return;
    }
    findings.push({
      kind: "continue-on-error",
      workflowPath,
      jobId,
      detail:
        `Gate ${scope} '${jobId}' in ${workflowPath} sets continue-on-error: true, so a failed ` +
        "gate does not fail the workflow on pull_request",
      remediation: remediationFor(
        workflowPath,
        jobId,
        `set continue-on-error: false (or remove it) on the gate ${scope}`,
      ),
    });
  };

  const stepLooksLikeGate = (job: WorkflowJobNode, step: WorkflowStepNode): boolean => {
    if (step.runText === null || step.runText.length === 0) return false;
    const run = step.runText;
    if (job.runCommands.some((c) => c === run || c.includes(run) || run.includes(c))) return true;
    return /(?:^|[\n;|&])\s*(?:sudo\s+)?(?:task|deft|directive)\s+(?:deft:)?(?:check\b|verify:)/i.test(
      run,
    );
  };

  for (const job of graph.jobs) {
    const carried = jobCarry.get(job.id) ?? { fullCheck: false, gates: [] };
    if (!carried.fullCheck && carried.gates.length === 0) continue;

    pushConditionFinding(job.id, "job", classifyPullRequestCondition(job.ifExpr));
    pushContinueOnErrorFinding(job.id, "job", job.continueOnError);

    for (const step of job.steps) {
      if (!stepLooksLikeGate(job, step)) continue;
      pushConditionFinding(job.id, "step", classifyPullRequestCondition(step.ifExpr));
      pushContinueOnErrorFinding(job.id, "step", step.continueOnError);
    }

    if (job.hasMatrixExclude) {
      findings.push({
        kind: "matrix-exclude",
        workflowPath,
        jobId: job.id,
        detail:
          `Gate job '${job.id}' in ${workflowPath} declares strategy.matrix exclude, which can ` +
          "remove the gate configuration on pull_request",
        remediation: remediationFor(
          workflowPath,
          job.id,
          "remove matrix exclude entries that drop the gate job configuration on pull_request",
        ),
      });
    }

    if (job.jobUses !== null) {
      findings.push({
        kind: "unknown-uses",
        workflowPath,
        jobId: job.id,
        detail:
          `Gate job '${job.id}' in ${workflowPath} uses reusable-workflow indirection ` +
          `(uses: ${job.jobUses}); reachability is unknown — never clean`,
        remediation: remediationFor(
          workflowPath,
          job.id,
          "inline the gate run: steps (or pin a readable local workflow) so reachability is statically visible",
        ),
      });
    }
  }

  if (!anyRunGate) {
    for (const job of graph.jobs) {
      if (job.jobUses !== null && looksLikeGateVehicle(job)) {
        findings.push({
          kind: "unknown-uses",
          workflowPath,
          jobId: job.id,
          detail:
            `Job '${job.id}' in ${workflowPath} invokes a reusable workflow via uses: ` +
            `(${job.jobUses}) with no visible run:/script: gate lines; reachability is unknown — never clean`,
          remediation: remediationFor(
            workflowPath,
            job.id,
            "replace uses: indirection with visible run: steps that invoke deft check / the named gates",
          ),
        });
      } else if (
        job.jobUses === null &&
        job.runCommands.length === 0 &&
        job.stepUses.length > 0 &&
        looksLikeGateVehicle(job)
      ) {
        findings.push({
          kind: "unknown-uses",
          workflowPath,
          jobId: job.id,
          detail:
            `Job '${job.id}' in ${workflowPath} only has composite uses: steps with no visible ` +
            "run:/script: gate lines; reachability is unknown — never clean",
          remediation: remediationFor(
            workflowPath,
            job.id,
            "add visible run: steps for the composing entrypoint or named gates (composite uses: is not statically decidable)",
          ),
        });
      }
    }
  }

  return findings;
}
