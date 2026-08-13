/**
 * Ceremony dial (#3214 / #3263): ritual depth = f(task size × model tier × project shape).
 *
 * Selection policy over existing pieces — not a new subsystem.
 * Composes:
 *   - strategies/rapid.md (light / rapid path)
 *   - #3014 minimal consumer AGENTS profile (research pointer; not yet a shipped deposit)
 *   - effort estimate (#1581), model routing (#1976/#818), host capability (#1461)
 *
 * Two-stage dial (#3214 design note / #1581 ordering) with tier-conditional cold-start (#3263):
 *   cold-start / incomplete size → **tier-conditional**:
 *     frontier (or unknown tier) → rapid; mid/low → standard (not rapid)
 *   escalate when evidence arrives (provisional M/L size, full matrix)
 * Full matrix: S × frontier → rapid; non-project → minimal; else scales up.
 * Override always available via plan.policy.ceremonyDial.override; audited on write.
 *
 * Audit path (#3263): session:start records depth + provisional reasons on
 * `.deft/ritual-state.json` under `ceremony_dial` — use `readCeremonyDialAudit`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RunSummaryEmitter } from "../run-summary/emit.js";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import { appendAuditLog, loadProjectDefinition, projectDefinitionPath } from "./resolve.js";

/** Canonical dotted policy field name. */
export const FIELD_CEREMONY_DIAL = "plan.policy.ceremonyDial";

/** Short alias for `policy:show --field=ceremonyDial`. */
export const FIELD_CEREMONY_DIAL_CLI_ALIAS = "ceremonyDial";

/** Depth ladder: less ceremony → more ceremony. */
export const CEREMONY_DEPTHS = ["minimal", "rapid", "standard", "elevated"] as const;
export type CeremonyDepth = (typeof CEREMONY_DEPTHS)[number];

/** Task size band (aligns with swarm size / effort estimate vocabulary). */
export const CEREMONY_TASK_SIZES = ["S", "M", "L", "XL"] as const;
export type CeremonyTaskSize = (typeof CEREMONY_TASK_SIZES)[number];

/**
 * Model capability tier for dial selection.
 * `frontier` = strongest class; `mid` benefits from structure; `low` needs more ceremony.
 */
export const CEREMONY_MODEL_TIERS = ["frontier", "mid", "low"] as const;
export type CeremonyModelTier = (typeof CEREMONY_MODEL_TIERS)[number];

/** Whether the session is project-shaped (Directive repo/work) or ad-hoc non-project. */
export const CEREMONY_PROJECT_SHAPES = ["project", "non-project"] as const;
export type CeremonyProjectShape = (typeof CEREMONY_PROJECT_SHAPES)[number];

/** Pointers for composition (not loaded as a subsystem — discovery only). */
export const CEREMONY_RAPID_STRATEGY_POINTER = "content/strategies/rapid.md";
export const CEREMONY_MINIMAL_AGENTS_PROFILE_POINTER =
  "docs/analysis/2026-07-31-minimal-consumer-agents-profile-research.md (#3014)";

export interface CeremonyDialConfig {
  /** When false, selection always returns standard (full ceremony). Default true. */
  readonly enabled?: boolean;
  /**
   * Force a depth regardless of inputs. Always wins when set.
   * Use null/omit for matrix selection.
   */
  readonly override?: CeremonyDepth | null;
}

export interface CeremonyDialInputs {
  readonly taskSize?: CeremonyTaskSize | null;
  readonly modelTier?: CeremonyModelTier | null;
  readonly projectShape?: CeremonyProjectShape | null;
}

export interface CeremonyDialProfile {
  readonly depth: CeremonyDepth;
  /**
   * Ritual steps auto-deferred at this depth (merged into session:start deferrals).
   * Matches QUICK_STEPS / GATED_STEPS names in session-start.
   */
  readonly autoDeferSteps: readonly string[];
  /** Skip fat cold-path work (verify tools, triage welcome, release probe, tickler). */
  readonly skipFatPath: boolean;
  /** How much lifecycle / history write budget this depth intends. */
  readonly lifecycleWrites: "minimal" | "light" | "full";
  /**
   * Literal acceptance-command verification is always required (#3267 / #3156).
   * Ceremony dial never skips capture+verbatim run — including rapid/minimal.
   */
  readonly literalAcceptanceRequired: true;
  readonly label: string;
}

export type CeremonyDialSource =
  | "override"
  | "matrix"
  | "default"
  | "disabled"
  | "typed"
  | "default-on-error";

export interface CeremonyDialComposition {
  /** Set when depth is rapid (light path). */
  readonly rapidStrategy: string | null;
  /** Set when depth is minimal (non-project / #3014 direction). */
  readonly minimalAgentsProfile: string | null;
}

export interface CeremonyDialSelection {
  readonly depth: CeremonyDepth;
  readonly source: CeremonyDialSource;
  readonly inputs: {
    readonly taskSize: CeremonyTaskSize | null;
    readonly modelTier: CeremonyModelTier | null;
    readonly projectShape: CeremonyProjectShape | null;
  };
  readonly profile: CeremonyDialProfile;
  readonly composition: CeremonyDialComposition;
  readonly config: CeremonyDialConfig;
  readonly error: string | null;
}

/**
 * Profiles scale *cold ceremony* only — verification depth is constant (#3156).
 *
 * ! Do NOT auto-defer gated readiness steps (`doctor`, `cache_fresh`,
 *   `agent_hooks`) — those stay required for mutation authorization
 *   (`verify:session-ritual --tier=gated`). Gated verify treats
 *   `deferred_reason` as satisfied, so dial-driven deferral would skip gates.
 * ! `verify_tools` also remains required on every dial depth (not skipFatPath).
 * ! Literal acceptance-command verification (#3267) is required at every depth
 *   (`literalAcceptanceRequired: true`), including rapid/minimal — capture exact
 *   stated commands at intake and run them verbatim before done. Extends #973.
 * ~ Rapid/minimal MAY lighten informational cold path only: triage welcome,
 *   optional network/release probe, staleness tickler.
 */
const PROFILES: Readonly<Record<CeremonyDepth, CeremonyDialProfile>> = {
  minimal: {
    depth: "minimal",
    // Cold-path only: never defer gated readiness (Greptile P1 #3214).
    autoDeferSteps: ["triage_welcome"],
    skipFatPath: true,
    lifecycleWrites: "minimal",
    literalAcceptanceRequired: true,
    label: "minimal (non-project / #3014 direction)",
  },
  rapid: {
    depth: "rapid",
    autoDeferSteps: ["triage_welcome"],
    skipFatPath: true,
    lifecycleWrites: "light",
    literalAcceptanceRequired: true,
    label: "rapid (strategies/rapid.md light path)",
  },
  standard: {
    depth: "standard",
    autoDeferSteps: [],
    skipFatPath: false,
    lifecycleWrites: "full",
    literalAcceptanceRequired: true,
    label: "standard (full session ritual)",
  },
  elevated: {
    depth: "elevated",
    autoDeferSteps: [],
    skipFatPath: false,
    lifecycleWrites: "full",
    literalAcceptanceRequired: true,
    label: "elevated (full ritual; prefer more gates for weaker tiers / large tasks)",
  },
};

export function ceremonyDialProfile(depth: CeremonyDepth): CeremonyDialProfile {
  return PROFILES[depth];
}

function compositionFor(depth: CeremonyDepth): CeremonyDialComposition {
  return {
    rapidStrategy: depth === "rapid" ? CEREMONY_RAPID_STRATEGY_POINTER : null,
    minimalAgentsProfile: depth === "minimal" ? CEREMONY_MINIMAL_AGENTS_PROFILE_POINTER : null,
  };
}

function isCeremonyDepth(value: unknown): value is CeremonyDepth {
  return typeof value === "string" && (CEREMONY_DEPTHS as readonly string[]).includes(value);
}

function isTaskSize(value: unknown): value is CeremonyTaskSize {
  return typeof value === "string" && (CEREMONY_TASK_SIZES as readonly string[]).includes(value);
}

function isModelTier(value: unknown): value is CeremonyModelTier {
  return typeof value === "string" && (CEREMONY_MODEL_TIERS as readonly string[]).includes(value);
}

function isProjectShape(value: unknown): value is CeremonyProjectShape {
  return (
    typeof value === "string" && (CEREMONY_PROJECT_SHAPES as readonly string[]).includes(value)
  );
}

/** Validate a typed `plan.policy.ceremonyDial` payload. */
export function validateCeremonyDial(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_CEREMONY_DIAL} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("enabled" in rec && typeof rec.enabled !== "boolean") {
    errors.push(`${FIELD_CEREMONY_DIAL}.enabled must be a boolean`);
  }
  if ("override" in rec && rec.override !== null && rec.override !== undefined) {
    if (!isCeremonyDepth(rec.override)) {
      errors.push(
        `${FIELD_CEREMONY_DIAL}.override must be one of ${CEREMONY_DEPTHS.join("|")} or null`,
      );
    }
  }
  return errors;
}

/**
 * Normalize free-form size tokens (swarm size vocabulary) into dial bands.
 * Accepts S|M|L|XL and small|medium|large|extra-large (case-insensitive).
 */
export function normalizeCeremonyTaskSize(raw: unknown): CeremonyTaskSize | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (isTaskSize(t)) return t;
  const low = t.toLowerCase();
  if (low === "s" || low === "small" || low === "xs" || low === "tiny") return "S";
  if (low === "m" || low === "medium" || low === "med") return "M";
  if (low === "l" || low === "large") return "L";
  if (low === "xl" || low === "extra-large" || low === "x-large" || low === "huge") return "XL";
  return null;
}

/**
 * Normalize model tier tokens. Frontier covers high/strong; mid covers medium;
 * low covers weak/economy.
 */
export function normalizeCeremonyModelTier(raw: unknown): CeremonyModelTier | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (isModelTier(t)) return t;
  const low = t.toLowerCase();
  if (
    low === "frontier" ||
    low === "high" ||
    low === "strong" ||
    low === "opus" ||
    low === "sota"
  ) {
    return "frontier";
  }
  if (low === "mid" || low === "medium" || low === "default" || low === "balanced") {
    return "mid";
  }
  if (low === "low" || low === "weak" || low === "economy" || low === "fast" || low === "cheap") {
    return "low";
  }
  return null;
}

export function normalizeCeremonyProjectShape(raw: unknown): CeremonyProjectShape | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (isProjectShape(t)) return t;
  const low = t.toLowerCase();
  if (low === "project" || low === "repo" || low === "directive") return "project";
  if (
    low === "non-project" ||
    low === "nonproject" ||
    low === "ad-hoc" ||
    low === "adhoc" ||
    low === "scratch"
  ) {
    return "non-project";
  }
  return null;
}

/**
 * Tier-conditional cold-start depth when task size is incomplete (#3263).
 *
 * Mid/low models benefit from structure on hard tasks and should not cold-start
 * at rapid (start-light / escalate-too-late signature). Frontier recovers from a
 * light start. Unknown tier stays rapid (optimistic cold default; pass
 * `--model-tier` / `DEFT_CEREMONY_MODEL_TIER` to unlock the mid/low floor).
 *
 * Escalate-on-evidence still applies when size later arrives (full matrix).
 */
export function selectCeremonyColdStartDepth(
  modelTier: CeremonyModelTier | null | undefined,
): CeremonyDepth {
  if (modelTier === "mid" || modelTier === "low") {
    return "standard";
  }
  // frontier or unknown → rapid
  return "rapid";
}

/**
 * Two-stage / partial-evidence selection when size or tier is missing
 * (#3214 design note / #3263 tier-conditional cold-start).
 *
 * Cold incomplete size is tier-conditional (#3263): mid/low → standard, frontier
 * or unknown → rapid. When size is known without tier, escalate on substantial
 * size (apps-bank safety). Does not invent plan-item effort (#1581 post-planning only).
 */
export function selectCeremonyDepthFromPartialEvidence(inputs: {
  readonly taskSize: CeremonyTaskSize | null;
  readonly modelTier: CeremonyModelTier | null;
}): CeremonyDepth {
  const size = inputs.taskSize;
  const tier = inputs.modelTier;

  // Size known, tier unknown — escalate on substantial size.
  if (size !== null && tier === null) {
    if (size === "S") return "rapid";
    if (size === "M") return "standard";
    return "elevated"; // L / XL
  }

  // Size incomplete (null), any tier including unknown: tier-conditional cold-start (#3263).
  // Callers with both size and tier set use the full matrix instead.
  return selectCeremonyColdStartDepth(tier);
}

/**
 * Pure default matrix (#3214 acceptance + #3263 tier-conditional cold-start):
 * - non-project → minimal (#3014 direction)
 * - S × frontier → rapid (strategies/rapid.md)
 * - S × mid → standard (mid-tier gains from structure)
 * - S × low → elevated
 * - M × low → elevated; M otherwise → standard
 * - L/XL → elevated (except L × frontier stays standard)
 * - Incomplete size → tier-conditional cold-start (#3263): mid/low → standard; frontier/unknown → rapid
 * - Size known, tier missing → escalate on M/L (partial evidence)
 */
export function selectCeremonyDepthFromMatrix(inputs: CeremonyDialInputs): CeremonyDepth {
  const shape = inputs.projectShape ?? null;
  if (shape === "non-project") {
    return "minimal";
  }

  const size = inputs.taskSize ?? null;
  const tier = inputs.modelTier ?? null;

  // Two-stage dial: incomplete matrix starts light; escalates on partial evidence.
  // ⊗ Do not default incomplete → standard (that was the #1581-ordering anti-pattern).
  if (size === null || tier === null) {
    return selectCeremonyDepthFromPartialEvidence({ taskSize: size, modelTier: tier });
  }

  if (size === "S" && tier === "frontier") return "rapid";
  if (size === "S" && tier === "mid") return "standard";
  if (size === "S" && tier === "low") return "elevated";

  if (size === "M" && tier === "low") return "elevated";
  if (size === "M") return "standard";

  if (size === "L" && tier === "frontier") return "standard";
  return "elevated";
}

function parseConfig(raw: unknown): { config: CeremonyDialConfig; error: string | null } {
  const errors = validateCeremonyDial(raw);
  if (errors.length > 0) {
    return {
      config: { enabled: true, override: null },
      error: errors[0] ?? "invalid ceremonyDial",
    };
  }
  if (raw === null || raw === undefined) {
    return { config: { enabled: true, override: null }, error: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { config: { enabled: true, override: null }, error: null };
  }
  const rec = raw as Record<string, unknown>;
  const enabled = typeof rec.enabled === "boolean" ? rec.enabled : true;
  let override: CeremonyDepth | null = null;
  if (isCeremonyDepth(rec.override)) {
    override = rec.override;
  } else if (rec.override === null) {
    override = null;
  }
  return { config: { enabled, override }, error: null };
}

export interface SelectCeremonyDepthOptions {
  readonly config?: CeremonyDialConfig;
  readonly inputs?: CeremonyDialInputs;
}

/**
 * Deterministic depth selection (pure; no IO).
 *
 * Precedence: disabled → standard; override → forced depth; else matrix on inputs;
 * empty inputs → **rapid** (unknown-tier cold default; #3263 mid/low need modelTier set).
 */
export function selectCeremonyDepth(
  options: SelectCeremonyDepthOptions = {},
): CeremonyDialSelection {
  const config: CeremonyDialConfig = {
    enabled: options.config?.enabled !== false,
    override: options.config?.override ?? null,
  };
  const inputs = {
    taskSize: options.inputs?.taskSize ?? null,
    modelTier: options.inputs?.modelTier ?? null,
    projectShape: options.inputs?.projectShape ?? null,
  };

  if (config.enabled === false) {
    const depth: CeremonyDepth = "standard";
    return {
      depth,
      source: "disabled",
      inputs,
      profile: ceremonyDialProfile(depth),
      composition: compositionFor(depth),
      config,
      error: null,
    };
  }

  if (config.override !== null && config.override !== undefined) {
    const depth = config.override;
    return {
      depth,
      source: "override",
      inputs,
      profile: ceremonyDialProfile(depth),
      composition: compositionFor(depth),
      config,
      error: null,
    };
  }

  const hasAnyInput =
    inputs.taskSize !== null || inputs.modelTier !== null || inputs.projectShape !== null;
  if (!hasAnyInput) {
    // Unknown-tier cold default (#3214 / #3263): rapid until modelTier or size arrives.
    const depth = selectCeremonyColdStartDepth(null);
    return {
      depth,
      source: "default",
      inputs,
      profile: ceremonyDialProfile(depth),
      composition: compositionFor(depth),
      config,
      error: null,
    };
  }

  const depth = selectCeremonyDepthFromMatrix(inputs);
  return {
    depth,
    source: "matrix",
    inputs,
    profile: ceremonyDialProfile(depth),
    composition: compositionFor(depth),
    config,
    error: null,
  };
}

export interface ResolveCeremonyDialOptions {
  readonly inputs?: CeremonyDialInputs;
  /** Explicit config bypasses PROJECT-DEFINITION load (tests). */
  readonly config?: CeremonyDialConfig;
}

/**
 * Resolve ceremony dial from PROJECT-DEFINITION policy + session inputs (#3214).
 */
export function resolveCeremonyDial(
  projectRoot: string,
  options: ResolveCeremonyDialOptions = {},
): CeremonyDialSelection {
  if (options.config !== undefined) {
    return selectCeremonyDepth({ config: options.config, inputs: options.inputs });
  }

  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    const selected = selectCeremonyDepth({ inputs: options.inputs });
    return {
      ...selected,
      source: err ? "default-on-error" : selected.source,
      error: err,
    };
  }

  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("ceremonyDial" in (policyBlock as Record<string, unknown>))
  ) {
    return selectCeremonyDepth({ inputs: options.inputs });
  }

  const raw = (policyBlock as Record<string, unknown>).ceremonyDial;
  const { config, error } = parseConfig(raw);
  if (error !== null) {
    const selected = selectCeremonyDepth({ inputs: options.inputs });
    return { ...selected, source: "default-on-error", error };
  }
  const selected = selectCeremonyDepth({ config, inputs: options.inputs });
  // Preserve typed presence when matrix/default still applies.
  if (selected.source === "default" || selected.source === "matrix") {
    return { ...selected, source: selected.source === "matrix" ? "matrix" : "typed" };
  }
  return selected;
}

/** Human-readable status line for session:start / policy:show. */
export function formatCeremonyDialStatusLine(
  selection: CeremonyDialSelection,
  extras?: {
    readonly startTierProvenance?: string;
  },
): string {
  const parts = [
    `[deft ceremony-dial] depth=${selection.depth}`,
    `source=${selection.source}`,
    `taskSize=${selection.inputs.taskSize ?? "-"}`,
    `modelTier=${selection.inputs.modelTier ?? "-"}`,
    `projectShape=${selection.inputs.projectShape ?? "-"}`,
  ];
  if (extras?.startTierProvenance !== undefined && extras.startTierProvenance.length > 0) {
    parts.push(`start-tier=${selection.depth}`);
    parts.push(`provenance=${extras.startTierProvenance}`);
  }
  if (selection.composition.rapidStrategy) {
    parts.push(`compose=${selection.composition.rapidStrategy}`);
  }
  if (selection.composition.minimalAgentsProfile) {
    parts.push(`compose=${selection.composition.minimalAgentsProfile}`);
  }
  return parts.join(" ");
}

/** JSON-serializable dial snapshot for ritual-state / session payload. */
export function ceremonyDialToDict(selection: CeremonyDialSelection): Record<string, unknown> {
  return {
    depth: selection.depth,
    source: selection.source,
    inputs: {
      taskSize: selection.inputs.taskSize,
      modelTier: selection.inputs.modelTier,
      projectShape: selection.inputs.projectShape,
    },
    profile: {
      depth: selection.profile.depth,
      autoDeferSteps: [...selection.profile.autoDeferSteps],
      skipFatPath: selection.profile.skipFatPath,
      lifecycleWrites: selection.profile.lifecycleWrites,
      literalAcceptanceRequired: selection.profile.literalAcceptanceRequired,
      label: selection.profile.label,
    },
    composition: {
      rapidStrategy: selection.composition.rapidStrategy,
      minimalAgentsProfile: selection.composition.minimalAgentsProfile,
    },
    config: {
      enabled: selection.config.enabled !== false,
      override: selection.config.override ?? null,
    },
    error: selection.error,
  };
}

export interface CeremonyDialPolicyField {
  readonly name: typeof FIELD_CEREMONY_DIAL;
  readonly current: CeremonyDialConfig & { selectedDepth?: CeremonyDepth };
  readonly default: CeremonyDialConfig;
  readonly source: string;
}

const DEFAULT_CONFIG: CeremonyDialConfig = { enabled: true, override: null };

/** Inspector row for `task policy:show --field=ceremonyDial`. */
export function inspectCeremonyDial(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): CeremonyDialPolicyField {
  const defaults = { ...DEFAULT_CONFIG };
  if (data === null) {
    return {
      name: FIELD_CEREMONY_DIAL,
      current: { ...defaults, selectedDepth: "rapid" },
      default: defaults,
      source: "default",
    };
  }

  const policyBlock = readPlanPolicy(data.plan);
  let config = defaults;
  let source = "default";
  let error: string | null = null;
  if (
    typeof policyBlock === "object" &&
    policyBlock !== null &&
    !Array.isArray(policyBlock) &&
    "ceremonyDial" in (policyBlock as Record<string, unknown>)
  ) {
    const parsed = parseConfig((policyBlock as Record<string, unknown>).ceremonyDial);
    config = parsed.config;
    error = parsed.error;
    source = parsed.error !== null ? "default-on-error" : "typed";
  }

  const selection =
    projectRoot !== undefined && projectRoot.length > 0
      ? resolveCeremonyDial(projectRoot)
      : selectCeremonyDepth({ config });

  let fieldSource = source;
  if (error !== null) {
    fieldSource = "default-on-error";
  } else if (source === "typed" && selection.source === "override") {
    fieldSource = "override";
  }

  return {
    name: FIELD_CEREMONY_DIAL,
    current: {
      enabled: config.enabled !== false,
      override: config.override ?? null,
      selectedDepth: selection.depth,
    },
    default: defaults,
    source: fieldSource,
  };
}

export interface SetCeremonyDialOptions {
  readonly enabled?: boolean;
  readonly override?: CeremonyDepth | null;
  readonly actor?: string;
  readonly note?: string;
  readonly confirm?: boolean;
}

export interface SetCeremonyDialResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/**
 * Persist plan.policy.ceremonyDial (override + enabled) with audit trail (#3214).
 * Requires --confirm for override writes (capability-cost style disclosure).
 */
export function setCeremonyDial(
  projectRoot: string,
  options: SetCeremonyDialOptions,
): SetCeremonyDialResult {
  if (options.confirm !== true) {
    return {
      exitCode: 1,
      stdout:
        "Ceremony dial changes ritual/gate depth for session:start.\n" +
        "  Re-run with --confirm to apply.\n" +
        `  Inspect: ${policyColonInvocation("show", " --field=ceremonyDial")}\n`,
      changed: false,
    };
  }

  const path = projectDefinitionPath(projectRoot);
  try {
    const { changed } = projectDefinitionMutationLock(projectRoot, () => {
      const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
      }
      const data = parsed as Record<string, unknown>;
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          throw new Error("PROJECT-DEFINITION 'plan' is not an object");
        }
      }
      const plan = data.plan as Record<string, unknown>;
      migrateLegacyPolicyKey(plan);
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
      const previous = policyBlock.ceremonyDial;
      const prevObj =
        typeof previous === "object" && previous !== null && !Array.isArray(previous)
          ? (previous as Record<string, unknown>)
          : {};

      const nextEnabled =
        typeof options.enabled === "boolean"
          ? options.enabled
          : typeof prevObj.enabled === "boolean"
            ? prevObj.enabled
            : true;
      let nextOverride: CeremonyDepth | null = null;
      if (options.override !== undefined) {
        nextOverride = options.override;
      } else if (isCeremonyDepth(prevObj.override)) {
        nextOverride = prevObj.override;
      } else if (prevObj.override === null) {
        nextOverride = null;
      }

      const nextBlock: CeremonyDialConfig = {
        enabled: nextEnabled,
        override: nextOverride,
      };
      const prevParsed = parseConfig(previous).config;
      const changedFlag =
        prevParsed.enabled !== nextBlock.enabled || prevParsed.override !== nextBlock.override;

      policyBlock.ceremonyDial = nextBlock;
      if (changedFlag) {
        atomicWriteProjectDefinition(path, data);
      }

      const actor = options.actor ?? policyColonInvocation("set-ceremony-dial");
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        `ceremonyDial.enabled=${String(nextBlock.enabled)}`,
        `ceremonyDial.override=${nextBlock.override ?? "null"}`,
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      if (note) {
        parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      }
      appendAuditLog(projectRoot, parts.join(" "));
      return { changed: changedFlag };
    });

    const resolved = resolveCeremonyDial(projectRoot);
    const lines = [
      `\u2713 ${FIELD_CEREMONY_DIAL} updated.`,
      changed
        ? "  audit: meta/policy-changes.log updated."
        : "  no-op: value already matched (audit entry still appended for trail).",
      formatCeremonyDialStatusLine(resolved),
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

/**
 * Merge dial auto-defer steps into an existing deferrals map without clobbering
 * operator-supplied reasons.
 */
export function mergeCeremonyDialDeferrals(
  existing: Readonly<Record<string, string>>,
  selection: CeremonyDialSelection,
): Record<string, string> {
  const out: Record<string, string> = { ...existing };
  const reason = `ceremony-dial depth=${selection.depth}`;
  for (const step of selection.profile.autoDeferSteps) {
    if (!(step in out)) {
      out[step] = reason;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intake-time provisional estimate (#3214 design note option 1 / #1581 ordering)
// ---------------------------------------------------------------------------

/** Env keys for headless dial inputs (no operator confirmation). */
export const ENV_CEREMONY_TASK_SIZE = "DEFT_CEREMONY_TASK_SIZE";
export const ENV_CEREMONY_MODEL_TIER = "DEFT_CEREMONY_MODEL_TIER";
export const ENV_CEREMONY_PROJECT_SHAPE = "DEFT_CEREMONY_PROJECT_SHAPE";
/** Optional host model hint used when DEFT_CEREMONY_MODEL_TIER is unset. */
export const ENV_CEREMONY_MODEL_HINT = "DEFT_MODEL";

export interface ProvisionalCeremonyEstimateHints {
  /** Free-text task / prompt (optional; headless may omit). */
  readonly promptText?: string | null;
  /** Closed-verb or action verb token when known. */
  readonly verb?: string | null;
  /** Paths in scope (files or dirs); used for file-count / multi-area signals. */
  readonly filePaths?: readonly string[] | null;
  /** Explicit file count when paths are not enumerated. */
  readonly fileCount?: number | null;
  /** Process env for headless size/tier/shape overrides. */
  readonly env?: NodeJS.ProcessEnv;
  /** Project root for deposit-based project-shape detection. */
  readonly projectRoot?: string | null;
}

export interface ProvisionalCeremonyEstimate {
  readonly taskSize: CeremonyTaskSize | null;
  readonly modelTier: CeremonyModelTier | null;
  readonly projectShape: CeremonyProjectShape | null;
  /** Why each filled field was chosen (headless diagnostics). */
  readonly reasons: readonly string[];
}

const SMALL_VERBS = new Set([
  "fix",
  "typo",
  "docs",
  "doc",
  "chore",
  "lint",
  "format",
  "rename",
  "bump",
  "patch",
  "tweak",
  "nit",
  "spellcheck",
]);

const MEDIUM_VERBS = new Set([
  "implement",
  "add",
  "feature",
  "update",
  "ship",
  "build",
  "wire",
  "land",
  "extend",
  "improve",
  "refine",
]);

const LARGE_VERBS = new Set([
  "refactor",
  "migrate",
  "swarm",
  "epic",
  "redesign",
  "rewrite",
  "overhaul",
  "rearchitect",
  "through-merge",
  "through_merge",
  "port",
  "extract",
]);

const XL_PROMPT_MARKERS =
  /\b(multi[- ]?repo|platform[- ]wide|full rewrite|architecture overhaul|cohort|through[- ]merge)\b/i;
const LARGE_PROMPT_MARKERS =
  /\b(refactor|migrate|swarm|epic|redesign|rearchitect|umbrella|multi[- ]file|large)\b/i;
const SMALL_PROMPT_MARKERS =
  /\b(typo|nit|docs? only|one[- ]liner|single[- ]line|trivial|cosmetic|spelling)\b/i;

/**
 * Detect project shape from deposit layout (headless, no prompts).
 * Returns `project` when vanilla deposit markers exist; **null** when unknown
 * (two-stage cold default stays rapid — do not invent non-project without evidence).
 * Explicit `non-project` comes from CLI/env only.
 */
export function detectCeremonyProjectShape(projectRoot: string): CeremonyProjectShape | null {
  try {
    const pd = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    if (existsSync(pd) && statSync(pd).isFile()) {
      return "project";
    }
    const agents = join(projectRoot, "AGENTS.md");
    const xbriefDir = join(projectRoot, "xbrief");
    if (existsSync(agents) && existsSync(xbriefDir) && statSync(xbriefDir).isDirectory()) {
      return "project";
    }
    const deftCore = join(projectRoot, ".deft", "core");
    if (existsSync(deftCore) && statSync(deftCore).isDirectory()) {
      return "project";
    }
  } catch {
    // unknown on IO errors — stay null so cold default remains rapid
  }
  return null;
}

function rankSize(size: CeremonyTaskSize): number {
  switch (size) {
    case "S":
      return 0;
    case "M":
      return 1;
    case "L":
      return 2;
    case "XL":
      return 3;
    default:
      return 0;
  }
}

function maxSize(a: CeremonyTaskSize | null, b: CeremonyTaskSize | null): CeremonyTaskSize | null {
  if (a === null) return b;
  if (b === null) return a;
  return rankSize(a) >= rankSize(b) ? a : b;
}

function sizeFromFileCount(count: number): CeremonyTaskSize | null {
  if (count <= 0) return null;
  if (count <= 2) return "S";
  if (count <= 10) return "M";
  if (count <= 40) return "L";
  return "XL";
}

function sizeFromVerb(verb: string): CeremonyTaskSize | null {
  const v = verb.trim().toLowerCase().replace(/_/g, "-");
  if (v.length === 0) return null;
  if (SMALL_VERBS.has(v)) return "S";
  if (MEDIUM_VERBS.has(v)) return "M";
  if (LARGE_VERBS.has(v)) return "L";
  const first = v.split(/[\s:/]+/)[0] ?? "";
  if (SMALL_VERBS.has(first)) return "S";
  if (MEDIUM_VERBS.has(first)) return "M";
  if (LARGE_VERBS.has(first)) return "L";
  return null;
}

function sizeFromPrompt(text: string): CeremonyTaskSize | null {
  const t = text.trim();
  if (t.length === 0) return null;
  if (XL_PROMPT_MARKERS.test(t) || t.length > 4000) return "XL";
  if (LARGE_PROMPT_MARKERS.test(t) || t.length > 1500) return "L";
  if (SMALL_PROMPT_MARKERS.test(t) && t.length < 400) return "S";
  if (t.length > 600) return "M";
  if (t.length < 120) return "S";
  return null;
}

/**
 * Headless-safe provisional S/M/L (+ optional tier/shape) **before** ritual.
 * No operator confirmation. Plan-item effort (#1581) later confirms/corrects.
 *
 * Signals (max-wins for size): env → verb class → file-scope count → prompt shape.
 * Project shape: env, else deposit detection when projectRoot is set.
 */
export function estimateProvisionalCeremonyInputs(
  hints: ProvisionalCeremonyEstimateHints = {},
): ProvisionalCeremonyEstimate {
  const env = hints.env ?? process.env;
  const reasons: string[] = [];

  let taskSize: CeremonyTaskSize | null = normalizeCeremonyTaskSize(
    env[ENV_CEREMONY_TASK_SIZE] ?? env.DEFT_TASK_SIZE,
  );
  if (taskSize !== null) {
    reasons.push(`taskSize=${taskSize} from env`);
  }

  const modelTier: CeremonyModelTier | null = normalizeCeremonyModelTier(
    env[ENV_CEREMONY_MODEL_TIER] ?? env[ENV_CEREMONY_MODEL_HINT],
  );
  if (modelTier !== null) {
    reasons.push(`modelTier=${modelTier} from env`);
  }

  let projectShape: CeremonyProjectShape | null = normalizeCeremonyProjectShape(
    env[ENV_CEREMONY_PROJECT_SHAPE],
  );
  if (projectShape !== null) {
    reasons.push(`projectShape=${projectShape} from env`);
  }

  if (taskSize === null && typeof hints.verb === "string") {
    const fromVerb = sizeFromVerb(hints.verb);
    if (fromVerb !== null) {
      taskSize = fromVerb;
      reasons.push(`taskSize=${fromVerb} from verb=${hints.verb.trim()}`);
    }
  }

  {
    let fileCount = typeof hints.fileCount === "number" ? hints.fileCount : null;
    if (fileCount === null && Array.isArray(hints.filePaths)) {
      fileCount = hints.filePaths.length;
    }
    if (fileCount !== null && fileCount > 0) {
      const fromFiles = sizeFromFileCount(fileCount);
      if (fromFiles !== null) {
        const next = maxSize(taskSize, fromFiles);
        if (next !== taskSize) {
          taskSize = next;
          reasons.push(`taskSize=${next} from fileCount=${fileCount}`);
        }
      }
    }
  }

  if (typeof hints.promptText === "string" && hints.promptText.trim().length > 0) {
    const fromPrompt = sizeFromPrompt(hints.promptText);
    if (fromPrompt !== null) {
      const next = maxSize(taskSize, fromPrompt);
      if (next !== taskSize) {
        taskSize = next;
        reasons.push(`taskSize=${next} from prompt shape`);
      }
    }
  }

  if (
    projectShape === null &&
    typeof hints.projectRoot === "string" &&
    hints.projectRoot.length > 0
  ) {
    const detected = detectCeremonyProjectShape(hints.projectRoot);
    if (detected !== null) {
      projectShape = detected;
      reasons.push(`projectShape=${detected} from deposit layout`);
    }
  }

  return { taskSize, modelTier, projectShape, reasons };
}

/**
 * Merge explicit dial inputs over provisional estimates. Explicit non-null wins.
 * Used by session:start so vanilla deposit gets provisional fill without policy opt-in.
 */
export function mergeCeremonyDialInputsWithProvisional(
  explicit: CeremonyDialInputs | undefined,
  provisional: ProvisionalCeremonyEstimate,
): CeremonyDialInputs {
  return {
    taskSize: explicit?.taskSize ?? provisional.taskSize ?? null,
    modelTier: explicit?.modelTier ?? provisional.modelTier ?? null,
    projectShape: explicit?.projectShape ?? provisional.projectShape ?? null,
  };
}

/**
 * Resolve dial inputs for session:start: explicit CLI/options first, then
 * headless provisional classifier (env / verb / files / prompt / deposit).
 * ⊗ Does not read plan-item effort (#1581) — that lands post-planning only.
 */
export function resolveSessionCeremonyDialInputs(
  projectRoot: string,
  explicit?: CeremonyDialInputs,
  options: Omit<ProvisionalCeremonyEstimateHints, "projectRoot"> = {},
): {
  readonly inputs: CeremonyDialInputs;
  readonly provisional: ProvisionalCeremonyEstimate;
} {
  const provisional = estimateProvisionalCeremonyInputs({
    ...options,
    projectRoot,
  });
  return {
    inputs: mergeCeremonyDialInputsWithProvisional(explicit, provisional),
    provisional,
  };
}

// ---------------------------------------------------------------------------
// Audit path — read depth/provisional already recorded at session start (#3263)
// ---------------------------------------------------------------------------

export interface CeremonyDialAuditProvisional {
  readonly taskSize: CeremonyTaskSize | null;
  readonly modelTier: CeremonyModelTier | null;
  readonly projectShape: CeremonyProjectShape | null;
  readonly reasons: readonly string[];
}

/**
 * Snapshot of dial selection recorded on `.deft/ritual-state.json` at session:start.
 * Operators audit failed-task depth / provisional reasons without re-running ritual.
 */
export interface CeremonyDialAuditSnapshot {
  readonly path: string;
  readonly depth: CeremonyDepth | null;
  readonly source: string | null;
  readonly inputs: {
    readonly taskSize: CeremonyTaskSize | null;
    readonly modelTier: CeremonyModelTier | null;
    readonly projectShape: CeremonyProjectShape | null;
  } | null;
  readonly provisional: CeremonyDialAuditProvisional | null;
  readonly raw: Record<string, unknown> | null;
  readonly error: string | null;
}

function asOptionalDepth(value: unknown): CeremonyDepth | null {
  return isCeremonyDepth(value) ? value : null;
}

function asOptionalTaskSize(value: unknown): CeremonyTaskSize | null {
  return isTaskSize(value) ? value : null;
}

function asOptionalModelTier(value: unknown): CeremonyModelTier | null {
  return isModelTier(value) ? value : null;
}

function asOptionalProjectShape(value: unknown): CeremonyProjectShape | null {
  return isProjectShape(value) ? value : null;
}

/**
 * Read ceremony dial depth + provisional reasons from ritual-state (#3263 audit path).
 * session:start already writes `ceremony_dial` (incl. provisional) — this is the
 * operator/read path so failed runs can confirm start-light vs escalate timing.
 *
 * Returns `error` when ritual-state is missing/unreadable or lacks `ceremony_dial`;
 * does not throw.
 */
export function readCeremonyDialAudit(projectRoot: string): CeremonyDialAuditSnapshot {
  const path = join(projectRoot, ".deft", "ritual-state.json");
  const empty = (error: string): CeremonyDialAuditSnapshot => ({
    path,
    depth: null,
    source: null,
    inputs: null,
    provisional: null,
    raw: null,
    error,
  });

  try {
    if (!existsSync(path) || !statSync(path).isFile()) {
      return empty(`ritual-state missing at ${path}`);
    }
  } catch (exc) {
    return empty(`ritual-state unreadable at ${path}: ${String(exc)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, { encoding: "utf8" }));
  } catch (exc) {
    if (exc instanceof SyntaxError) {
      return empty(`ritual-state is not valid JSON: ${exc.message}`);
    }
    return empty(`ritual-state cannot be read: ${String(exc)}`);
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return empty("ritual-state top-level value must be an object");
  }

  const root = payload as Record<string, unknown>;
  const dialRaw = root.ceremony_dial;
  if (dialRaw === undefined || dialRaw === null) {
    return empty("ritual-state has no ceremony_dial field (pre-#3214 or non-mutation session)");
  }
  if (typeof dialRaw !== "object" || Array.isArray(dialRaw)) {
    return empty("ritual-state ceremony_dial must be an object");
  }

  const dial = dialRaw as Record<string, unknown>;
  const depth = asOptionalDepth(dial.depth);
  const source = typeof dial.source === "string" ? dial.source : null;

  let inputs: CeremonyDialAuditSnapshot["inputs"] = null;
  const inputsRaw = dial.inputs;
  if (typeof inputsRaw === "object" && inputsRaw !== null && !Array.isArray(inputsRaw)) {
    const rec = inputsRaw as Record<string, unknown>;
    inputs = {
      taskSize: asOptionalTaskSize(rec.taskSize),
      modelTier: asOptionalModelTier(rec.modelTier),
      projectShape: asOptionalProjectShape(rec.projectShape),
    };
  }

  let provisional: CeremonyDialAuditProvisional | null = null;
  const provRaw = dial.provisional;
  if (typeof provRaw === "object" && provRaw !== null && !Array.isArray(provRaw)) {
    const rec = provRaw as Record<string, unknown>;
    const reasons = Array.isArray(rec.reasons)
      ? rec.reasons.filter((r): r is string => typeof r === "string")
      : [];
    provisional = {
      taskSize: asOptionalTaskSize(rec.taskSize),
      modelTier: asOptionalModelTier(rec.modelTier),
      projectShape: asOptionalProjectShape(rec.projectShape),
      reasons,
    };
  }

  return {
    path,
    depth,
    source,
    inputs,
    provisional,
    raw: { ...dial },
    error: null,
  };
}

/** Collapse whitespace so operator audit lines stay single-line (Greptile P2 #3263). */
function oneLineAuditToken(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** One-line operator summary for audit tooling / failed-task forensics (#3263). */
export function formatCeremonyDialAuditLine(audit: CeremonyDialAuditSnapshot): string {
  if (audit.error !== null) {
    return `[deft ceremony-dial audit] error=${oneLineAuditToken(audit.error)}`;
  }
  const parts = [
    `[deft ceremony-dial audit] depth=${audit.depth ?? "-"}`,
    `source=${audit.source ?? "-"}`,
    `taskSize=${audit.inputs?.taskSize ?? "-"}`,
    `modelTier=${audit.inputs?.modelTier ?? "-"}`,
    `projectShape=${audit.inputs?.projectShape ?? "-"}`,
  ];
  if (audit.provisional !== null) {
    const reasons =
      audit.provisional.reasons.length > 0
        ? audit.provisional.reasons
            .map(oneLineAuditToken)
            .filter((r) => r.length > 0)
            .join("; ")
        : "(none)";
    parts.push(`provisional.reasons=${reasons.length > 0 ? reasons : "(none)"}`);
  }
  return parts.join(" ");
}

/**
 * Reified dial transition for run-summary telemetry (#3282).
 *
 * IMPLEMENTATION PREREQUISITE from the issue: dial transitions must be
 * engine-managed events, not prose-only policy. This function is the CLI-facing
 * transition hook (`policy:set-ceremony-dial` / dial escalate): it persists the
 * override (when confirm) and always emits a `dial_transition` run-summary line
 * when a depth change is applied.
 */
export interface EscalateCeremonyDialOptions {
  readonly to: CeremonyDepth;
  readonly reason: string;
  readonly evidence?: string;
  readonly sessionId?: string;
  readonly confirm?: boolean;
  readonly actor?: string;
  readonly note?: string;
  /** When false, skip run-summary emission (tests). Default true. */
  readonly emitRunSummary?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface EscalateCeremonyDialResult {
  readonly exitCode: number;
  readonly from: CeremonyDepth | null;
  readonly to: CeremonyDepth;
  readonly changed: boolean;
  readonly lines: readonly string[];
}

export function escalateCeremonyDial(
  projectRoot: string,
  options: EscalateCeremonyDialOptions,
): EscalateCeremonyDialResult {
  const prior = resolveCeremonyDial(projectRoot);
  const from = prior.depth;
  const emitEscalationEvaluation = (applied: boolean, reasonSuffix?: string): void => {
    if (options.emitRunSummary === false) {
      return;
    }
    try {
      const audit = readCeremonyDialAudit(projectRoot);
      const rawSid = (audit.raw as { session_id?: unknown } | null)?.session_id;
      const sid =
        options.sessionId ??
        (typeof rawSid === "string" && rawSid.length > 0
          ? rawSid
          : `dial-${Date.now().toString(36)}`);
      const rank: Record<CeremonyDepth, number> = {
        minimal: 0,
        rapid: 1,
        standard: 2,
        elevated: 3,
      };
      const raised = rank[options.to] > rank[from];
      const outcome = applied && raised ? "escalated" : "declined";
      const baseReason =
        options.confirm === true
          ? options.reason
          : `${options.reason}; not applied (need --confirm)`;
      const reason =
        reasonSuffix !== undefined && reasonSuffix.length > 0
          ? `${baseReason}; ${reasonSuffix}`
          : baseReason;
      const emitter = new RunSummaryEmitter({
        projectRoot,
        sessionId: sid,
        env: options.env,
      });
      emitter.emitDialEscalationEvaluation({
        tier: outcome === "escalated" ? options.to : from,
        outcome,
        reason,
      });
      emitter.emitKnownToolTurnDenominator();
    } catch {
      // fail-open
    }
  };
  if (options.confirm !== true) {
    emitEscalationEvaluation(false);
    return {
      exitCode: 1,
      from,
      to: options.to,
      changed: false,
      lines: [
        "Ceremony dial escalate changes ritual depth for future session:start.",
        "  Re-run with --confirm to apply.",
        `  Proposed: ${from} -> ${options.to} (reason: ${oneLineAuditToken(options.reason)})`,
      ],
    };
  }
  const setResult = setCeremonyDial(projectRoot, {
    override: options.to,
    confirm: true,
    actor: options.actor ?? policyColonInvocation("set-ceremony-dial"),
    note: options.note ?? `escalate: ${options.reason}`,
  });
  if (setResult.exitCode !== 0) {
    const persistDetail = oneLineAuditToken(
      setResult.stdout.trim().split("\n")[0] ?? `exit ${setResult.exitCode}`,
    );
    emitEscalationEvaluation(
      false,
      `persist failed (exit ${setResult.exitCode}): ${persistDetail}`,
    );
    return {
      exitCode: setResult.exitCode,
      from,
      to: options.to,
      changed: false,
      lines: setResult.stdout
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0),
    };
  }
  // #3319: evaluation event on every escalate path (applied or not).
  emitEscalationEvaluation(true);
  // #3282: event-driven dial_transition line (fail-open).
  if (options.emitRunSummary !== false) {
    try {
      const audit = readCeremonyDialAudit(projectRoot);
      const rawSid = (audit.raw as { session_id?: unknown } | null)?.session_id;
      const sid =
        options.sessionId ??
        (typeof rawSid === "string" && rawSid.length > 0
          ? rawSid
          : `dial-${Date.now().toString(36)}`);
      const emitter = new RunSummaryEmitter({
        projectRoot,
        sessionId: sid,
        env: options.env,
      });
      emitter.emitDialTransition({
        from,
        to: options.to,
        reason: options.reason,
        evidence: options.evidence,
      });
      emitter.emitKnownToolTurnDenominator();
    } catch {
      // fail-open
    }
  }
  return {
    exitCode: 0,
    from,
    to: options.to,
    changed: setResult.changed || from !== options.to,
    lines: [
      `✓ ceremony dial escalate: ${from} -> ${options.to}`,
      `  reason: ${oneLineAuditToken(options.reason)}`,
      ...(options.evidence ? [`  evidence: ${oneLineAuditToken(options.evidence)}`] : []),
      ...setResult.stdout
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0),
    ],
  };
}
