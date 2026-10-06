/**
 * Typed plan.policy.specGuard (#1589 Prefer-A Bound / #5350 C3).
 *
 * Capacity-shaped advise|shadow|enforce drift guard + reserved sqaPass schema.
 * Namespaced under plan["x-directive/policy"] via readPlanPolicy.
 * Framework default stays advise; validate hook stays out of task check in v1.
 * Promote ladder: advise → shadow → enforce (refuse advise→enforce skip).
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveAuditPath } from "../layout/resolve.js";
import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import { appendAuditLog, loadProjectDefinition, POLICY_AUDIT_NOOP_STDOUT } from "./resolve.js";

/** Canonical dotted path for policy:show / PROJECT-DEFINITION. */
export const FIELD_SPEC_GUARD = "plan.policy.specGuard";

/** CLI alias for `task policy:show --field=specGuard`. */
export const FIELD_SPEC_GUARD_CLI_ALIAS = "specGuard";

/** Namespaced plan-item key for completion impact (#1589 / #1650). */
export const SPEC_IMPACT_KEY = "x-directive/specImpact";

export const SPEC_IMPACT_VALUES = new Set(["none", "delta", "new"] as const);
export type SpecImpactValue = "none" | "delta" | "new";

/** Drift enforcement ladder (#5350): advise soft → shadow warn → enforce hard. */
export const SPEC_GUARD_ENFORCEMENTS = new Set(["advise", "shadow", "enforce"] as const);
export type SpecGuardEnforcement = "advise" | "shadow" | "enforce";

export const SPEC_GUARD_TRIGGERS = new Set(["scope-complete", "audit", "both"] as const);
export type SpecGuardTrigger = "scope-complete" | "audit" | "both";

export const SQA_SAMPLING = new Set(["shape-changing", "all"] as const);
export type SqaSampling = "shape-changing" | "all";

export const SQA_ON_FAIL = new Set(["escalate", "advise"] as const);
export type SqaOnFail = "escalate" | "advise";

/** First-ship default: enabled advise (Bound closed decision). */
export const DEFAULT_SPEC_GUARD_ENABLED = true;
export const DEFAULT_DRIFT_ENFORCEMENT: SpecGuardEnforcement = "advise";
export const DEFAULT_DRIFT_TRIGGER: SpecGuardTrigger = "both";
export const DEFAULT_SQA_ENFORCEMENT: SpecGuardEnforcement = "advise";
export const DEFAULT_SQA_SAMPLING: SqaSampling = "shape-changing";
export const DEFAULT_SQA_ON_FAIL: SqaOnFail = "escalate";

/** Durable shadow-period attestation under xbrief/.audit/ (#5350 S1). */
export const SPEC_GUARD_SHADOW_ATTESTATION_NAME = "spec-guard-shadow-attestation.json";

export interface SpecGuardDriftGuard {
  readonly enforcement: SpecGuardEnforcement;
  readonly trigger: SpecGuardTrigger;
}

/**
 * Reserved SQA black-box pass schema (#1589 C3).
 * Engine is a documented no-op in v1; escalate may reuse pending-human-decisions later.
 */
export interface SpecGuardSqaPass {
  readonly enforcement: SpecGuardEnforcement;
  readonly sampling: SqaSampling;
  readonly onFail: SqaOnFail;
}

export interface SpecGuardConfig {
  readonly enabled: boolean;
  readonly driftGuard: SpecGuardDriftGuard;
  readonly sqaPass: SpecGuardSqaPass;
}

export type SpecGuardSource = "typed" | "default" | "default-on-error";

export interface SpecGuardResolved extends SpecGuardConfig {
  readonly source: SpecGuardSource;
  readonly error: string | null;
  /** Explicit unknown/unhardened baseline when no specification artifact exists. */
  readonly baselineStatus: "unknown" | "unhardened" | "present";
}

function defaultConfig(): SpecGuardConfig {
  return {
    enabled: DEFAULT_SPEC_GUARD_ENABLED,
    driftGuard: {
      enforcement: DEFAULT_DRIFT_ENFORCEMENT,
      trigger: DEFAULT_DRIFT_TRIGGER,
    },
    sqaPass: {
      enforcement: DEFAULT_SQA_ENFORCEMENT,
      sampling: DEFAULT_SQA_SAMPLING,
      onFail: DEFAULT_SQA_ON_FAIL,
    },
  };
}

function defaultResolved(
  source: SpecGuardSource,
  error: string | null = null,
  baselineStatus: SpecGuardResolved["baselineStatus"] = "unknown",
): SpecGuardResolved {
  return {
    ...defaultConfig(),
    source,
    error,
    baselineStatus,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a `plan.policy.specGuard` payload (including reserved sqaPass). */
export function validateSpecGuard(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${FIELD_SPEC_GUARD} must be an object; got ${typeof value}`];
  }
  const errors: string[] = [];
  if ("enabled" in value && typeof value.enabled !== "boolean") {
    errors.push(`${FIELD_SPEC_GUARD}.enabled must be a boolean`);
  }
  if ("driftGuard" in value) {
    if (!isRecord(value.driftGuard)) {
      errors.push(`${FIELD_SPEC_GUARD}.driftGuard must be an object`);
    } else {
      const dg = value.driftGuard;
      if (
        "enforcement" in dg &&
        (typeof dg.enforcement !== "string" ||
          !SPEC_GUARD_ENFORCEMENTS.has(dg.enforcement as SpecGuardEnforcement))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.driftGuard.enforcement must be one of advise|shadow|enforce; got ${String(dg.enforcement)}`,
        );
      }
      if (
        "trigger" in dg &&
        (typeof dg.trigger !== "string" || !SPEC_GUARD_TRIGGERS.has(dg.trigger as SpecGuardTrigger))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.driftGuard.trigger must be one of scope-complete|audit|both; got ${String(dg.trigger)}`,
        );
      }
    }
  }
  if ("sqaPass" in value) {
    if (!isRecord(value.sqaPass)) {
      errors.push(`${FIELD_SPEC_GUARD}.sqaPass must be an object`);
    } else {
      const sqa = value.sqaPass;
      if (
        "enforcement" in sqa &&
        (typeof sqa.enforcement !== "string" ||
          !SPEC_GUARD_ENFORCEMENTS.has(sqa.enforcement as SpecGuardEnforcement))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.sqaPass.enforcement must be one of advise|shadow|enforce; got ${String(sqa.enforcement)}`,
        );
      }
      if (
        "sampling" in sqa &&
        (typeof sqa.sampling !== "string" || !SQA_SAMPLING.has(sqa.sampling as SqaSampling))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.sqaPass.sampling must be one of shape-changing|all; got ${String(sqa.sampling)}`,
        );
      }
      if (
        "onFail" in sqa &&
        (typeof sqa.onFail !== "string" || !SQA_ON_FAIL.has(sqa.onFail as SqaOnFail))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.sqaPass.onFail must be one of escalate|advise; got ${String(sqa.onFail)}`,
        );
      }
    }
  }
  return errors;
}

function parseDriftGuard(raw: unknown): SpecGuardDriftGuard {
  if (!isRecord(raw)) {
    return { enforcement: DEFAULT_DRIFT_ENFORCEMENT, trigger: DEFAULT_DRIFT_TRIGGER };
  }
  const enforcement =
    typeof raw.enforcement === "string" &&
    SPEC_GUARD_ENFORCEMENTS.has(raw.enforcement as SpecGuardEnforcement)
      ? (raw.enforcement as SpecGuardEnforcement)
      : DEFAULT_DRIFT_ENFORCEMENT;
  const trigger =
    typeof raw.trigger === "string" && SPEC_GUARD_TRIGGERS.has(raw.trigger as SpecGuardTrigger)
      ? (raw.trigger as SpecGuardTrigger)
      : DEFAULT_DRIFT_TRIGGER;
  return { enforcement, trigger };
}

function parseSqaPass(raw: unknown): SpecGuardSqaPass {
  if (!isRecord(raw)) {
    return {
      enforcement: DEFAULT_SQA_ENFORCEMENT,
      sampling: DEFAULT_SQA_SAMPLING,
      onFail: DEFAULT_SQA_ON_FAIL,
    };
  }
  const enforcement =
    typeof raw.enforcement === "string" &&
    SPEC_GUARD_ENFORCEMENTS.has(raw.enforcement as SpecGuardEnforcement)
      ? (raw.enforcement as SpecGuardEnforcement)
      : DEFAULT_SQA_ENFORCEMENT;
  const sampling =
    typeof raw.sampling === "string" && SQA_SAMPLING.has(raw.sampling as SqaSampling)
      ? (raw.sampling as SqaSampling)
      : DEFAULT_SQA_SAMPLING;
  const onFail =
    typeof raw.onFail === "string" && SQA_ON_FAIL.has(raw.onFail as SqaOnFail)
      ? (raw.onFail as SqaOnFail)
      : DEFAULT_SQA_ON_FAIL;
  return { enforcement, sampling, onFail };
}

/** Resolve typed block without project I/O (unit-test seam). */
export function resolveSpecGuardFromTypedBlock(
  raw: unknown,
  baselineStatus: SpecGuardResolved["baselineStatus"] = "unknown",
): SpecGuardResolved {
  const errors = validateSpecGuard(raw);
  if (errors.length > 0) {
    return defaultResolved(
      "default-on-error",
      errors[0] ?? "invalid specGuard block",
      baselineStatus,
    );
  }
  if (!isRecord(raw)) {
    return defaultResolved("default", null, baselineStatus);
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SPEC_GUARD_ENABLED;
  return {
    enabled,
    driftGuard: parseDriftGuard(raw.driftGuard),
    sqaPass: parseSqaPass(raw.sqaPass),
    source: "typed",
    error: null,
    baselineStatus,
  };
}

export interface ResolveSpecGuardOptions {
  /** When true, baselineStatus becomes present if a specification artifact exists. */
  readonly hasSpecification?: boolean;
}

/**
 * Resolve plan.policy.specGuard from PROJECT-DEFINITION (#1589).
 * Malformed typed blocks self-heal to defaults (default-on-error).
 */
export function resolveSpecGuard(
  projectRoot: string,
  options: ResolveSpecGuardOptions = {},
): SpecGuardResolved {
  const baselineStatus: SpecGuardResolved["baselineStatus"] =
    options.hasSpecification === true ? "present" : "unknown";
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultResolved("default-on-error", err, baselineStatus);
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (!isRecord(policyBlock) || !("specGuard" in policyBlock)) {
    return defaultResolved("default", null, baselineStatus);
  }
  return resolveSpecGuardFromTypedBlock(policyBlock.specGuard, baselineStatus);
}

/** C3 reserved: sqaPass engine is a documented no-op in v1. */
export function runSqaPassNoop(_projectRoot: string): {
  readonly status: "noop";
  readonly message: string;
} {
  return {
    status: "noop",
    message:
      "specGuard.sqaPass engine is reserved (schema only) in v1; no SQA judgment runs (#1589 C3)",
  };
}

export function readSpecImpact(item: Record<string, unknown>): SpecImpactValue | null {
  const raw = item[SPEC_IMPACT_KEY];
  if (typeof raw !== "string") return null;
  return SPEC_IMPACT_VALUES.has(raw as SpecImpactValue) ? (raw as SpecImpactValue) : null;
}

export interface SpecGuardPolicyField {
  readonly name: typeof FIELD_SPEC_GUARD;
  readonly current: SpecGuardConfig;
  readonly default: SpecGuardConfig;
  readonly source: string;
}

/** Inspector row for `task policy:show --field=specGuard`. */
export function inspectSpecGuard(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): SpecGuardPolicyField {
  const resolved =
    projectRoot !== undefined && projectRoot.length > 0
      ? resolveSpecGuard(projectRoot)
      : defaultResolved("default");
  return {
    name: FIELD_SPEC_GUARD,
    current: {
      enabled: resolved.enabled,
      driftGuard: resolved.driftGuard,
      sqaPass: resolved.sqaPass,
    },
    default: defaultConfig(),
    source: resolved.source,
  };
}

export interface SpecGuardShadowAttestation {
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly actor: string;
  readonly fromEnforcement: SpecGuardEnforcement;
}

function shadowAttestationPath(projectRoot: string): string {
  return resolveAuditPath(projectRoot, SPEC_GUARD_SHADOW_ATTESTATION_NAME);
}

/** Read Bound-named recorded shadow attestation for promote S1. */
export function readSpecGuardShadowAttestation(
  projectRoot: string,
): SpecGuardShadowAttestation | null {
  const path = shadowAttestationPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) return null;
    if (typeof raw.startedAt !== "string") return null;
    if (typeof raw.actor !== "string") return null;
    const from =
      typeof raw.fromEnforcement === "string" &&
      SPEC_GUARD_ENFORCEMENTS.has(raw.fromEnforcement as SpecGuardEnforcement)
        ? (raw.fromEnforcement as SpecGuardEnforcement)
        : "advise";
    return {
      startedAt: raw.startedAt,
      endedAt: typeof raw.endedAt === "string" ? raw.endedAt : null,
      actor: raw.actor,
      fromEnforcement: from,
    };
  } catch {
    return null;
  }
}

function writeSpecGuardShadowAttestation(
  projectRoot: string,
  attestation: SpecGuardShadowAttestation,
): void {
  const root = resolve(projectRoot);
  const abs = shadowAttestationPath(root);
  const rel = relative(root, abs).replace(/\\/g, "/");
  containedWrite({
    root,
    target: rel,
    data: `${JSON.stringify(attestation, null, 2)}\n`,
    mode: existsSync(abs) ? "replace" : "create",
  });
}

/**
 * Typed promote gate (#5350 S1): refuse one-shot advise→enforce.
 * Allowed: advise→shadow, shadow→enforce, same-value no-op, enforce→shadow demote,
 * and advise→enforce only when a recorded shadow attestation exists.
 */
export function assertValidSpecGuardEnforcementPromote(
  from: SpecGuardEnforcement,
  to: SpecGuardEnforcement,
  options: { readonly hasShadowAttestation?: boolean } = {},
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (from === to) return { ok: true };
  if (from === "advise" && to === "shadow") return { ok: true };
  if (from === "shadow" && to === "enforce") return { ok: true };
  if (from === "enforce" && (to === "shadow" || to === "advise")) return { ok: true };
  if (from === "shadow" && to === "advise") return { ok: true };
  if (from === "advise" && to === "enforce") {
    if (options.hasShadowAttestation === true) {
      return { ok: true };
    }
    return {
      ok: false,
      message:
        "specGuard promote refused: advise→enforce skip is out of policy; " +
        "promote advise→shadow first (or record a shadow attestation), then shadow→enforce",
    };
  }
  return {
    ok: false,
    message: `specGuard promote refused: unsupported transition ${from}→${to}`,
  };
}

export const SPEC_GUARD_ENFORCEMENT_CAPABILITY_COST =
  "⚠ Capability-cost disclosure — promoting driftGuard.enforcement (#5350 / #1589):\n" +
  "  • advise — soft discharge (default; #5315 C1/C2).\n" +
  "  • shadow — same enforce evaluator; durable warnings; does NOT refuse scope:complete or fail CI solely for shadow hits.\n" +
  "  • enforce — hard fail-closed for named consumers (pre-move scope:complete + tasks/verify.yml). Exit 1 and 2 fail.\n" +
  "  • Promote ladder is advise → shadow → enforce. One-shot advise→enforce is refused without a recorded shadow period.\n" +
  "  • Hard operate promote on deftai/directive is reserved on #5374 (out of #5350 capability land).\n" +
  "  • Not spliced into bare `deft check` in v1.";

export interface PromoteSpecGuardEnforcementOptions {
  readonly to: SpecGuardEnforcement;
  readonly confirm: boolean;
  readonly actor?: string;
  readonly note?: string;
}

export interface PromoteSpecGuardEnforcementResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly changed: boolean;
  readonly from: SpecGuardEnforcement;
  readonly to: SpecGuardEnforcement;
}

/** Persist driftGuard.enforcement via typed confirm promote (#5350 limbs 1–2). */
export function promoteSpecGuardDriftEnforcement(
  projectRoot: string,
  options: PromoteSpecGuardEnforcementOptions,
): PromoteSpecGuardEnforcementResult {
  const to = options.to;
  if (!SPEC_GUARD_ENFORCEMENTS.has(to)) {
    return {
      exitCode: 2,
      stdout: `unknown enforcement '${String(to)}'; expected advise|shadow|enforce\n`,
      changed: false,
      from: DEFAULT_DRIFT_ENFORCEMENT,
      to,
    };
  }
  const current = resolveSpecGuard(projectRoot);
  const from = current.driftGuard.enforcement;
  if (!options.confirm) {
    return {
      exitCode: 1,
      stdout:
        `${SPEC_GUARD_ENFORCEMENT_CAPABILITY_COST}\n\n` +
        `Current driftGuard.enforcement=${from}. Requested=${to}.\n` +
        `Re-run with --confirm to apply: ${policyColonInvocation("set-spec-guard-enforcement", ` -- --set ${to} --confirm`)}\n`,
      changed: false,
      from,
      to,
    };
  }

  const attestation = readSpecGuardShadowAttestation(projectRoot);
  const gate = assertValidSpecGuardEnforcementPromote(from, to, {
    hasShadowAttestation: attestation !== null,
  });
  if (!gate.ok) {
    return {
      exitCode: 2,
      stdout: `${gate.message}\n`,
      changed: false,
      from,
      to,
    };
  }

  if (from === to) {
    return {
      exitCode: 0,
      stdout: `${POLICY_AUDIT_NOOP_STDOUT}\n`,
      changed: false,
      from,
      to,
    };
  }

  const actor = options.actor ?? "operator";
  const stampedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  try {
    const mutationResult = withProjectDefinitionMutation(projectRoot, (mutation) => {
      const data = mutation.load();
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          return {
            changed: false,
            error: "PROJECT-DEFINITION 'plan' is not an object",
          };
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
          return { changed: false, error: "plan.policy is not an object" };
        }
      }
      const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
      const prevGuard =
        typeof policyBlock.specGuard === "object" &&
        policyBlock.specGuard !== null &&
        !Array.isArray(policyBlock.specGuard)
          ? (policyBlock.specGuard as Record<string, unknown>)
          : {};
      const prevDrift =
        typeof prevGuard.driftGuard === "object" &&
        prevGuard.driftGuard !== null &&
        !Array.isArray(prevGuard.driftGuard)
          ? (prevGuard.driftGuard as Record<string, unknown>)
          : {};
      policyBlock.specGuard = {
        ...prevGuard,
        enabled:
          typeof prevGuard.enabled === "boolean" ? prevGuard.enabled : DEFAULT_SPEC_GUARD_ENABLED,
        driftGuard: {
          ...prevDrift,
          enforcement: to,
          trigger:
            typeof prevDrift.trigger === "string" &&
            SPEC_GUARD_TRIGGERS.has(prevDrift.trigger as SpecGuardTrigger)
              ? prevDrift.trigger
              : DEFAULT_DRIFT_TRIGGER,
        },
        sqaPass:
          typeof prevGuard.sqaPass === "object" &&
          prevGuard.sqaPass !== null &&
          !Array.isArray(prevGuard.sqaPass)
            ? prevGuard.sqaPass
            : {
                enforcement: DEFAULT_SQA_ENFORCEMENT,
                sampling: DEFAULT_SQA_SAMPLING,
                onFail: DEFAULT_SQA_ON_FAIL,
              },
      };
      mutation.persist(data);
      return { changed: true, error: null };
    });
    if (mutationResult.error !== null && mutationResult.error !== undefined) {
      return {
        exitCode: 2,
        stdout: `specGuard promote failed: ${mutationResult.error}\n`,
        changed: false,
        from,
        to,
      };
    }
    const changed = mutationResult.changed;

    try {
      if (to === "shadow") {
        writeSpecGuardShadowAttestation(projectRoot, {
          startedAt: stampedAt,
          endedAt: null,
          actor,
          fromEnforcement: from,
        });
      } else if (to === "enforce" && attestation !== null) {
        writeSpecGuardShadowAttestation(projectRoot, {
          ...attestation,
          endedAt: stampedAt,
        });
      }
    } catch (attestationErr) {
      // Attestation failure after policy persist must not leave shadow active
      // without a recorded attestation (advise→enforce skip hatch).
      if (changed) {
        try {
          withProjectDefinitionMutation(projectRoot, (mutation) => {
            const data = mutation.load();
            const plan = data.plan as Record<string, unknown>;
            migrateLegacyPolicyKey(plan);
            const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
            const prevGuard =
              typeof policyBlock.specGuard === "object" &&
              policyBlock.specGuard !== null &&
              !Array.isArray(policyBlock.specGuard)
                ? (policyBlock.specGuard as Record<string, unknown>)
                : {};
            const prevDrift =
              typeof prevGuard.driftGuard === "object" &&
              prevGuard.driftGuard !== null &&
              !Array.isArray(prevGuard.driftGuard)
                ? (prevGuard.driftGuard as Record<string, unknown>)
                : {};
            policyBlock.specGuard = {
              ...prevGuard,
              driftGuard: {
                ...prevDrift,
                enforcement: from,
              },
            };
            mutation.persist(data);
            return { changed: true };
          });
        } catch {
          /* best-effort rollback */
        }
      }
      return {
        exitCode: 2,
        stdout: `specGuard promote failed (attestation): ${String(attestationErr)}\n`,
        changed: false,
        from,
        to,
      };
    }

    const note = options.note?.replace(/\n/g, " ").replace(/\r/g, " ") ?? "";
    const auditParts = [
      `actor=${actor}`,
      `specGuard.driftGuard.enforcement=${to}`,
      `previous=${from}`,
    ];
    if (note.length > 0) auditParts.push(`note=${note}`);
    appendAuditLog(
      projectRoot,
      `${auditParts.join(" ")} changed=${changed ? "true" : "false"}`,
      changed,
    );

    return {
      exitCode: 0,
      stdout: `✓ plan.policy.specGuard.driftGuard.enforcement ${from} → ${to}\n`,
      changed,
      from,
      to,
    };
  } catch (err) {
    return {
      exitCode: 2,
      stdout: `specGuard promote failed: ${String(err)}\n`,
      changed: false,
      from,
      to,
    };
  }
}
