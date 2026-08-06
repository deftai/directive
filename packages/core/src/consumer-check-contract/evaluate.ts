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

  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (!inTask) {
      if (new RegExp(`^${taskName}\\s*:`).test(stripped) && indent === 2) {
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

  // 2) Root check aggregate should reference required gates OR invoke full deft check
  const checkTargets = ["check", "check:consumer", "check:framework-source"];
  let checkBodyMentionsDirectiveCheck = false;
  const composed = new Set<string>();

  for (const target of checkTargets) {
    const deps = extractCheckDeps(rootText, target);
    for (const d of deps) {
      composed.add(d);
    }
  }
  if (
    textReferencesGate(rootText, "deft check") ||
    textReferencesGate(rootText, "directive check") ||
    /dispatchTaskCheck|check:consumer|check:framework-source/.test(rootText)
  ) {
    checkBodyMentionsDirectiveCheck = true;
  }

  // Baseline CONSUMER_CHECK_GATES presence is advisory here; #3145 focuses on enforcement trio.
  // If the project composes full `deft check` / framework check orchestrator, treat as composed
  // only when verify.yml defines the tasks (step 1). For consumer custom check tasks that list
  // deps explicitly, require the gates by name.
  const hasExplicitCheckDeps = composed.size > 0;
  if (hasExplicitCheckDeps && !checkBodyMentionsDirectiveCheck) {
    for (const gateId of required) {
      const listed =
        composed.has(gateId) ||
        [...composed].some((d) => d === gateId || d.endsWith(gateId) || d.includes(gateId));
      if (!listed) {
        findings.push({
          gateId,
          surface: "check-task",
          detail: `check aggregate deps do not include ${gateId}`,
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
    const ciMentionsCheck =
      textReferencesGate(allCi, "deft check") ||
      textReferencesGate(allCi, "task check") ||
      textReferencesGate(allCi, "directive check") ||
      /npm test|pnpm test|vitest/.test(allCi);

    for (const gateId of required) {
      const mentioned =
        textReferencesGate(allCi, gateId) ||
        (ciMentionsCheck &&
          verifyText !== null &&
          taskDefinedInTaskfileYaml(
            verifyText,
            gateId.startsWith("verify:") ? gateId.slice("verify:".length) : gateId,
          ));
      // If CI only runs deft check / task check, and verify.yml defines the gate,
      // composition is satisfied indirectly.
      if (!mentioned && !ciMentionsCheck) {
        const finding: ConsumerCheckContractFinding = {
          gateId,
          surface: "ci-workflow",
          detail: `CI workflows do not invoke ${gateId} or a composing check entrypoint`,
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
