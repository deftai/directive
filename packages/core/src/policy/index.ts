import { coerceLegacyNarrative, LEGACY_NARRATIVE_KEY, loadProjectDefinition } from "./resolve.js";
import { DEFAULT_WIP_CAP } from "./wip.js";

export * from "./disclosure.js";
export * from "./resolve.js";
export * from "./wip.js";

export const FIELD_ALLOW_DIRECT_COMMITS = "plan.policy.allowDirectCommitsToMaster";
export const FIELD_WIP_CAP = "plan.policy.wipCap";
export const FIELD_SESSION_RITUAL_STALENESS_HOURS = "plan.policy.sessionRitualStalenessHours";
export const FIELD_TRIAGE_SCOPE = "plan.policy.triageScope";
export const FIELD_TRIAGE_SCOPE_IGNORES = "plan.policy.triageScopeIgnores";
export const FIELD_TRIAGE_RANKING_LABELS = "plan.policy.triageRankingLabels";
export const FIELD_TRIAGE_AUTO_CLASSIFY = "plan.policy.triageAutoClassify";
export const FIELD_TRIAGE_HOLD_MARKERS = "plan.policy.triageHoldMarkers";
export const FIELD_SWARM_SUBAGENT_BACKEND = "plan.policy.swarmSubagentBackend";

export const DEFAULT_SESSION_RITUAL_STALENESS_HOURS = 4;
export const DEFAULT_TRIAGE_SCOPE_VALUE: readonly Record<string, unknown>[] = [
  { rule: "all-open" },
];
export const DEFAULT_TRIAGE_SCOPE_IGNORES_VALUE: readonly unknown[] = [];
export const DEFAULT_TRIAGE_RANKING_LABELS_VALUE: readonly string[] = [];
export const DEFAULT_TRIAGE_AUTO_CLASSIFY_VALUE: readonly unknown[] = [];

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
  const policy = getPlan(data).policy;
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

type Inspector = (data: Record<string, unknown> | null) => PolicyField;

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
  inspectSwarmSubagentBackend,
];

/** Walk registered inspectors and return one row per field (#1148). */
export function inspectAllPolicies(projectRoot: string): PolicyField[] {
  const [data] = loadProjectDefinition(projectRoot);
  return REGISTERED_POLICIES.map((inspect) => inspect(data));
}

/** Look up a single registered field by canonical dotted-path name. */
export function inspectOnePolicy(name: string, projectRoot: string): PolicyField | null {
  for (const field of inspectAllPolicies(projectRoot)) {
    if (field.name === name) return field;
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
