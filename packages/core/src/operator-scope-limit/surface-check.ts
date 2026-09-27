import {
  type ShippedSurface,
  type UntraceableSurface,
  type UntraceableSurfaceCheckResult,
  UNTRACEABLE_SURFACE_REMEDIATION,
} from "./types.js";

/**
 * Warn-first list of exported surfaces not traceable to a requirement line (#4545).
 * Never throws; empty requirement lines yield every surface as untraceable (warn).
 */
export function evaluateUntraceableSurfaces(input: {
  readonly requirementLines: readonly string[];
  readonly surfaces: readonly ShippedSurface[];
}): UntraceableSurfaceCheckResult {
  const requirementLines = input.requirementLines ?? [];
  const surfaces = input.surfaces ?? [];
  const untraceable: UntraceableSurface[] = [];

  for (const surface of surfaces) {
    if (isTraceableToAnyRequirement(surface, requirementLines)) continue;
    untraceable.push({
      surface,
      remediation: UNTRACEABLE_SURFACE_REMEDIATION,
    });
  }

  if (untraceable.length === 0) {
    return {
      severity: "clean",
      untraceable: [],
      remediation: null,
      message: "operator-scope-limit: all shipped surfaces trace to a requirement line",
    };
  }

  const listed = untraceable
    .map((u) => `${u.surface.kind}:${u.surface.id}`)
    .join(", ");
  return {
    severity: "warn",
    untraceable,
    remediation: UNTRACEABLE_SURFACE_REMEDIATION,
    message:
      `operator-scope-limit WARN: ${untraceable.length} shipped surface(s) not traceable ` +
      `to a requirement line: ${listed}. Remediation: ${UNTRACEABLE_SURFACE_REMEDIATION}`,
  };
}

function isTraceableToAnyRequirement(
  surface: ShippedSurface,
  requirementLines: readonly string[],
): boolean {
  if (requirementLines.length === 0) return false;
  const surfaceTokens = tokenizeSurface(surface.id);
  for (const line of requirementLines) {
    if (requirementTracesToSurface(tokenizeRequirement(line), surfaceTokens)) {
      return true;
    }
  }
  return false;
}

function requirementTracesToSurface(
  requirementTokens: readonly string[],
  surfaceTokens: readonly string[],
): boolean {
  if (requirementTokens.length === 0) return false;
  const surfaceSet = new Set<string>();
  for (const token of surfaceTokens) {
    surfaceSet.add(token);
    for (const stem of pluralStems(token)) surfaceSet.add(stem);
  }
  return requirementTokens.every(
    (token) =>
      surfaceSet.has(token) ||
      synonymHits(token, surfaceSet) ||
      pluralStems(token).some((stem) => surfaceSet.has(stem)),
  );
}

/** Cheap singular/plural stems so "vehicle" traces to "/vehicles/new". */
function pluralStems(token: string): string[] {
  const out: string[] = [];
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    out.push(token.slice(0, -1));
  } else if (token.length > 2) {
    out.push(`${token}s`);
  }
  return out;
}

const VERB_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  add: ["add", "create", "new", "insert"],
  create: ["add", "create", "new", "insert"],
  update: ["update", "edit", "patch", "set"],
  edit: ["update", "edit", "patch", "set"],
  delete: ["delete", "remove", "destroy"],
  remove: ["delete", "remove", "destroy"],
  list: ["list", "view", "get", "read", "index"],
  view: ["list", "view", "get", "read", "index"],
  get: ["list", "view", "get", "read", "index"],
};

function synonymHits(token: string, surfaceSet: ReadonlySet<string>): boolean {
  const group = VERB_SYNONYMS[token];
  if (group === undefined) return false;
  return group.some((syn) => surfaceSet.has(syn));
}

function tokenizeRequirement(line: string): string[] {
  return normalizeTokens(line);
}

function tokenizeSurface(id: string): string[] {
  // Split camelCase, paths, and punctuation into comparable stems.
  const spaced = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[\\/_.\-]+/g, " ")
    .replace(/\[|\]/g, " ");
  return normalizeTokens(spaced);
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP.has(t));
}

const STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "record",
  "records",
  "action",
  "page",
  "route",
  "id",
]);
