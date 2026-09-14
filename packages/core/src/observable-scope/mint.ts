/**
 * Base-committed observable-scope record (#4495).
 *
 * Authority is this record, not live xBRIEF prose. Same-PR rewrite is a
 * verify failure; mint itself only writes the JSON.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import { isMarkupPath } from "./extract.js";
import {
  type AllowedChange,
  CHANGE_KINDS,
  CHANGE_OPS,
  type ChangeKind,
  OBSERVABLE_SCOPE_DIR,
  OBSERVABLE_SCOPE_RECORD_SCHEMA,
  OBSERVABLE_SCOPE_REMEDIATION,
  OBSERVABLE_UI_PROVIDER,
  OBSERVABLE_UI_PROVIDER_VERSION,
  type ObservableScopeHumanApproval,
  type ObservableScopeRecord,
  STRUCTURE_KINDS,
} from "./types.js";

export function observableScopeDir(projectRoot: string): string {
  return join(resolve(projectRoot), ...OBSERVABLE_SCOPE_DIR.split("/"));
}

export function observableScopeSafePlanId(planId: string): string {
  return planId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function observableScopeRecordRel(planId: string): string {
  return `${OBSERVABLE_SCOPE_DIR}/${observableScopeSafePlanId(planId)}.json`;
}

export function observableScopeRecordPath(projectRoot: string, planId: string): string {
  return join(resolve(projectRoot), ...observableScopeRecordRel(planId).split("/"));
}

export function canonicalContractPayload(input: {
  readonly allowedChanges: readonly AllowedChange[];
  readonly mustPreserve?: readonly AllowedChange[];
}): string {
  return `${JSON.stringify({
    allowedChanges: input.allowedChanges,
    mustPreserve: input.mustPreserve ?? [],
  })}\n`;
}

export function computeContractDigest(input: {
  readonly allowedChanges: readonly AllowedChange[];
  readonly mustPreserve?: readonly AllowedChange[];
}): string {
  return createHash("sha256").update(canonicalContractPayload(input), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAllowed(raw: unknown, label: string): AllowedChange[] | { error: string } {
  if (!Array.isArray(raw)) return { error: `${label} must be an array` };
  const out: AllowedChange[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return { error: `${label} entries must be objects` };
    const kind = item.kind;
    const op = item.op;
    if (typeof kind !== "string" || !(STRUCTURE_KINDS as readonly string[]).includes(kind)) {
      return { error: `${label} kind must be a structure kind` };
    }
    if (typeof op !== "string" || !(CHANGE_OPS as readonly string[]).includes(op)) {
      return { error: `${label} op must be add, remove, or reorder` };
    }
    const name = item.name;
    if (name !== undefined && typeof name !== "string") {
      return { error: `${label} name must be a string when set` };
    }
    const path = item.path;
    if (path !== undefined && typeof path !== "string") {
      return { error: `${label} path must be a string when set` };
    }
    out.push({
      kind: kind as AllowedChange["kind"],
      op: op as AllowedChange["op"],
      name: typeof name === "string" ? name : undefined,
      path: typeof path === "string" && path.length > 0 ? path.replace(/\\/g, "/") : undefined,
    });
  }
  return out;
}

/** Fail closed on worker-declared baseline or URL-shaped design approval. */
export function parseObservableScopeRecord(
  raw: unknown,
): ObservableScopeRecord | { error: string } {
  if (!isRecord(raw)) return { error: "observable-scope record must be a JSON object" };
  if (raw.schema !== OBSERVABLE_SCOPE_RECORD_SCHEMA) {
    return { error: `schema must be ${OBSERVABLE_SCOPE_RECORD_SCHEMA}` };
  }
  if (raw.baselineRef !== undefined) {
    return { error: "worker-declared baselineRef is not accepted; baseline is the merge base" };
  }
  if (raw.designApprovalRef !== undefined) {
    return { error: "URL-shaped designApprovalRef is not a contract" };
  }
  if (typeof raw.planId !== "string" || raw.planId.trim().length === 0) {
    return { error: "planId is required" };
  }
  if (typeof raw.xbriefRelPath !== "string" || raw.xbriefRelPath.trim().length === 0) {
    return { error: "xbriefRelPath is required" };
  }
  if (typeof raw.approvedAt !== "string") return { error: "approvedAt is required" };
  if (
    typeof raw.changeKind !== "string" ||
    !(CHANGE_KINDS as readonly string[]).includes(raw.changeKind)
  ) {
    return {
      error:
        'changeKind must be "fields-only" or "layout-authorized"; mixed is not a first-ship escape',
    };
  }
  if (!isRecord(raw.oracle)) return { error: "oracle is required" };
  if (raw.oracle.provider !== OBSERVABLE_UI_PROVIDER) {
    return { error: `oracle.provider must be ${OBSERVABLE_UI_PROVIDER}` };
  }
  if (raw.oracle.version !== OBSERVABLE_UI_PROVIDER_VERSION) {
    return { error: `oracle.version must be ${OBSERVABLE_UI_PROVIDER_VERSION}` };
  }
  const allowed = parseAllowed(raw.allowedChanges, "allowedChanges");
  if ("error" in allowed) return allowed;
  let mustPreserve: AllowedChange[] | undefined;
  if (raw.mustPreserve !== undefined) {
    const parsed = parseAllowed(raw.mustPreserve, "mustPreserve");
    if ("error" in parsed) return parsed;
    mustPreserve = parsed;
  }
  if (!isRecord(raw.humanApproval)) return { error: "humanApproval is required" };
  const stamp: ObservableScopeHumanApproval = {
    kind: typeof raw.humanApproval.kind === "string" ? raw.humanApproval.kind : "",
    actor: typeof raw.humanApproval.actor === "string" ? raw.humanApproval.actor : "",
    mintedAt: typeof raw.humanApproval.mintedAt === "string" ? raw.humanApproval.mintedAt : "",
    mintedVia:
      typeof raw.humanApproval.mintedVia === "string" ? raw.humanApproval.mintedVia : undefined,
  };
  if (!isHumanApprovalStamp(stamp)) {
    return {
      error:
        "humanApproval must be a human-presence stamp; agent-written allowedChanges is not a contract",
    };
  }
  if (typeof raw.contractDigest !== "string" || raw.contractDigest.length === 0) {
    return { error: "contractDigest is required" };
  }
  const expected = computeContractDigest({ allowedChanges: allowed, mustPreserve });
  if (raw.contractDigest !== expected) {
    return { error: "contractDigest does not match allowedChanges/mustPreserve" };
  }
  return {
    schema: OBSERVABLE_SCOPE_RECORD_SCHEMA,
    planId: raw.planId.trim(),
    xbriefRelPath: raw.xbriefRelPath.replace(/\\/g, "/"),
    approvedAt: raw.approvedAt,
    changeKind: raw.changeKind as ChangeKind,
    oracle: { provider: OBSERVABLE_UI_PROVIDER, version: OBSERVABLE_UI_PROVIDER_VERSION },
    allowedChanges: allowed,
    mustPreserve,
    humanApproval: stamp,
    contractDigest: raw.contractDigest,
  };
}

export function extractObservableChangeFromPlan(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.plan)) return undefined;
  return payload.plan["x-directive/observableChange"];
}

export function parseObservableChangeContract(raw: unknown):
  | {
      readonly allowedChanges: AllowedChange[];
      readonly mustPreserve?: AllowedChange[];
      readonly changeKind: ChangeKind;
    }
  | { error: string } {
  if (raw === undefined) return { error: 'missing plan["x-directive/observableChange"]' };
  if (!isRecord(raw)) return { error: 'plan["x-directive/observableChange"] must be an object' };
  if (raw.baselineRef !== undefined) {
    return { error: "worker-declared baselineRef is not accepted; baseline is the merge base" };
  }
  if (raw.designApprovalRef !== undefined) {
    return { error: "URL-shaped designApprovalRef is not a contract" };
  }
  const changeKind = raw.changeKind === undefined ? "fields-only" : raw.changeKind;
  if (typeof changeKind !== "string" || !(CHANGE_KINDS as readonly string[]).includes(changeKind)) {
    return {
      error:
        'changeKind must be "fields-only" or "layout-authorized"; mixed is not a first-ship escape',
    };
  }
  const allowed = parseAllowed(raw.allowedChanges, "allowedChanges");
  if ("error" in allowed) return allowed;
  let mustPreserve: AllowedChange[] | undefined;
  if (raw.mustPreserve !== undefined) {
    const parsed = parseAllowed(raw.mustPreserve, "mustPreserve");
    if ("error" in parsed) return parsed;
    mustPreserve = parsed;
  }
  return { allowedChanges: allowed, mustPreserve, changeKind: changeKind as ChangeKind };
}

export function buildObservableScopeRecord(input: {
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly allowedChanges: readonly AllowedChange[];
  readonly mustPreserve?: readonly AllowedChange[];
  readonly humanApproval: ObservableScopeHumanApproval;
  readonly approvedAt?: string;
  readonly changeKind?: ChangeKind;
}): ObservableScopeRecord | { error: string } {
  if (!isHumanApprovalStamp(input.humanApproval)) {
    return {
      error:
        "humanApproval must be a human-presence stamp; agent-written allowedChanges is not a contract",
    };
  }
  const approvedAt = input.approvedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    schema: OBSERVABLE_SCOPE_RECORD_SCHEMA,
    planId: input.planId,
    xbriefRelPath: input.xbriefRelPath.replace(/\\/g, "/"),
    approvedAt,
    changeKind: input.changeKind ?? "fields-only",
    oracle: { provider: OBSERVABLE_UI_PROVIDER, version: OBSERVABLE_UI_PROVIDER_VERSION },
    allowedChanges: input.allowedChanges,
    mustPreserve: input.mustPreserve,
    humanApproval: input.humanApproval,
    contractDigest: computeContractDigest({
      allowedChanges: input.allowedChanges,
      mustPreserve: input.mustPreserve,
    }),
  };
}

export function writeObservableScopeRecord(
  projectRoot: string,
  record: ObservableScopeRecord,
): string {
  const dir = observableScopeDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = observableScopeRecordPath(projectRoot, record.planId);
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });
  return path;
}

/**
 * Pre-dispatch refusal when intended UI files have no story contract / mint
 * record. Missing mint is not a same-run prompt (#4495 later-arc).
 */
export function evaluateObservableMintPreflight(
  payload: unknown,
  projectRoot: string,
): { ok: true } | { ok: false; message: string } {
  if (!isRecord(payload) || !isRecord(payload.plan)) return { ok: true };
  const plan = payload.plan;
  const meta = isRecord(plan.metadata) ? plan.metadata : undefined;
  const placement =
    meta !== undefined && isRecord(meta.intended_placement) ? meta.intended_placement : undefined;
  const files = Array.isArray(placement?.files)
    ? placement.files.filter((f): f is string => typeof f === "string")
    : [];
  if (!files.some((f) => isMarkupPath(f))) return { ok: true };
  const parsed = parseObservableChangeContract(extractObservableChangeFromPlan(payload));
  if ("error" in parsed) {
    return {
      ok: false,
      message: `verify:observable-scope preflight: ${parsed.error} ${OBSERVABLE_SCOPE_REMEDIATION}`,
    };
  }
  const planId = typeof plan.id === "string" ? plan.id.trim() : "";
  if (planId.length === 0) {
    return {
      ok: false,
      message: `verify:observable-scope preflight: plan.id is required to locate the mint record. ${OBSERVABLE_SCOPE_REMEDIATION}`,
    };
  }
  const recPath = observableScopeRecordPath(projectRoot, planId);
  if (!existsSync(recPath)) {
    return {
      ok: false,
      message: `verify:observable-scope preflight: matched UI files in intended_placement without a mint record at ${observableScopeRecordRel(planId)}. ${OBSERVABLE_SCOPE_REMEDIATION}`,
    };
  }
  return { ok: true };
}
