/**
 * Ceremony dial (#3214): ritual depth = f(task size × model tier × project shape).
 *
 * Selection policy over existing pieces — not a new subsystem.
 * Composes:
 *   - strategies/rapid.md (light / rapid path)
 *   - #3014 minimal consumer AGENTS profile (research pointer; not yet a shipped deposit)
 *   - effort estimate (#1581), model routing (#1976/#818), host capability (#1461)
 *
 * Defaults: S-task × frontier → rapid; non-project → minimal; else scales up.
 * Override always available via plan.policy.ceremonyDial.override; audited on write.
 */

import { readFileSync } from "node:fs";
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

const PROFILES: Readonly<Record<CeremonyDepth, CeremonyDialProfile>> = {
  minimal: {
    depth: "minimal",
    autoDeferSteps: ["triage_welcome", "doctor", "cache_fresh"],
    skipFatPath: true,
    lifecycleWrites: "minimal",
    label: "minimal (non-project / #3014 direction)",
  },
  rapid: {
    depth: "rapid",
    autoDeferSteps: ["triage_welcome", "doctor", "cache_fresh"],
    skipFatPath: true,
    lifecycleWrites: "light",
    label: "rapid (strategies/rapid.md light path)",
  },
  standard: {
    depth: "standard",
    autoDeferSteps: [],
    skipFatPath: false,
    lifecycleWrites: "full",
    label: "standard (full session ritual)",
  },
  elevated: {
    depth: "elevated",
    autoDeferSteps: [],
    skipFatPath: false,
    lifecycleWrites: "full",
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
 * Pure default matrix (#3214 acceptance):
 * - non-project → minimal (#3014 direction)
 * - S × frontier → rapid (strategies/rapid.md)
 * - S × mid → standard (mid-tier gains from structure)
 * - S × low → elevated
 * - M × low → elevated; M otherwise → standard
 * - L/XL → elevated (except L × frontier stays standard)
 * Missing inputs → caller decides (selectCeremonyDepth uses standard).
 */
export function selectCeremonyDepthFromMatrix(inputs: CeremonyDialInputs): CeremonyDepth {
  const shape = inputs.projectShape ?? null;
  if (shape === "non-project") {
    return "minimal";
  }

  const size = inputs.taskSize ?? null;
  const tier = inputs.modelTier ?? null;

  // Incomplete matrix inputs: do not invent rapid/minimal without evidence.
  if (size === null || tier === null) {
    return "standard";
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
 * empty inputs → standard.
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
    const depth: CeremonyDepth = "standard";
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
export function formatCeremonyDialStatusLine(selection: CeremonyDialSelection): string {
  const parts = [
    `[deft ceremony-dial] depth=${selection.depth}`,
    `source=${selection.source}`,
    `taskSize=${selection.inputs.taskSize ?? "-"}`,
    `modelTier=${selection.inputs.modelTier ?? "-"}`,
    `projectShape=${selection.inputs.projectShape ?? "-"}`,
  ];
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
      current: { ...defaults, selectedDepth: "standard" },
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
