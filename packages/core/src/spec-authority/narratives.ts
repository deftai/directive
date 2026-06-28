import { readFileSync } from "node:fs";
import { SPECIFICATION_NARRATIVE_KEY_ORDER } from "../render/constants.js";
import { STAKEHOLDER_EXCLUDED_NARRATIVE_KEYS } from "./constants.js";
import type { ResolvedSpecAuthority } from "./resolver.js";

type JsonObject = Record<string, unknown>;

function loadJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function planNarratives(doc: JsonObject): Record<string, string> {
  const plan = doc.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return {};
  const narratives = (plan as JsonObject).narratives;
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(narratives as JsonObject)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

function isExcludedNarrativeKey(key: string): boolean {
  return STAKEHOLDER_EXCLUDED_NARRATIVE_KEYS.has(key.toLowerCase().replace(/\s+/g, ""));
}

/** Merge product narratives per Wave 0 locked precedence. */
export function resolveExportNarratives(authority: ResolvedSpecAuthority): Record<string, string> {
  const pd = loadJson(authority.projectDefPath);
  const pdNarratives = planNarratives(pd);

  if (authority.kind === "greenfield") {
    const filtered: Record<string, string> = {};
    for (const [key, val] of Object.entries(pdNarratives)) {
      if (!isExcludedNarrativeKey(key) && val.trim()) filtered[key] = val;
    }
    return filtered;
  }

  const specPath = authority.specPath;
  if (!specPath) return pdNarratives;

  const spec = loadJson(specPath);
  const specNarratives = planNarratives(spec);
  const merged: Record<string, string> = {};

  for (const [key, val] of Object.entries(specNarratives)) {
    if (!isExcludedNarrativeKey(key) && val.trim()) merged[key] = val;
  }

  // PD identity additive when missing from spec.
  const identityHints = ["overview", "architecture", "risksandunknowns", "risks", "unknowns"];
  for (const [key, val] of Object.entries(pdNarratives)) {
    if (!val.trim() || isExcludedNarrativeKey(key)) continue;
    const lower = key.toLowerCase().replace(/\s+/g, "");
    const isIdentity = identityHints.some((h) => lower.includes(h)) || lower === "overview";
    if (!isIdentity) continue;
    const specHasKey = Object.keys(merged).some((k) => k.toLowerCase() === lower);
    if (!specHasKey) merged[key] = val;
  }

  return merged;
}

export function renderNarrativeSections(narratives: Record<string, string>): string[] {
  const lines: string[] = [];
  const rendered = new Set<string>();

  for (const key of SPECIFICATION_NARRATIVE_KEY_ORDER) {
    const val = narratives[key];
    if (val?.trim()) {
      lines.push(`## ${key}\n`, `${val}\n`);
      rendered.add(key);
    }
  }
  for (const key of Object.keys(narratives).sort()) {
    if (rendered.has(key) || !narratives[key]?.trim()) continue;
    lines.push(`## ${key}\n`, `${narratives[key]}\n`);
  }
  return lines;
}

export function greenfieldOverviewNonEmpty(authority: ResolvedSpecAuthority): boolean {
  const pd = loadJson(authority.projectDefPath);
  const narratives = planNarratives(pd);
  const overview = Object.entries(narratives).find(([k]) => k.toLowerCase() === "overview");
  return overview !== undefined && overview[1].trim().length > 0;
}
