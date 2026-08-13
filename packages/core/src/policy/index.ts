import {
  FIELD_HOST_SKILL_DISCOVERY,
  FIELD_HOST_SKILL_DISCOVERY_CLI_ALIAS,
  inspectHostSkillDiscovery,
} from "../init-deposit/skill-discovery-hosts.js";
import {
  FIELD_OPENCLAW_PRODUCT_COMMANDS,
  FIELD_OPENCLAW_PRODUCT_COMMANDS_CLI_ALIAS,
  inspectOpenClawProductCommands,
} from "../slash/openclaw-deposit.js";
import {
  FIELD_AC_PASS_BANKING,
  FIELD_AC_PASS_BANKING_CLI_ALIAS,
  inspectAcPassBanking,
} from "./ac-pass-banking.js";
import {
  FIELD_CEREMONY_DIAL,
  FIELD_CEREMONY_DIAL_CLI_ALIAS,
  inspectCeremonyDial,
} from "./ceremony-dial.js";
import {
  FIELD_CHECK_RESUME,
  FIELD_CHECK_RESUME_CLI_ALIAS,
  inspectCheckResume,
} from "./check-resume.js";
import {
  FIELD_COVERAGE_DEBT,
  FIELD_COVERAGE_DEBT_CLI_ALIAS,
  inspectCoverageDebt,
} from "./coverage-debt.js";
import {
  FIELD_DELIVERY_BRANCH,
  FIELD_DELIVERY_BRANCH_CLI_ALIAS,
  inspectDeliveryBranch,
} from "./delivery-branch.js";
import { FIELD_HOST_HOOKS, FIELD_HOST_HOOKS_CLI_ALIAS, inspectHostHooks } from "./host-hooks.js";
import {
  FIELD_HOST_SLASH_COMMANDS,
  FIELD_HOST_SLASH_COMMANDS_CLI_ALIAS,
  inspectHostSlashCommands,
} from "./host-slash-commands.js";
import {
  FIELD_HOTFIX_CRITERIA,
  FIELD_HOTFIX_CRITERIA_CLI_ALIAS,
  inspectHotfixCriteria,
} from "./hotfix-criteria.js";
import {
  FIELD_MIN_GREPTILE_CONFIDENCE,
  FIELD_MIN_GREPTILE_CONFIDENCE_CLI_ALIAS,
  inspectMinGreptileConfidence,
} from "./min-greptile-confidence.js";
import { readPlanPolicy } from "./plan-extensions.js";
import {
  FIELD_PRODUCT_SIGNAL,
  FIELD_PRODUCT_SIGNAL_CLI_ALIAS,
  inspectProductSignal,
} from "./product-signal.js";
import {
  FIELD_REQUIRE_HUMAN_MERGE,
  FIELD_REQUIRE_HUMAN_MERGE_CLI_ALIAS,
  inspectRequireHumanMerge,
} from "./require-human-merge.js";
import { coerceLegacyNarrative, LEGACY_NARRATIVE_KEY, loadProjectDefinition } from "./resolve.js";
import {
  FIELD_RUNTIME_AUTHORITY,
  FIELD_RUNTIME_AUTHORITY_CLI_ALIAS,
  inspectRuntimeAuthority,
} from "./runtime-authority.js";
import {
  FIELD_STALENESS_TICKLER,
  FIELD_STALENESS_TICKLER_CLI_ALIAS,
  inspectStalenessTickler,
} from "./staleness-tickler.js";
import {
  FIELD_VALUE_FEEDBACK,
  FIELD_VALUE_FEEDBACK_CLI_ALIAS,
  inspectValueFeedback,
} from "./value-feedback.js";
import { DEFAULT_WIP_CAP } from "./wip.js";

export * from "./ac-pass-banking.js";
export * from "./agents-md-advisory.js";
export * from "./autonomy.js";
export * from "./capacity.js";
export * from "./ceremony-dial.js";
export * from "./ceremony-dial-escalation.js";
export * from "./check-resume.js";
export * from "./coverage-debt.js";
export * from "./decisions.js";
export * from "./deft-directive-disable.js";
export * from "./delivery-branch.js";
export * from "./disclosure.js";
export * from "./host-hooks.js";
export * from "./host-slash-commands.js";
export * from "./hotfix-criteria.js";
export * from "./intent-ceiling.js";
export * from "./merge-approval-head.js";
export * from "./min-greptile-confidence.js";
export * from "./no-deft-directive.js";
export * from "./org-force-on-migration.js";
export * from "./plan-extensions.js";
export * from "./policy-invocation.js";
export * from "./product-signal.js";
export * from "./require-human-merge.js";
export * from "./resolve.js";
export * from "./runtime-authority.js";
export * from "./staleness-tickler.js";
export * from "./value-feedback.js";
export * from "./value-feedback-autoenable.js";
export * from "./wip.js";
export * from "./write-fence.js";

export const FIELD_ALLOW_DIRECT_COMMITS = "plan.policy.allowDirectCommitsToMaster";
export const FIELD_WIP_CAP = "plan.policy.wipCap";
export const FIELD_SESSION_RITUAL_STALENESS_HOURS = "plan.policy.sessionRitualStalenessHours";
export const FIELD_TRIAGE_SCOPE = "plan.policy.triageScope";
export const FIELD_TRIAGE_SCOPE_IGNORES = "plan.policy.triageScopeIgnores";
export const FIELD_TRIAGE_RANKING_LABELS = "plan.policy.triageRankingLabels";
export const FIELD_TRIAGE_AUTO_CLASSIFY = "plan.policy.triageAutoClassify";
export const FIELD_TRIAGE_HOLD_MARKERS = "plan.policy.triageHoldMarkers";
export const FIELD_TRIAGE_LABEL_MIRROR = "plan.policy.triageLabelMirror";
export const FIELD_SWARM_SUBAGENT_BACKEND = "plan.policy.swarmSubagentBackend";
// deliveryBranch also exported from delivery-branch.js via export *

export const DEFAULT_SESSION_RITUAL_STALENESS_HOURS = 4;
export const DEFAULT_TRIAGE_SCOPE_VALUE: readonly Record<string, unknown>[] = [
  { rule: "all-open" },
];
export const DEFAULT_TRIAGE_SCOPE_IGNORES_VALUE: readonly unknown[] = [];
export const DEFAULT_TRIAGE_RANKING_LABELS_VALUE: readonly string[] = [];
export const DEFAULT_TRIAGE_AUTO_CLASSIFY_VALUE: readonly unknown[] = [];
/** Default for #1423 Tier-1 label mirror: enabled with `triaged` idempotency marker. */
export const DEFAULT_TRIAGE_LABEL_MIRROR_VALUE: Readonly<Record<string, unknown>> = {
  enabled: true,
  idempotencyLabel: "triaged",
  alwaysLabels: ["triaged"],
  actionLabels: {},
};

export const KNOWN_SUBAGENT_BACKEND_IDS = new Set(["composer", "cursor-cloud", "grok-build"]);

const FALLBACK_HOLD_MARKERS = [
  "do not implement",
  "BLOCKED",
  "HOLDING",
  "Holding / capture only",
] as const;

export interface PolicyField {
  readonly name: string;
  readonly current: unknown;
  readonly default: unknown;
  readonly source: string;
}

function getPlan(data: Record<string, unknown> | null): Record<string, unknown> {
  if (data === null) return {};
  const plan = data.plan;
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    return plan as Record<string, unknown>;
  }
  return {};
}

function getPolicyBlock(data: Record<string, unknown> | null): Record<string, unknown> {
  const policy = readPlanPolicy(getPlan(data));
  if (typeof policy === "object" && policy !== null && !Array.isArray(policy)) {
    return policy as Record<string, unknown>;
  }
  return {};
}

function getNarratives(data: Record<string, unknown> | null): Record<string, unknown> {
  const narratives = getPlan(data).narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    return narratives as Record<string, unknown>;
  }
  return {};
}

function defaultHoldMarkers(): string[] {
  return [...FALLBACK_HOLD_MARKERS];
}

function inspectAllowDirectCommits(data: Record<string, unknown> | null): PolicyField {
  const policyBlock = getPolicyBlock(data);
  if ("allowDirectCommitsToMaster" in policyBlock) {
    const raw = policyBlock.allowDirectCommitsToMaster;
    const current = typeof raw === "boolean" ? raw : false;
    return {
      name: FIELD_ALLOW_DIRECT_COMMITS,
      current,
      default: false,
      source: "typed",
    };
  }
  const narratives = getNarratives(data);
  if (LEGACY_NARRATIVE_KEY in narratives) {
    const { allow } = coerceLegacyNarrative(narratives[LEGACY_NARRATIVE_KEY]);
    return {
      name: FIELD_ALLOW_DIRECT_COMMITS,
      current: allow,
      default: false,
      source: "legacy",
    };
  }
  return {
    name: FIELD_ALLOW_DIRECT_COMMITS,
    current: false,
    default: false,
    source: "default",
  };
}

function inspectWipCap(data: Record<string, unknown> | null): PolicyField {
  const policyBlock = getPolicyBlock(data);
  if ("wipCap" in policyBlock) {
    const raw = policyBlock.wipCap;
    let current: number = DEFAULT_WIP_CAP;
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
      current = raw;
    }
    return {
      name: FIELD_WIP_CAP,
      current,
      default: DEFAULT_WIP_CAP,
      source: "typed",
    };
  }
  return {
    name: FIELD_WIP_CAP,
    current: DEFAULT_WIP_CAP,
    default: DEFAULT_WIP_CAP,
    source: "default",
  };
}

function inspectTriageLabelMirrorField(data: Record<string, unknown> | null): PolicyField {
  const policyBlock = getPolicyBlock(data);
  if ("triageLabelMirror" in policyBlock) {
    const raw = policyBlock.triageLabelMirror;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return {
        name: FIELD_TRIAGE_LABEL_MIRROR,
        current: raw,
        default: { ...DEFAULT_TRIAGE_LABEL_MIRROR_VALUE },
        source: "typed",
      };
    }
    return {
      name: FIELD_TRIAGE_LABEL_MIRROR,
      current: { ...DEFAULT_TRIAGE_LABEL_MIRROR_VALUE },
      default: { ...DEFAULT_TRIAGE_LABEL_MIRROR_VALUE },
      source: "default-on-error",
    };
  }
  return {
    name: FIELD_TRIAGE_LABEL_MIRROR,
    current: { ...DEFAULT_TRIAGE_LABEL_MIRROR_VALUE },
    default: { ...DEFAULT_TRIAGE_LABEL_MIRROR_VALUE },
    source: "default",
  };
}

function inspectSessionRitualStalenessHours(data: Record<string, unknown> | null): PolicyField {
  const policyBlock = getPolicyBlock(data);
  if ("sessionRitualStalenessHours" in policyBlock) {
    const raw = policyBlock.sessionRitualStalenessHours;
    if (raw === null) {
      return {
        name: FIELD_SESSION_RITUAL_STALENESS_HOURS,
        current: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
        default: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
        source: "default",
      };
    }
    let current = DEFAULT_SESSION_RITUAL_STALENESS_HOURS;
    let source = "default-on-error";
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
      current = raw;
      source = "typed";
    }
    return {
      name: FIELD_SESSION_RITUAL_STALENESS_HOURS,
      current,
      default: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
      source,
    };
  }
  return {
    name: FIELD_SESSION_RITUAL_STALENESS_HOURS,
    current: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
    default: DEFAULT_SESSION_RITUAL_STALENESS_HOURS,
    source: "default",
  };
}

function listFieldInspector(
  data: Record<string, unknown> | null,
  key: string,
  name: string,
  defaultValue: readonly unknown[],
  options?: { emptyIsTyped?: boolean },
): PolicyField {
  const policyBlock = getPolicyBlock(data);
  if (!(key in policyBlock)) {
    return {
      name,
      current: [...defaultValue],
      default: [...defaultValue],
      source: "default",
    };
  }
  const raw = policyBlock[key];
  if (!Array.isArray(raw)) {
    return {
      name,
      current: [...defaultValue],
      default: [...defaultValue],
      source: "default",
    };
  }
  if (raw.length === 0 && !options?.emptyIsTyped) {
    return {
      name,
      current: [...defaultValue],
      default: [...defaultValue],
      source: "default",
    };
  }
  if (options?.emptyIsTyped && raw.every((s) => typeof s === "string")) {
    const cleaned = raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    return {
      name,
      current: cleaned,
      default: [...defaultValue],
      source: "typed",
    };
  }
  return {
    name,
    current: [...raw],
    default: [...defaultValue],
    source: "typed",
  };
}

function inspectSwarmSubagentBackend(data: Record<string, unknown> | null): PolicyField {
  const policyBlock = getPolicyBlock(data);
  if (!("swarmSubagentBackend" in policyBlock)) {
    return {
      name: FIELD_SWARM_SUBAGENT_BACKEND,
      current: null,
      default: null,
      source: "default",
    };
  }
  const raw = policyBlock.swarmSubagentBackend;
  if (typeof raw === "string") {
    const bid = raw.trim();
    if (bid.length > 0 && KNOWN_SUBAGENT_BACKEND_IDS.has(bid)) {
      return {
        name: FIELD_SWARM_SUBAGENT_BACKEND,
        current: bid,
        default: null,
        source: "typed",
      };
    }
  }
  return {
    name: FIELD_SWARM_SUBAGENT_BACKEND,
    current: null,
    default: null,
    source: "default-on-error",
  };
}

type Inspector = (data: Record<string, unknown> | null, projectRoot?: string) => PolicyField;

function inspectProductSignalField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectProductSignal(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectValueFeedbackField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectValueFeedback(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectCoverageDebtField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectCoverageDebt(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectCheckResumeField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectCheckResume(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectStalenessTicklerField(data: Record<string, unknown> | null): PolicyField {
  const field = inspectStalenessTickler(data);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectRuntimeAuthorityField(data: Record<string, unknown> | null): PolicyField {
  const field = inspectRuntimeAuthority(data);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectHostHooksField(data: Record<string, unknown> | null): PolicyField {
  const field = inspectHostHooks(data);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectHostSlashCommandsField(data: Record<string, unknown> | null): PolicyField {
  const field = inspectHostSlashCommands(data);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectOpenClawProductCommandsField(data: Record<string, unknown> | null): PolicyField {
  const field = inspectOpenClawProductCommands(data);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectHostSkillDiscoveryField(data: Record<string, unknown> | null): PolicyField {
  const field = inspectHostSkillDiscovery(data);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectRequireHumanMergeField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectRequireHumanMerge(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectHotfixCriteriaField(data: Record<string, unknown> | null): PolicyField {
  const field = inspectHotfixCriteria(data);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectDeliveryBranchField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectDeliveryBranch(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectMinGreptileConfidenceField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectMinGreptileConfidence(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectCeremonyDialField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectCeremonyDial(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

function inspectAcPassBankingField(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): PolicyField {
  const field = inspectAcPassBanking(data, projectRoot);
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

const REGISTERED_POLICIES: readonly Inspector[] = [
  inspectAllowDirectCommits,
  inspectWipCap,
  inspectSessionRitualStalenessHours,
  (data) => listFieldInspector(data, "triageScope", FIELD_TRIAGE_SCOPE, DEFAULT_TRIAGE_SCOPE_VALUE),
  (data) =>
    listFieldInspector(
      data,
      "triageScopeIgnores",
      FIELD_TRIAGE_SCOPE_IGNORES,
      DEFAULT_TRIAGE_SCOPE_IGNORES_VALUE,
    ),
  (data) =>
    listFieldInspector(
      data,
      "triageRankingLabels",
      FIELD_TRIAGE_RANKING_LABELS,
      DEFAULT_TRIAGE_RANKING_LABELS_VALUE,
    ),
  (data) =>
    listFieldInspector(
      data,
      "triageAutoClassify",
      FIELD_TRIAGE_AUTO_CLASSIFY,
      DEFAULT_TRIAGE_AUTO_CLASSIFY_VALUE,
    ),
  (data) =>
    listFieldInspector(data, "triageHoldMarkers", FIELD_TRIAGE_HOLD_MARKERS, defaultHoldMarkers(), {
      emptyIsTyped: true,
    }),
  inspectTriageLabelMirrorField,
  inspectSwarmSubagentBackend,
  inspectDeliveryBranchField,
  inspectMinGreptileConfidenceField,
  inspectHostHooksField,
  inspectHostSlashCommandsField,
  inspectOpenClawProductCommandsField,
  inspectHostSkillDiscoveryField,
  inspectStalenessTicklerField,
  inspectRuntimeAuthorityField,
  inspectProductSignalField,
  inspectValueFeedbackField,
  inspectCoverageDebtField,
  inspectCheckResumeField,
  inspectRequireHumanMergeField,
  inspectHotfixCriteriaField,
  inspectCeremonyDialField,
  inspectAcPassBankingField,
];

/** Walk registered inspectors and return one row per field (#1148). */
export function inspectAllPolicies(projectRoot: string): PolicyField[] {
  const [data] = loadProjectDefinition(projectRoot);
  return REGISTERED_POLICIES.map((inspect) => inspect(data, projectRoot));
}

/** Look up a single registered field by canonical dotted-path name (or CLI alias). */
export function inspectOnePolicy(name: string, projectRoot: string): PolicyField | null {
  const normalized =
    name === FIELD_VALUE_FEEDBACK_CLI_ALIAS
      ? FIELD_VALUE_FEEDBACK
      : name === FIELD_PRODUCT_SIGNAL_CLI_ALIAS
        ? FIELD_PRODUCT_SIGNAL
        : name === FIELD_COVERAGE_DEBT_CLI_ALIAS
          ? FIELD_COVERAGE_DEBT
          : name === FIELD_CHECK_RESUME_CLI_ALIAS
            ? FIELD_CHECK_RESUME
            : name === FIELD_STALENESS_TICKLER_CLI_ALIAS
              ? FIELD_STALENESS_TICKLER
              : name === FIELD_RUNTIME_AUTHORITY_CLI_ALIAS
                ? FIELD_RUNTIME_AUTHORITY
                : name === FIELD_HOST_HOOKS_CLI_ALIAS
                  ? FIELD_HOST_HOOKS
                  : name === FIELD_HOST_SLASH_COMMANDS_CLI_ALIAS
                    ? FIELD_HOST_SLASH_COMMANDS
                    : name === FIELD_OPENCLAW_PRODUCT_COMMANDS_CLI_ALIAS
                      ? FIELD_OPENCLAW_PRODUCT_COMMANDS
                      : name === FIELD_HOST_SKILL_DISCOVERY_CLI_ALIAS
                        ? FIELD_HOST_SKILL_DISCOVERY
                        : name === FIELD_REQUIRE_HUMAN_MERGE_CLI_ALIAS
                          ? FIELD_REQUIRE_HUMAN_MERGE
                          : name === FIELD_HOTFIX_CRITERIA_CLI_ALIAS
                            ? FIELD_HOTFIX_CRITERIA
                            : name === FIELD_DELIVERY_BRANCH_CLI_ALIAS
                              ? FIELD_DELIVERY_BRANCH
                              : name === FIELD_MIN_GREPTILE_CONFIDENCE_CLI_ALIAS
                                ? FIELD_MIN_GREPTILE_CONFIDENCE
                                : name === FIELD_CEREMONY_DIAL_CLI_ALIAS
                                  ? FIELD_CEREMONY_DIAL
                                  : name === FIELD_AC_PASS_BANKING_CLI_ALIAS
                                    ? FIELD_AC_PASS_BANKING
                                    : name;
  for (const field of inspectAllPolicies(projectRoot)) {
    if (field.name === normalized) return field;
  }
  return null;
}

/** Return canonical names of every registered typed-policy field. */
export function registeredPolicyNames(): string[] {
  return REGISTERED_POLICIES.map((inspect) => inspect(null).name);
}

function utcIso(now?: Date): string {
  const dt = now ?? new Date();
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function fieldToDict(field: PolicyField): Record<string, unknown> {
  return {
    name: field.name,
    current: field.current,
    default: field.default,
    source: field.source,
  };
}

/** Render the JSON envelope {generated_at, fields: [...]}. */
export function renderJson(fields: PolicyField[], now?: Date): string {
  const envelope = {
    generated_at: utcIso(now),
    fields: fields.map(fieldToDict),
  };
  return JSON.stringify(envelope, null, 2);
}

function formatValue(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value) || typeof value === "object") {
    // Match Python json.dumps(..., ensure_ascii=False, sort_keys=False) spacing.
    return JSON.stringify(value).replace(/":/g, '": ').replace(/,"/g, ', "');
  }
  if (typeof value === "string") return value;
  return String(value);
}

/** Render the human-readable text format from the issue body. */
export function renderText(fields: PolicyField[]): string {
  if (fields.length === 0) {
    return (
      "[policy] (no fields changed)\n" +
      "  All registered policies are at their framework defaults. " +
      "Re-run without `--changed-only` to inspect them."
    );
  }
  return fields
    .map(
      (field) =>
        `[policy] ${field.name}\n` +
        `  current: ${formatValue(field.current)}\n` +
        `  default: ${formatValue(field.default)}\n` +
        `  source:  ${field.source}`,
    )
    .join("\n\n");
}

/** Python repr for a string (single-quoted). */
export function pythonStringRepr(value: string): string {
  return `'${value}'`;
}

/** Python repr for a list of strings. */
export function pythonListRepr(items: string[]): string {
  return `[${items.map((i) => pythonStringRepr(i)).join(", ")}]`;
}
