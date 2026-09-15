/**
 * Human-minted intent-constraint record (#4541).
 *
 * Authority is git show merge-base of this record. Same-PR rewrite is not a contract.
 * Tests and in-scope paths are not authority.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import {
  INTENT_CONSTRAINT_DIR,
  INTENT_CONSTRAINT_PLAN_KEY,
  INTENT_CONSTRAINT_RECORD_SCHEMA,
  INTENT_CONSTRAINT_REMEDIATION,
  type IntentConstraintHumanApproval,
  type IntentConstraintRecord,
  type MintConstraint,
  REJECTION_SCOPES,
} from "./types.js";

export function intentConstraintDir(projectRoot: string): string {
  return join(resolve(projectRoot), ...INTENT_CONSTRAINT_DIR.split("/"));
}

export function intentConstraintSafePlanId(planId: string): string {
  return planId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function intentConstraintRecordRel(planId: string): string {
  return `${INTENT_CONSTRAINT_DIR}/${intentConstraintSafePlanId(planId)}.json`;
}

export function intentConstraintRecordPath(projectRoot: string, planId: string): string {
  return join(resolve(projectRoot), ...intentConstraintRecordRel(planId).split("/"));
}

export function computeContractDigest(constraints: readonly MintConstraint[]): string {
  return createHash("sha256")
    .update(`${JSON.stringify({ constraints })}\n`, "utf8")
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConstraints(raw: unknown): MintConstraint[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "constraints must be an array" };
  const out: MintConstraint[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return { error: "constraints entries must be objects" };
    if (typeof item.value !== "string" || item.value.trim().length === 0) {
      return { error: "constraints.value is required" };
    }
    if (typeof item.unit !== "string" || item.unit.trim().length === 0) {
      return { error: "constraints.unit is required" };
    }
    if (
      typeof item.rejectionScope !== "string" ||
      !(REJECTION_SCOPES as readonly string[]).includes(item.rejectionScope)
    ) {
      return { error: "constraints.rejectionScope must be item, invocation, or operation" };
    }
    out.push({
      value: item.value.trim(),
      unit: item.unit.trim(),
      rejectionScope: item.rejectionScope as MintConstraint["rejectionScope"],
    });
  }
  return out;
}

export function parseIntentConstraintRecord(
  raw: unknown,
): IntentConstraintRecord | { error: string } {
  if (!isRecord(raw)) return { error: "intent-constraint record must be a JSON object" };
  if (raw.schema !== INTENT_CONSTRAINT_RECORD_SCHEMA) {
    return { error: `schema must be ${INTENT_CONSTRAINT_RECORD_SCHEMA}` };
  }
  if (raw.baselineRef !== undefined) {
    return { error: "worker-declared baselineRef is not accepted; baseline is the merge base" };
  }
  if (typeof raw.planId !== "string" || raw.planId.trim().length === 0) {
    return { error: "planId is required" };
  }
  if (typeof raw.xbriefRelPath !== "string" || raw.xbriefRelPath.trim().length === 0) {
    return { error: "xbriefRelPath is required" };
  }
  if (typeof raw.approvedAt !== "string") return { error: "approvedAt is required" };
  const constraints = parseConstraints(raw.constraints);
  if ("error" in constraints) return constraints;
  if (!isRecord(raw.humanApproval)) return { error: "humanApproval is required" };
  const stamp: IntentConstraintHumanApproval = {
    kind: typeof raw.humanApproval.kind === "string" ? raw.humanApproval.kind : "",
    actor: typeof raw.humanApproval.actor === "string" ? raw.humanApproval.actor : "",
    mintedAt: typeof raw.humanApproval.mintedAt === "string" ? raw.humanApproval.mintedAt : "",
    mintedVia:
      typeof raw.humanApproval.mintedVia === "string" ? raw.humanApproval.mintedVia : undefined,
  };
  if (!isHumanApprovalStamp(stamp)) {
    return {
      error:
        "humanApproval must be a human-presence stamp; agent-written constraints are not a contract",
    };
  }
  if (typeof raw.contractDigest !== "string" || raw.contractDigest.length === 0) {
    return { error: "contractDigest is required" };
  }
  const expected = computeContractDigest(constraints);
  if (raw.contractDigest !== expected) {
    return { error: "contractDigest does not match constraints" };
  }
  return {
    schema: INTENT_CONSTRAINT_RECORD_SCHEMA,
    planId: raw.planId.trim(),
    xbriefRelPath: raw.xbriefRelPath.replace(/\\/g, "/"),
    approvedAt: raw.approvedAt,
    constraints,
    humanApproval: stamp,
    contractDigest: raw.contractDigest,
  };
}

export function extractIntentConstraintFromPlan(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.plan)) return undefined;
  return payload.plan[INTENT_CONSTRAINT_PLAN_KEY];
}

export function parseIntentConstraintContract(
  raw: unknown,
): { readonly constraints: MintConstraint[] } | { error: string } {
  if (raw === undefined) return { error: `missing plan["${INTENT_CONSTRAINT_PLAN_KEY}"]` };
  if (!isRecord(raw)) return { error: `plan["${INTENT_CONSTRAINT_PLAN_KEY}"] must be an object` };
  if (raw.baselineRef !== undefined) {
    return { error: "worker-declared baselineRef is not accepted; baseline is the merge base" };
  }
  const constraints = parseConstraints(raw.constraints);
  if ("error" in constraints) return constraints;
  return { constraints };
}

export function buildIntentConstraintRecord(input: {
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly constraints: readonly MintConstraint[];
  readonly humanApproval: IntentConstraintHumanApproval;
  readonly approvedAt?: string;
}): IntentConstraintRecord | { error: string } {
  if (!isHumanApprovalStamp(input.humanApproval)) {
    return {
      error:
        "humanApproval must be a human-presence stamp; agent-written constraints are not a contract",
    };
  }
  const approvedAt = input.approvedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    schema: INTENT_CONSTRAINT_RECORD_SCHEMA,
    planId: input.planId,
    xbriefRelPath: input.xbriefRelPath.replace(/\\/g, "/"),
    approvedAt,
    constraints: input.constraints,
    humanApproval: input.humanApproval,
    contractDigest: computeContractDigest(input.constraints),
  };
}

export function writeIntentConstraintRecord(
  projectRoot: string,
  record: IntentConstraintRecord,
): string {
  const dir = intentConstraintDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = intentConstraintRecordPath(projectRoot, record.planId);
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });
  return path;
}

export { INTENT_CONSTRAINT_REMEDIATION };
