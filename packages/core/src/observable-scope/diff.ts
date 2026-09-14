/**
 * Compare two committed-markup artifacts and match deltas to minted allows (#4495).
 */

import type {
  AllowedChange,
  ObservableArtifact,
  StructureDelta,
  StructureFact,
  StructureKind,
} from "./types.js";
import { STRUCTURE_KINDS } from "./types.js";

function factName(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1] ?? id;
}

function kindFacts(facts: readonly StructureFact[], kind: StructureKind): string[] {
  return facts.filter((f) => f.kind === kind).map((f) => f.id);
}

function deltasForPath(
  path: string,
  baseFacts: readonly StructureFact[],
  candidateFacts: readonly StructureFact[],
): StructureDelta[] {
  const out: StructureDelta[] = [];
  for (const kind of STRUCTURE_KINDS) {
    const base = kindFacts(baseFacts, kind);
    const cand = kindFacts(candidateFacts, kind);
    const baseSet = new Set(base);
    const candSet = new Set(cand);
    for (const id of cand) {
      if (!baseSet.has(id)) {
        out.push({ path, kind, op: "add", name: factName(id), id });
      }
    }
    for (const id of base) {
      if (!candSet.has(id)) {
        out.push({ path, kind, op: "remove", name: factName(id), id });
      }
    }
    const sameSet =
      base.length === cand.length &&
      base.every((id) => candSet.has(id)) &&
      cand.every((id) => baseSet.has(id));
    if (sameSet && base.length > 1 && base.some((id, i) => cand[i] !== id)) {
      out.push({
        path,
        kind,
        op: "reorder",
        name: kind,
        id: `${kind}:order`,
      });
    }
  }
  return out;
}

export function diffArtifacts(
  base: ObservableArtifact,
  candidate: ObservableArtifact,
): StructureDelta[] {
  const baseByPath = new Map(base.surfaces.map((s) => [s.path, s.facts]));
  const candByPath = new Map(candidate.surfaces.map((s) => [s.path, s.facts]));
  const paths = new Set([...baseByPath.keys(), ...candByPath.keys()]);
  const out: StructureDelta[] = [];
  for (const path of [...paths].sort()) {
    out.push(...deltasForPath(path, baseByPath.get(path) ?? [], candByPath.get(path) ?? []));
  }
  return out;
}

export function changeMatches(allow: AllowedChange, delta: StructureDelta): boolean {
  if (allow.kind !== delta.kind || allow.op !== delta.op) return false;
  if (allow.path !== undefined && allow.path.length > 0 && allow.path !== delta.path) return false;
  if (allow.name === undefined || allow.name.length === 0) return true;
  return (
    allow.name === delta.name || delta.id === allow.name || delta.id.endsWith(`:${allow.name}`)
  );
}

export function unlistedDeltas(
  deltas: readonly StructureDelta[],
  allowed: readonly AllowedChange[],
): StructureDelta[] {
  return deltas.filter((delta) => !allowed.some((allow) => changeMatches(allow, delta)));
}
