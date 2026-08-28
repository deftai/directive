import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
import { valueFeedbackInstallForceOnSource } from "./org-force-on-migration.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import {
  appendAuditLog,
  loadProjectDefinition,
  POLICY_AUDIT_NOOP_STDOUT,
  projectDefinitionPath,
} from "./resolve.js";
import { isTrustedOrgAutoEnable, type OrgAutoEnableOptions } from "./value-feedback-autoenable.js";

/** Canonical registered policy field name (matches other FIELD_* dotted paths). */
export const FIELD_VALUE_FEEDBACK = "plan.policy.valueFeedback";

/** Short alias accepted by `policy:show --field=valueFeedback` (#1709). */
export const FIELD_VALUE_FEEDBACK_CLI_ALIAS = "valueFeedback";

export const DEFAULT_VALUE_FEEDBACK_ENABLED = false;

/** Sub-flag defaults applied when the master flag is enabled (#1709 tiered-cost decision). */
export const VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED = {
  emitEvents: true,
  sessionLine: true,
  upstreamPrompt: false,
} as const;

export type ValueFeedbackSubFlag = keyof typeof VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED;

export interface ValueFeedbackConfig {
  readonly enabled: boolean;
  readonly emitEvents: boolean;
  readonly sessionLine: boolean;
  readonly upstreamPrompt: boolean;
}

export type ValueFeedbackSource =
  | "typed"
  | "org-auto"
  | "install-force-on"
  | "default"
  | "default-on-error";

export interface ValueFeedbackResolved extends ValueFeedbackConfig {
  readonly source: ValueFeedbackSource;
  readonly error: string | null;
}

export const VALUE_FEEDBACK_CAPABILITY_COST_DISCLOSURE =
  "\u26a0 Capability-cost disclosure -- enabling value feedback opts into " +
  "attributed awareness surfaces that may consume session context and nudge budget.\n" +
  "  \u2022 Local emit-only ledger writes to the gitignored `.deft-cache/events.jsonl` " +
  "(no network by default).\n" +
  "  \u2022 A budgeted session one-liner may appear when concrete attributed value exists.\n" +
  "  \u2022 Upstream gap-escalation prompts stay OFF unless you explicitly enable " +
  "`upstreamPrompt` (GitHub attention + token cost).\n" +
  "  \u2022 Inspect current state: `" +
  policyColonInvocation("show", " --field=valueFeedback") +
  "`.\n" +
  "  \u2022 Reversible: set `enabled: false` under the typed policy block in PROJECT-DEFINITION.\n" +
  "  \u2022 Changes are recorded to meta/policy-changes.log for auditability.";

function defaultResolved(
  source: ValueFeedbackSource,
  error: string | null = null,
): ValueFeedbackResolved {
  return {
    enabled: DEFAULT_VALUE_FEEDBACK_ENABLED,
    emitEvents: false,
    sessionLine: false,
    upstreamPrompt: false,
    source,
    error,
  };
}

/**
 * Trusted-org auto-enable resolution (#2376): LOCAL emit + session readback ON,
 * network/upstream OFF. Applies only when the typed flag is absent.
 */
function orgAutoResolved(): ValueFeedbackResolved {
  return {
    enabled: true,
    emitEvents: VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED.emitEvents,
    sessionLine: VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED.sessionLine,
    upstreamPrompt: false,
    source: "org-auto",
    error: null,
  };
}

function readSubFlag(
  block: Record<string, unknown>,
  key: ValueFeedbackSubFlag,
  masterEnabled: boolean,
): boolean {
  if (!masterEnabled) {
    return false;
  }
  if (key in block && typeof block[key] === "boolean") {
    return block[key] as boolean;
  }
  return VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED[key];
}

/** Validate a `plan.policy.valueFeedback` payload. */
export function validateValueFeedback(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_VALUE_FEEDBACK} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["enabled", "emitEvents", "sessionLine", "upstreamPrompt"] as const) {
    if (key in rec && typeof rec[key] !== "boolean") {
      errors.push(`${FIELD_VALUE_FEEDBACK}.${key} must be a boolean`);
    }
  }
  return errors;
}

/** Resolve a typed `valueFeedback` block without org-auto / install-force-on layers. */
export function resolveValueFeedbackFromTypedBlock(raw: unknown): ValueFeedbackResolved {
  const errors = validateValueFeedback(raw);
  if (errors.length > 0) {
    return defaultResolved("default-on-error", errors[0] ?? "invalid valueFeedback block");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultResolved("default");
  }
  const block = raw as Record<string, unknown>;
  const enabled =
    typeof block.enabled === "boolean" ? block.enabled : DEFAULT_VALUE_FEEDBACK_ENABLED;
  if (!enabled) {
    return {
      enabled: false,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
      source: "typed",
      error: null,
    };
  }
  return {
    enabled: true,
    emitEvents: readSubFlag(block, "emitEvents", true),
    sessionLine: readSubFlag(block, "sessionLine", true),
    upstreamPrompt: readSubFlag(block, "upstreamPrompt", true),
    source: "typed",
    error: null,
  };
}

export interface ResolveValueFeedbackOptions {
  /** Test seam for origin-org auto-enable resolution (#2376). */
  readonly autoEnable?: OrgAutoEnableOptions;
}

/**
 * Resolve `plan.policy.valueFeedback` from PROJECT-DEFINITION (#1709).
 *
 * Precedence (#2376): an explicit typed `valueFeedback` block always wins
 * (including `enabled: false`). Only when the typed flag is ABSENT does the
 * trusted-org auto-enable layer apply -- for company-owned (deftai) repos it
 * turns LOCAL emit + session readback ON while leaving network/upstream OFF.
 * Any other repo (or no origin remote) stays OFF.
 */
export function resolveValueFeedback(
  projectRoot: string,
  options: ResolveValueFeedbackOptions = {},
): ValueFeedbackResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultResolved("default-on-error", err);
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("valueFeedback" in (policyBlock as Record<string, unknown>))
  ) {
    if (isTrustedOrgAutoEnable(projectRoot, options.autoEnable)) {
      return orgAutoResolved();
    }
    return defaultResolved("default");
  }
  const raw = (policyBlock as Record<string, unknown>).valueFeedback;
  const installSource = valueFeedbackInstallForceOnSource(projectRoot, raw);
  if (installSource !== null) {
    const resolved = resolveValueFeedbackFromTypedBlock(raw);
    return { ...resolved, source: installSource };
  }
  return resolveValueFeedbackFromTypedBlock(raw);
}

/** Master gate: when `enabled` is false, every downstream path is rejected. */
export function isValueFeedbackPathAllowed(
  path: ValueFeedbackSubFlag,
  policy: ValueFeedbackResolved,
): boolean {
  if (!policy.enabled) {
    return false;
  }
  return policy[path];
}

/** Resolved per-path gate booleans for policy:show and enable status output. */
export function valueFeedbackPathGates(
  policy: ValueFeedbackResolved,
): Record<ValueFeedbackSubFlag, boolean> {
  return {
    emitEvents: isValueFeedbackPathAllowed("emitEvents", policy),
    sessionLine: isValueFeedbackPathAllowed("sessionLine", policy),
    upstreamPrompt: isValueFeedbackPathAllowed("upstreamPrompt", policy),
  };
}

/** Human-readable status line for CLI enable/show surfaces. */
export function formatValueFeedbackStatusLine(policy: ValueFeedbackResolved): string {
  const gates = valueFeedbackPathGates(policy);
  return (
    `[deft policy] valueFeedback enabled=${String(policy.enabled)} ` +
    `emitEvents=${String(policy.emitEvents)} (path=${String(gates.emitEvents)}) ` +
    `sessionLine=${String(policy.sessionLine)} (path=${String(gates.sessionLine)}) ` +
    `upstreamPrompt=${String(policy.upstreamPrompt)} (path=${String(gates.upstreamPrompt)}).`
  );
}

export interface ValueFeedbackPolicyField {
  readonly name: typeof FIELD_VALUE_FEEDBACK;
  readonly current: ValueFeedbackConfig;
  readonly default: ValueFeedbackConfig;
  readonly source: string;
}

function fieldFromResolved(resolved: ValueFeedbackResolved): ValueFeedbackPolicyField {
  return {
    name: FIELD_VALUE_FEEDBACK,
    current: {
      enabled: resolved.enabled,
      emitEvents: resolved.emitEvents,
      sessionLine: resolved.sessionLine,
      upstreamPrompt: resolved.upstreamPrompt,
    },
    default: {
      enabled: DEFAULT_VALUE_FEEDBACK_ENABLED,
      emitEvents: false,
      sessionLine: false,
      upstreamPrompt: false,
    },
    source: resolved.source,
  };
}

export interface InspectValueFeedbackOptions {
  /** Test seam for origin-org auto-enable resolution (#2376). */
  readonly autoEnable?: OrgAutoEnableOptions;
}

/**
 * Inspector row for `policy:show --field=valueFeedback`.
 *
 * When `projectRoot` is supplied this MUST mirror {@link resolveValueFeedback}'s
 * precedence exactly (#2377 review): with no explicit typed block, a trusted-org
 * checkout resolves to `org-auto`/ON so `policy:show` never reports OFF while the
 * ledger is actively collecting. Omitting `projectRoot` keeps the legacy
 * data-only behavior for callers that only need the field name/shape.
 */
export function inspectValueFeedback(
  data: Record<string, unknown> | null,
  projectRoot?: string,
  options: InspectValueFeedbackOptions = {},
): ValueFeedbackPolicyField {
  if (data === null) {
    return fieldFromResolved(defaultResolved("default"));
  }

  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("valueFeedback" in (policyBlock as Record<string, unknown>))
  ) {
    if (projectRoot !== undefined && isTrustedOrgAutoEnable(projectRoot, options.autoEnable)) {
      return fieldFromResolved(orgAutoResolved());
    }
    return fieldFromResolved(defaultResolved("default"));
  }

  const raw = (policyBlock as Record<string, unknown>).valueFeedback;
  const installSource =
    projectRoot !== undefined ? valueFeedbackInstallForceOnSource(projectRoot, raw) : null;
  const resolved = resolveValueFeedbackFromTypedBlock(raw);
  return fieldFromResolved(
    installSource !== null ? { ...resolved, source: installSource } : resolved,
  );
}

export interface EnableValueFeedbackOptions {
  readonly confirm: boolean;
  readonly actor?: string;
  readonly note?: string;
  readonly subFlags?: Partial<Record<ValueFeedbackSubFlag, boolean>>;
}

export interface EnableValueFeedbackResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/** Persist `valueFeedback.enabled=true` after capability-cost disclosure (#1709). */
export function enableValueFeedback(
  projectRoot: string,
  options: EnableValueFeedbackOptions,
): EnableValueFeedbackResult {
  if (!options.confirm) {
    return {
      exitCode: 1,
      stdout:
        `${VALUE_FEEDBACK_CAPABILITY_COST_DISCLOSURE}\n\n` +
        `Re-run with --confirm to apply: ${policyColonInvocation("enable-value-feedback", " -- --confirm")}\n`,
      changed: false,
    };
  }

  const _path = projectDefinitionPath(projectRoot);
  try {
    const { changed } = withProjectDefinitionMutation(projectRoot, (mutation) => {
      const data = mutation.load();
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          throw new Error("PROJECT-DEFINITION 'plan' is not an object");
        }
      }
      const plan = data.plan as Record<string, unknown>;
      const legacyKeyMigrated = migrateLegacyPolicyKey(plan);
      const existingPolicy = plan[PLAN_POLICY_KEY];
      if (
        typeof existingPolicy !== "object" ||
        existingPolicy === null ||
        Array.isArray(existingPolicy)
      ) {
        if (existingPolicy === undefined) {
          plan[PLAN_POLICY_KEY] = {};
        } else {
          throw new Error("plan.policy is not an object");
        }
      }
      const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
      const previous = policyBlock.valueFeedback;
      const prevObj =
        typeof previous === "object" && previous !== null && !Array.isArray(previous)
          ? (previous as Record<string, unknown>)
          : {};
      const sub = options.subFlags ?? {};
      const readPersistedSubFlag = (key: ValueFeedbackSubFlag): boolean => {
        if (key in sub && typeof sub[key] === "boolean") {
          return sub[key] as boolean;
        }
        if (key in prevObj && typeof prevObj[key] === "boolean") {
          return prevObj[key] as boolean;
        }
        return VALUE_FEEDBACK_SUBFLAG_DEFAULTS_WHEN_ENABLED[key];
      };
      const nextBlock = {
        enabled: true,
        emitEvents: readPersistedSubFlag("emitEvents"),
        sessionLine: readPersistedSubFlag("sessionLine"),
        upstreamPrompt: readPersistedSubFlag("upstreamPrompt"),
      };
      const previousNormalized = resolveValueFeedbackFromTypedBlock(previous);
      const changedFlag =
        previousNormalized.enabled !== nextBlock.enabled ||
        previousNormalized.emitEvents !== nextBlock.emitEvents ||
        previousNormalized.sessionLine !== nextBlock.sessionLine ||
        previousNormalized.upstreamPrompt !== nextBlock.upstreamPrompt ||
        legacyKeyMigrated;
      policyBlock.valueFeedback = nextBlock;
      if (changedFlag) {
        mutation.persist(data);
      }

      const actor = options.actor ?? policyColonInvocation("enable-value-feedback");
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        "valueFeedback.enabled=true",
        `emitEvents=${String(nextBlock.emitEvents)}`,
        `sessionLine=${String(nextBlock.sessionLine)}`,
        `upstreamPrompt=${String(nextBlock.upstreamPrompt)}`,
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      if (note) {
        parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      }
      appendAuditLog(projectRoot, parts.join(" "), changedFlag);
      return { changed: changedFlag };
    });

    const resolved = resolveValueFeedback(projectRoot);
    const lines = [
      `\u2713 ${FIELD_VALUE_FEEDBACK}.enabled=true (value-feedback ON).`,
      changed ? "  audit: meta/policy-changes.log updated." : POLICY_AUDIT_NOOP_STDOUT,
      formatValueFeedbackStatusLine(resolved),
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      return { exitCode: 2, stdout: `\u274c ${message}\n`, changed: false };
    }
    return { exitCode: 2, stdout: `\u274c Config error: ${message}\n`, changed: false };
  }
}

export interface ClearValueFeedbackOptions {
  readonly actor?: string;
  readonly note?: string;
}

export interface ClearValueFeedbackResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/**
 * Remove the typed `valueFeedback` key so trusted-org resolution can return to
 * org-auto (#2822). Does not delete the install-force-on marker — subsequent
 * updates will not re-force against intentional opt-out.
 */
export function clearValueFeedback(
  projectRoot: string,
  options: ClearValueFeedbackOptions = {},
): ClearValueFeedbackResult {
  const _path = projectDefinitionPath(projectRoot);
  try {
    const { changed } = withProjectDefinitionMutation(projectRoot, (mutation) => {
      const data = mutation.load();
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        throw new Error("PROJECT-DEFINITION 'plan' is not an object");
      }
      const plan = data.plan as Record<string, unknown>;
      migrateLegacyPolicyKey(plan);
      const existingPolicy = plan[PLAN_POLICY_KEY];
      if (
        typeof existingPolicy !== "object" ||
        existingPolicy === null ||
        Array.isArray(existingPolicy)
      ) {
        return { changed: false };
      }
      const policyBlock = existingPolicy as Record<string, unknown>;
      if (!("valueFeedback" in policyBlock)) {
        return { changed: false };
      }
      const previous = policyBlock.valueFeedback;
      delete policyBlock.valueFeedback;
      mutation.persist(data);

      const actor = options.actor ?? policyColonInvocation("clear-value-feedback");
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        "valueFeedback=cleared",
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      if (note) {
        parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      }
      appendAuditLog(projectRoot, parts.join(" "), true);
      return { changed: true };
    });

    const resolved = resolveValueFeedback(projectRoot);
    const lines = [
      `\u2713 ${FIELD_VALUE_FEEDBACK} typed key removed (resolution returns to org-auto/default).`,
      changed
        ? "  audit: meta/policy-changes.log updated."
        : "  no-op: typed key was already absent.",
      formatValueFeedbackStatusLine(resolved),
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("PROJECT-DEFINITION not found")) {
      return { exitCode: 2, stdout: `\u274c ${message}\n`, changed: false };
    }
    return { exitCode: 2, stdout: `\u274c Config error: ${message}\n`, changed: false };
  }
}
