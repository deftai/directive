/**
 * Extract intent preimage from a live xBRIEF (#3376 R1–R5 / #3385 F1–F2).
 *
 * Unknown plan.* keys are extracted (pinned), not rejected. Known-machine keys
 * are omitted. plan.tags is machine; plan.edges is extracted.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GITHUB_ISSUE_REF_TYPES } from "../intake/reconcile-issues.js";
import { stripArtifactSuffix } from "../layout/resolve.js";
import { ACCEPTANCE_EVIDENCE_KEY } from "../scope/acceptance-evidence.js";
import { resolveParentPathFromRef } from "../scope/parent-lineage.js";
import { extractPlanId } from "./digest.js";
import { INTENT_DIGEST_ALGO } from "./intent-digest.js";
import { parseJsonRejectingDuplicateKeys } from "./json-tokenizer.js";
import {
  classifyItemKey,
  classifyPlanPath,
  classifyReferenceKey,
  ITEM_EXTRACT_KEYS,
} from "./known-machine.js";

export const INTENT_PREIMAGE_SCHEMA = 1 as const;

export interface IntentPreimage {
  readonly schemaVersion: typeof INTENT_PREIMAGE_SCHEMA;
  readonly algo: typeof INTENT_DIGEST_ALGO;
  readonly plan: Record<string, unknown>;
  readonly approvedRepos: readonly string[];
  /** Paths classified unknown at extract (for verify unclassified-key). */
  readonly unknownPaths: readonly string[];
}

export interface ExtractIntentOk {
  readonly ok: true;
  readonly preimage: IntentPreimage;
}

export interface ExtractIntentErr {
  readonly ok: false;
  readonly error: string;
}

export type ExtractIntentResult = ExtractIntentOk | ExtractIntentErr;

export interface ExtractIntentOptions {
  readonly projectRoot?: string;
  readonly approvedReposSeed?: readonly string[];
  readonly readFile?: (absPath: string) => string | null;
}

const ISSUE_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i;

export function slugFromGithubIssueUri(uri: string): string | null {
  const m = ISSUE_URL_RE.exec(uri);
  if (m === null) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const NESTED_ITEM_ARRAY_KEYS = new Set(["items", "subItems"]);

function omitCanonicalEvidenceFromNestedItem(value: unknown): unknown {
  const rec = asRecord(value);
  if (rec === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (key === ACCEPTANCE_EVIDENCE_KEY) continue;
    if (NESTED_ITEM_ARRAY_KEYS.has(key) && Array.isArray(val)) {
      out[key] = val.map(omitCanonicalEvidenceFromNestedItem);
      continue;
    }
    out[key] = val;
  }
  return out;
}

function itemId(item: Record<string, unknown>): string {
  return typeof item.id === "string" ? item.id : "";
}

function readText(abs: string, reader?: (p: string) => string | null): string | null {
  if (reader !== undefined) return reader(abs);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export function resolveParentPlanId(
  planRef: string,
  projectRoot: string,
  readFile?: (absPath: string) => string | null,
): { id: string } | { error: string } {
  const roots = [join(projectRoot, "xbrief"), join(projectRoot, "vbrief")];
  for (const lifecycleRoot of roots) {
    const resolved = resolveParentPathFromRef(planRef, lifecycleRoot);
    if (resolved.path === null) continue;
    const raw = readText(resolved.path, readFile);
    if (raw === null) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return { error: `unresolvable parent at mint: ${planRef} is not valid JSON` };
    }
    const id = extractPlanId(payload) ?? stripArtifactSuffix(basename(resolved.path));
    if (id.trim().length === 0) {
      return { error: `unresolvable parent at mint: ${planRef} has no plan.id` };
    }
    return { id: id.trim() };
  }
  return { error: `unresolvable parent at mint: ${planRef}` };
}

function extractReferences(refs: unknown): { refs: Record<string, unknown>[]; error?: string } {
  if (!Array.isArray(refs)) return { refs: [] };
  const out: Record<string, unknown>[] = [];
  for (const ref of refs) {
    const rec = asRecord(ref);
    if (rec === null) continue;
    const extracted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
      const cls = classifyReferenceKey(key);
      if (cls === "machine") continue;
      extracted[key] = value;
    }
    out.push(extracted);
  }
  return { refs: out };
}

function extractItems(
  items: unknown,
  projectRoot: string | undefined,
  readFile: ((abs: string) => string | null) | undefined,
  unknownPaths: string[],
): { items: Record<string, unknown>[]; error?: string } {
  if (!Array.isArray(items)) return { items: [] };
  const out: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    const rec = asRecord(item);
    if (rec === null) continue;
    const extracted: Record<string, unknown> = {};
    for (const key of ITEM_EXTRACT_KEYS) {
      if (rec[key] !== undefined) extracted[key] = rec[key];
    }
    for (const [key, value] of Object.entries(rec)) {
      if ((ITEM_EXTRACT_KEYS as readonly string[]).includes(key)) continue;
      const cls = classifyItemKey(key);
      if (cls === "machine") continue;
      if (NESTED_ITEM_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        extracted[key] = value.map(omitCanonicalEvidenceFromNestedItem);
        unknownPaths.push(`items[].${key}`);
        continue;
      }
      extracted[key] = value;
      unknownPaths.push(`items[].${key}`);
    }
    if (typeof rec.planRef === "string" && rec.planRef.trim().length > 0) {
      if (projectRoot === undefined) {
        return { items: [], error: `unresolvable parent at mint: ${rec.planRef}` };
      }
      const parent = resolveParentPlanId(rec.planRef, projectRoot, readFile);
      if ("error" in parent) return { items: [], error: parent.error };
      extracted.parentId = parent.id;
    }
    const id = itemId(extracted);
    if (id.length > 0) {
      if (ids.has(id)) {
        return { items: [], error: `duplicate items[].id ${JSON.stringify(id)}` };
      }
      ids.add(id);
    }
    out.push(extracted);
  }
  out.sort((a, b) => itemId(a).localeCompare(itemId(b)));
  return { items: out };
}

function copyUnknownSubtree(value: unknown): unknown {
  return value;
}

function extractMetadata(
  metadata: Record<string, unknown>,
  unknownPaths: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const path = `metadata.${key}`;
    const cls = classifyPlanPath(path);
    if (cls === "machine") continue;
    if (key === "swarm") {
      const swarm = asRecord(value);
      if (swarm === null) continue;
      const swarmOut: Record<string, unknown> = {};
      for (const [sKey, sVal] of Object.entries(swarm)) {
        const sPath = `metadata.swarm.${sKey}`;
        const sCls = classifyPlanPath(sPath);
        if (sCls === "machine") continue;
        swarmOut[sKey] = sVal;
        if (sCls === "unknown") unknownPaths.push(sPath);
      }
      if (Object.keys(swarmOut).length > 0) out.swarm = swarmOut;
      continue;
    }
    if (cls === "unknown") {
      out[key] = copyUnknownSubtree(value);
      unknownPaths.push(path);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function seedApprovedRepos(
  seed: readonly string[] | undefined,
  refs: readonly Record<string, unknown>[],
): string[] {
  const out = new Set<string>();
  for (const s of seed ?? []) {
    const t = s.trim().toLowerCase();
    if (t.includes("/")) out.add(t);
  }
  for (const ref of refs) {
    if (typeof ref.uri !== "string") continue;
    const slug = slugFromGithubIssueUri(ref.uri);
    if (slug !== null) out.add(slug);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Extract from a parsed payload (tokenizer already applied). */
export function extractIntentFromPayload(
  payload: unknown,
  options: ExtractIntentOptions = {},
): ExtractIntentResult {
  const root = asRecord(payload);
  if (root === null) return { ok: false, error: "xBRIEF is not an object" };
  const plan = asRecord(root.plan);
  if (plan === null) return { ok: false, error: "xBRIEF plan is missing" };

  const unknownPaths: string[] = [];
  const extracted: Record<string, unknown> = {};

  if (typeof plan.planRef === "string" && plan.planRef.trim().length > 0) {
    if (options.projectRoot === undefined) {
      return { ok: false, error: `unresolvable parent at mint: ${plan.planRef}` };
    }
    const parent = resolveParentPlanId(plan.planRef, options.projectRoot, options.readFile);
    if ("error" in parent) return { ok: false, error: parent.error };
    extracted.parentId = parent.id;
  }

  for (const [key, value] of Object.entries(plan)) {
    const cls = classifyPlanPath(key);
    if (cls === "machine") continue;
    if (key === "items") {
      const items = extractItems(value, options.projectRoot, options.readFile, unknownPaths);
      if (items.error !== undefined) return { ok: false, error: items.error };
      extracted.items = items.items;
      continue;
    }
    if (key === "references") {
      const refs = extractReferences(value);
      if (refs.error !== undefined) return { ok: false, error: refs.error };
      extracted.references = refs.refs;
      continue;
    }
    if (key === "metadata") {
      const meta = asRecord(value);
      if (meta === null) continue;
      const extractedMeta = extractMetadata(meta, unknownPaths);
      if (Object.keys(extractedMeta).length > 0) extracted.metadata = extractedMeta;
      continue;
    }
    if (cls === "unknown") {
      extracted[key] = copyUnknownSubtree(value);
      unknownPaths.push(key);
      continue;
    }
    extracted[key] = value;
  }

  const refs = Array.isArray(extracted.references)
    ? (extracted.references as Record<string, unknown>[])
    : [];
  const approvedRepos = seedApprovedRepos(options.approvedReposSeed, refs);
  const uniqueUnknown = [...new Set(unknownPaths)].sort((a, b) => a.localeCompare(b));

  return {
    ok: true,
    preimage: {
      schemaVersion: INTENT_PREIMAGE_SCHEMA,
      algo: INTENT_DIGEST_ALGO,
      plan: extracted,
      approvedRepos,
      unknownPaths: uniqueUnknown,
    },
  };
}

/** Parse raw text (duplicate-key reject) then extract. */
export function extractIntentFromRaw(
  raw: string,
  options: ExtractIntentOptions = {},
): ExtractIntentResult {
  const parsed = parseJsonRejectingDuplicateKeys(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return extractIntentFromPayload(parsed.value, options);
}

export { GITHUB_ISSUE_REF_TYPES };
