import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import { isNoDeftDirectivePresent } from "./no-deft-directive.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { appendAuditLog, loadProjectDefinition, projectDefinitionPath } from "./resolve.js";
import {
  detectOriginOrg,
  isTrustedOrgAutoEnable,
  type OrgAutoEnableOptions,
} from "./value-feedback-autoenable.js";

/** Durable once-per-checkout marker for #2822 trusted-org install force-on. */
export const ORG_FORCE_ON_MARKER_REL = join(".deft-cache", "org-force-on-v2822.json");

export const ORG_FORCE_ON_MARKER_VERSION = 1 as const;

export interface OrgForceOnMarker {
  readonly version: typeof ORG_FORCE_ON_MARKER_VERSION;
  readonly appliedAt: string;
  readonly originOrg: string;
  readonly valueFeedback: boolean;
  readonly productSignal: boolean;
  readonly directiveVersion: string;
  /** Pre-apply typed valueFeedback snapshot for verify-on-skip (#2903). */
  readonly previousValueFeedback?: unknown;
  /** Pre-apply typed productSignal snapshot for verify-on-skip (#2903). */
  readonly previousProductSignal?: unknown;
}

/** Canonical typed block written by the one-time migration (#2822 Part A). */
export const FORCE_ON_VALUE_FEEDBACK_BLOCK = {
  enabled: true,
  emitEvents: true,
  sessionLine: true,
  upstreamPrompt: false,
} as const;

const DEFAULT_PRODUCT_SIGNAL_SINK = "deftai/product-signal";

function markerPath(projectRoot: string): string {
  return resolve(projectRoot, ORG_FORCE_ON_MARKER_REL);
}

/** Normalize undefined → null so marker snapshots compare stably with JSON. */
export function normalizePolicySnapshot(raw: unknown): unknown {
  return raw === undefined ? null : raw;
}

/** Structural equality via stable JSON (policy blocks are plain JSON values). */
export function deepEqualPolicySnapshot(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizePolicySnapshot(a)) === JSON.stringify(normalizePolicySnapshot(b));
}

function parseMarker(raw: unknown): OrgForceOnMarker | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (
    rec.version !== ORG_FORCE_ON_MARKER_VERSION ||
    typeof rec.appliedAt !== "string" ||
    typeof rec.originOrg !== "string" ||
    typeof rec.valueFeedback !== "boolean" ||
    typeof rec.productSignal !== "boolean" ||
    typeof rec.directiveVersion !== "string"
  ) {
    return null;
  }
  const marker: OrgForceOnMarker = {
    version: ORG_FORCE_ON_MARKER_VERSION,
    appliedAt: rec.appliedAt,
    originOrg: rec.originOrg,
    valueFeedback: rec.valueFeedback,
    productSignal: rec.productSignal,
    directiveVersion: rec.directiveVersion,
  };
  // Optional #2903 previous* snapshots — preserve when present (including null).
  if ("previousValueFeedback" in rec) {
    return {
      ...marker,
      previousValueFeedback: rec.previousValueFeedback,
      ...("previousProductSignal" in rec
        ? { previousProductSignal: rec.previousProductSignal }
        : {}),
    };
  }
  if ("previousProductSignal" in rec) {
    return {
      ...marker,
      previousProductSignal: rec.previousProductSignal,
    };
  }
  return marker;
}

/** Read the #2822 migration marker when present and valid. */
export function readOrgForceOnMarker(projectRoot: string): OrgForceOnMarker | null {
  const path = markerPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseMarker(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeOrgForceOnMarker(projectRoot: string, marker: OrgForceOnMarker): void {
  const path = markerPath(projectRoot);
  assertWriteTargetSafe(projectRoot, path);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function readTypedBoolean(raw: unknown, key: string, fallback: boolean): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fallback;
  }
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : fallback;
}

function valueFeedbackNeedsForceOn(raw: unknown): boolean {
  const enabled = readTypedBoolean(raw, "enabled", false);
  if (!enabled) {
    return true;
  }
  const emitEvents = readTypedBoolean(raw, "emitEvents", true);
  const sessionLine = readTypedBoolean(raw, "sessionLine", true);
  const upstreamPrompt = readTypedBoolean(raw, "upstreamPrompt", false);
  return !emitEvents || !sessionLine || upstreamPrompt;
}

function productSignalNeedsForceOn(raw: unknown): boolean {
  return !readTypedBoolean(raw, "enabled", false);
}

/**
 * Incomplete migration (#2903): marker present, PD still needs force-on, and
 * current typed block still equals the pre-migration snapshot (or legacy marker
 * has no previous* field — treat still-needs as incomplete for fleet recovery).
 */
export function isIncompleteForceOnField(
  needsForceOn: boolean,
  current: unknown,
  previousSnapshot: unknown | undefined,
  previousFieldPresent: boolean,
): boolean {
  if (!needsForceOn) {
    return false;
  }
  // Legacy markers written before #2903 lack previous* — re-apply once so
  // discarded-PD checkouts (statusreport-class) recover automatically.
  if (!previousFieldPresent) {
    return true;
  }
  return deepEqualPolicySnapshot(current, previousSnapshot);
}

function ensurePolicyBlock(plan: Record<string, unknown>): Record<string, unknown> {
  migrateLegacyPolicyKey(plan);
  const existing = plan[PLAN_POLICY_KEY];
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    if (existing === undefined) {
      plan[PLAN_POLICY_KEY] = {};
    } else {
      throw new Error("plan.policy is not an object");
    }
  }
  return plan[PLAN_POLICY_KEY] as Record<string, unknown>;
}

export interface RunOrgForceOnMigrationOptions {
  readonly autoEnable?: OrgAutoEnableOptions;
  readonly actor?: string;
  readonly now?: Date;
}

export interface OrgForceOnMigrationResult {
  readonly ran: boolean;
  readonly skippedReason: string | null;
  readonly valueFeedbackChanged: boolean;
  readonly productSignalChanged: boolean;
}

interface MarkerWriteInput {
  readonly valueFeedback: boolean;
  readonly productSignal: boolean;
  readonly previousValueFeedback: unknown;
  readonly previousProductSignal: unknown;
}

function writeMarker(
  projectRoot: string,
  options: RunOrgForceOnMigrationOptions,
  input: MarkerWriteInput,
): void {
  const originOrg = detectOriginOrg(projectRoot, options.autoEnable) ?? "unknown";
  const now = options.now ?? new Date();
  writeOrgForceOnMarker(projectRoot, {
    version: ORG_FORCE_ON_MARKER_VERSION,
    appliedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    originOrg,
    valueFeedback: input.valueFeedback,
    productSignal: input.productSignal,
    directiveVersion: readCorePackageVersion(),
    previousValueFeedback: normalizePolicySnapshot(input.previousValueFeedback),
    previousProductSignal: normalizePolicySnapshot(input.previousProductSignal),
  });
}

function readPolicyFieldSnapshots(projectRoot: string):
  | {
      readonly ok: true;
      readonly vfRaw: unknown;
      readonly psRaw: unknown;
      readonly needsVf: boolean;
      readonly needsPs: boolean;
    }
  | {
      readonly ok: false;
      readonly skippedReason: string;
    } {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { ok: false, skippedReason: err ?? "project-definition-missing" };
  }

  const policyBlock = readPlanPolicy(data.plan);
  const policyObj =
    typeof policyBlock === "object" && policyBlock !== null && !Array.isArray(policyBlock)
      ? (policyBlock as Record<string, unknown>)
      : {};

  const vfRaw = "valueFeedback" in policyObj ? policyObj.valueFeedback : undefined;
  const psRaw = "productSignal" in policyObj ? policyObj.productSignal : undefined;
  return {
    ok: true,
    vfRaw,
    psRaw,
    needsVf: valueFeedbackNeedsForceOn(vfRaw),
    needsPs: productSignalNeedsForceOn(psRaw),
  };
}

/**
 * One-time trusted-org install/upgrade force-on for valueFeedback + productSignal
 * (#2822). Idempotent via durable marker; non-trusted orgs are unchanged.
 *
 * #2903 verify-on-skip: when the marker is present but PROJECT-DEFINITION still
 * matches the pre-migration snapshot (discarded / never-landed force-on write),
 * re-apply. Intentional post-migration shapes that differ from both the previous
 * snapshot and the force-on block keep the skip.
 */
export function runOrgForceOnMigration(
  projectRoot: string,
  options: RunOrgForceOnMigrationOptions = {},
): OrgForceOnMigrationResult {
  // #2926: per-project opt-out wins over ambient trusted-org force-on (v1).
  if (isNoDeftDirectivePresent(projectRoot)) {
    return {
      ran: false,
      skippedReason: "no-deft-directive",
      valueFeedbackChanged: false,
      productSignalChanged: false,
    };
  }

  const existingMarker = readOrgForceOnMarker(projectRoot);

  if (existingMarker !== null) {
    const snapshots = readPolicyFieldSnapshots(projectRoot);
    if (!snapshots.ok) {
      return {
        ran: false,
        skippedReason: "marker-present",
        valueFeedbackChanged: false,
        productSignalChanged: false,
      };
    }

    const previousVfPresent = "previousValueFeedback" in existingMarker;
    const previousPsPresent = "previousProductSignal" in existingMarker;
    const incompleteVf = isIncompleteForceOnField(
      snapshots.needsVf,
      snapshots.vfRaw,
      existingMarker.previousValueFeedback,
      previousVfPresent,
    );
    const incompletePs = isIncompleteForceOnField(
      snapshots.needsPs,
      snapshots.psRaw,
      existingMarker.previousProductSignal,
      previousPsPresent,
    );

    // Marker present and either already force-on shaped, or intentional opt-out
    // (current differs from stored previous snapshot) → keep skip.
    if (!incompleteVf && !incompletePs) {
      return {
        ran: false,
        skippedReason: "marker-present",
        valueFeedbackChanged: false,
        productSignalChanged: false,
      };
    }

    // Incomplete migration: fall through to trusted-org apply with only the
    // incomplete fields re-forced.
    if (!isTrustedOrgAutoEnable(projectRoot, options.autoEnable)) {
      return {
        ran: false,
        skippedReason: "marker-present",
        valueFeedbackChanged: false,
        productSignalChanged: false,
      };
    }

    return applyForceOn(projectRoot, options, {
      needsVf: incompleteVf,
      needsPs: incompletePs,
      // previous* for the new marker = current (discarded) PD state.
      previousVf: snapshots.vfRaw,
      previousPs: snapshots.psRaw,
    });
  }

  if (!isTrustedOrgAutoEnable(projectRoot, options.autoEnable)) {
    return {
      ran: false,
      skippedReason: "non-trusted-org",
      valueFeedbackChanged: false,
      productSignalChanged: false,
    };
  }

  const snapshots = readPolicyFieldSnapshots(projectRoot);
  if (!snapshots.ok) {
    return {
      ran: false,
      skippedReason: snapshots.skippedReason,
      valueFeedbackChanged: false,
      productSignalChanged: false,
    };
  }

  if (!snapshots.needsVf && !snapshots.needsPs) {
    writeMarker(projectRoot, options, {
      valueFeedback: false,
      productSignal: false,
      previousValueFeedback: snapshots.vfRaw,
      previousProductSignal: snapshots.psRaw,
    });
    return {
      ran: false,
      skippedReason: "already-enabled",
      valueFeedbackChanged: false,
      productSignalChanged: false,
    };
  }

  return applyForceOn(projectRoot, options, {
    needsVf: snapshots.needsVf,
    needsPs: snapshots.needsPs,
    previousVf: snapshots.vfRaw,
    previousPs: snapshots.psRaw,
  });
}

function applyForceOn(
  projectRoot: string,
  options: RunOrgForceOnMigrationOptions,
  intent: {
    readonly needsVf: boolean;
    readonly needsPs: boolean;
    readonly previousVf: unknown;
    readonly previousPs: unknown;
  },
): OrgForceOnMigrationResult {
  const path = projectDefinitionPath(projectRoot);
  let valueFeedbackChanged = false;
  let productSignalChanged = false;
  let previousVf: unknown = intent.previousVf;
  let previousPs: unknown = intent.previousPs;

  projectDefinitionMutationLock(projectRoot, () => {
    const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
    }
    const rootData = parsed as Record<string, unknown>;
    if (
      typeof rootData.plan !== "object" ||
      rootData.plan === null ||
      Array.isArray(rootData.plan)
    ) {
      if (rootData.plan === undefined) {
        rootData.plan = {};
      } else {
        throw new Error("PROJECT-DEFINITION 'plan' is not an object");
      }
    }
    const plan = rootData.plan as Record<string, unknown>;
    const policy = ensurePolicyBlock(plan);
    previousVf = policy.valueFeedback;
    previousPs = policy.productSignal;

    if (intent.needsVf) {
      policy.valueFeedback = { ...FORCE_ON_VALUE_FEEDBACK_BLOCK };
      valueFeedbackChanged = valueFeedbackNeedsForceOn(previousVf);
    }

    if (intent.needsPs) {
      const prevObj =
        typeof previousPs === "object" && previousPs !== null && !Array.isArray(previousPs)
          ? (previousPs as Record<string, unknown>)
          : {};
      const sinkRepo =
        typeof prevObj.sinkRepo === "string" && prevObj.sinkRepo.trim().length > 0
          ? prevObj.sinkRepo.trim()
          : DEFAULT_PRODUCT_SIGNAL_SINK;
      policy.productSignal = { enabled: true, sinkRepo };
      productSignalChanged = productSignalNeedsForceOn(previousPs);
    }

    if (valueFeedbackChanged || productSignalChanged) {
      atomicWriteProjectDefinition(path, rootData);
    }

    const actor = options.actor ?? "directive-update";
    appendAuditLog(
      projectRoot,
      [
        `actor=${actor}`,
        "org-force-on-v2822",
        `valueFeedback=${intent.needsVf ? "forced-on" : "unchanged"}`,
        `productSignal=${intent.needsPs ? "forced-on" : "unchanged"}`,
        `previousValueFeedback=${JSON.stringify(normalizePolicySnapshot(previousVf))}`,
        `previousProductSignal=${JSON.stringify(normalizePolicySnapshot(previousPs))}`,
      ].join(" "),
    );

    writeMarker(projectRoot, options, {
      valueFeedback: intent.needsVf,
      productSignal: intent.needsPs,
      previousValueFeedback: previousVf,
      previousProductSignal: previousPs,
    });
    return { changed: valueFeedbackChanged || productSignalChanged };
  });

  return {
    ran: true,
    skippedReason: null,
    valueFeedbackChanged,
    productSignalChanged,
  };
}

/** True when typed valueFeedback matches the #2822 force-on block shape. */
export function isForceOnValueFeedbackBlock(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const block = raw as Record<string, unknown>;
  return (
    block.enabled === FORCE_ON_VALUE_FEEDBACK_BLOCK.enabled &&
    readTypedBoolean(raw, "emitEvents", false) === FORCE_ON_VALUE_FEEDBACK_BLOCK.emitEvents &&
    readTypedBoolean(raw, "sessionLine", false) === FORCE_ON_VALUE_FEEDBACK_BLOCK.sessionLine &&
    readTypedBoolean(raw, "upstreamPrompt", true) === FORCE_ON_VALUE_FEEDBACK_BLOCK.upstreamPrompt
  );
}

/** Resolve auditable source for valueFeedback after #2822 migration. */
export function valueFeedbackInstallForceOnSource(
  projectRoot: string,
  raw: unknown,
): "install-force-on" | null {
  const marker = readOrgForceOnMarker(projectRoot);
  if (marker === null || !marker.valueFeedback) {
    return null;
  }
  return isForceOnValueFeedbackBlock(raw) ? "install-force-on" : null;
}

/** Resolve auditable source for productSignal after #2822 migration. */
export function productSignalInstallForceOnSource(
  projectRoot: string,
  raw: unknown,
): "install-force-on" | null {
  const marker = readOrgForceOnMarker(projectRoot);
  if (marker === null || !marker.productSignal) {
    return null;
  }
  return readTypedBoolean(raw, "enabled", false) ? "install-force-on" : null;
}
