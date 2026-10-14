import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  LEGACY_VBRIEF_VERSION,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
  MIGRATE_THROUGH_VBRIEF_VERSION,
  PRE_LEGACY_VBRIEF_VERSION,
  V08_CONTAINER_ITEM_TYPES,
  V08_ITEM_STATUS_AUTO,
  VBRIEF_REFERENCE_PREFIX,
  VBRIEF_VERSION,
  XBRIEF_REFERENCE_PREFIX,
} from "./constants.js";

export type JsonObject = Record<string, unknown>;
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformError";
  }
}

export class FeatureEmissionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureEmissionRejectedError";
  }
}

export class SplitLayoutRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitLayoutRejectedError";
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the artifact's declared `*BRIEFInfo.version`, if present. */
export function readDeclaredArtifactVersion(artifact: JsonObject): string | null {
  for (const key of [MIGRATED_INFO_ROOT_KEY, LEGACY_INFO_ROOT_KEY] as const) {
    const block = artifact[key];
    if (!isPlainObject(block)) {
      continue;
    }
    const version = block.version;
    if (typeof version === "string") {
      return version;
    }
  }
  return null;
}

/** Rewrite embedded path and reference tokens inside a string (idempotent). */
export function rewriteEmbeddedTokens(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  let next = value;
  if (next.includes(VBRIEF_REFERENCE_PREFIX)) {
    next = next.replaceAll(VBRIEF_REFERENCE_PREFIX, XBRIEF_REFERENCE_PREFIX);
  }
  if (next.includes(LEGACY_ARTIFACT_SUFFIX)) {
    next = next.replaceAll(LEGACY_ARTIFACT_SUFFIX, MIGRATED_ARTIFACT_SUFFIX);
  }
  if (next.includes(`${LEGACY_ARTIFACT_DIR}/`)) {
    next = next.replaceAll(`${LEGACY_ARTIFACT_DIR}/`, `${MIGRATED_ARTIFACT_DIR}/`);
  }
  return next;
}

function deepRewriteValues(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return rewriteEmbeddedTokens(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => deepRewriteValues(entry as JsonValue));
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = deepRewriteValues(entry as JsonValue);
    }
    return out;
  }
  return value;
}

function isAlreadyV08Artifact(artifact: JsonObject): boolean {
  if (!(MIGRATED_INFO_ROOT_KEY in artifact)) {
    return false;
  }
  const info = artifact[MIGRATED_INFO_ROOT_KEY];
  return isPlainObject(info) && info.version === VBRIEF_VERSION;
}

/**
 * True when declared version is a tip migrate source:
 * 0.5 (thin→0.6), 0.6, or orphan 0.7.
 */
function isMigratableSourceVersion(version: unknown): boolean {
  return (
    version === PRE_LEGACY_VBRIEF_VERSION ||
    version === LEGACY_VBRIEF_VERSION ||
    version === MIGRATE_THROUGH_VBRIEF_VERSION
  );
}

function unsupportedSourceVersionMessage(infoKey: string, declaredVersion: unknown): string {
  return (
    `unsupported ${infoKey}.version ${String(declaredVersion)}; ` +
    `migrate accepts ${PRE_LEGACY_VBRIEF_VERSION}→${LEGACY_VBRIEF_VERSION}, ` +
    `${LEGACY_VBRIEF_VERSION}, and orphan ${MIGRATE_THROUGH_VBRIEF_VERSION}→${VBRIEF_VERSION}`
  );
}

/**
 * Resolve a migratable info block from classic `vBRIEFInfo` or hybrid `xBRIEFInfo`
 * at 0.5 / 0.6 / orphan rename-era 0.7. Prefer the classic key when both are present.
 * Layout rename ≠ envelope bump (#2970). 0.5/0.7 are migrate-through, not ACCEPTED forever.
 */
function resolveMigratableInfoBlock(artifact: JsonObject): JsonObject {
  if (LEGACY_INFO_ROOT_KEY in artifact) {
    const legacyInfo = artifact[LEGACY_INFO_ROOT_KEY];
    if (!isPlainObject(legacyInfo)) {
      throw new TransformError(`'${LEGACY_INFO_ROOT_KEY}' must be an object`);
    }
    const declaredVersion = legacyInfo.version;
    if (!isMigratableSourceVersion(declaredVersion)) {
      throw new TransformError(
        unsupportedSourceVersionMessage(LEGACY_INFO_ROOT_KEY, declaredVersion),
      );
    }
    return legacyInfo;
  }

  if (MIGRATED_INFO_ROOT_KEY in artifact) {
    const hybridInfo = artifact[MIGRATED_INFO_ROOT_KEY];
    if (!isPlainObject(hybridInfo)) {
      throw new TransformError(`'${MIGRATED_INFO_ROOT_KEY}' must be an object`);
    }
    const declaredVersion = hybridInfo.version;
    if (!isMigratableSourceVersion(declaredVersion)) {
      throw new TransformError(
        `expected hybrid ${MIGRATED_INFO_ROOT_KEY}.version ${PRE_LEGACY_VBRIEF_VERSION}|${LEGACY_VBRIEF_VERSION}|${MIGRATE_THROUGH_VBRIEF_VERSION} (or ${VBRIEF_VERSION} for already-migrated), got ${String(declaredVersion)}`,
      );
    }
    return hybridInfo;
  }

  throw new TransformError(
    `missing required legacy info block '${LEGACY_INFO_ROOT_KEY}' or hybrid '${MIGRATED_INFO_ROOT_KEY}'@${PRE_LEGACY_VBRIEF_VERSION}|${LEGACY_VBRIEF_VERSION}|${MIGRATE_THROUGH_VBRIEF_VERSION} for -> v0.8 transform`,
  );
}

/**
 * Thin v0.5 → v0.6 (MIGRATION.md): bump version; rename nested `subItems` → `items`
 * where present. Does not invent heavy 0.4→0.5 semantics. Mutates `working` in place.
 */
export function applyThinV05ToV06(working: JsonObject): void {
  for (const key of [LEGACY_INFO_ROOT_KEY, MIGRATED_INFO_ROOT_KEY] as const) {
    const block = working[key];
    if (isPlainObject(block) && block.version === PRE_LEGACY_VBRIEF_VERSION) {
      block.version = LEGACY_VBRIEF_VERSION;
    }
  }
  renameSubItemsToItems(working);
}

/** Recursively rename PlanItem `subItems` → `items` (v0.5→v0.6). */
function renameSubItemsToItems(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      renameSubItemsToItems(entry);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  if (Object.hasOwn(value, "subItems")) {
    const sub = value.subItems;
    if (!Object.hasOwn(value, "items")) {
      value.items = sub;
    }
    delete value.subItems;
  }
  for (const entry of Object.values(value)) {
    renameSubItemsToItems(entry);
  }
}

/**
 * Convert a single migratable in-document artifact to v0.8 semantics.
 * Accepts classic/hybrid @0.5 (thin→0.6 first), @0.6, or orphan @0.7.
 * Idempotent: v0.8 artifacts are returned unchanged (deep-cloned).
 * Transactional: on failure the original input object is not mutated.
 */
export function transformArtifactV06ToV08(input: JsonObject): JsonObject {
  const working = structuredClone(input) as JsonObject;

  if (isAlreadyV08Artifact(working)) {
    return working;
  }

  const declared = readDeclaredArtifactVersion(working);
  if (declared === PRE_LEGACY_VBRIEF_VERSION) {
    applyThinV05ToV06(working);
  }

  const info = resolveMigratableInfoBlock(working);

  // Drop both keys so a dual-key hybrid cannot leave a stale vBRIEFInfo behind.
  delete working[LEGACY_INFO_ROOT_KEY];
  delete working[MIGRATED_INFO_ROOT_KEY];
  working[MIGRATED_INFO_ROOT_KEY] = {
    ...info,
    version: VBRIEF_VERSION,
  };

  const rewritten = deepRewriteValues(working as JsonValue) as JsonObject;
  return rewritten;
}

/**
 * Apply `transformArtifactV06ToV08` inside a try/catch boundary.
 * On error, returns the original artifact reference unchanged.
 */
export function transformArtifactV06ToV08Transactional(input: JsonObject):
  | {
      ok: true;
      artifact: JsonObject;
      changed: boolean;
    }
  | {
      ok: false;
      artifact: JsonObject;
      error: string;
    } {
  try {
    const artifact = transformArtifactV06ToV08(input);
    const changed = JSON.stringify(artifact) !== JSON.stringify(input);
    return { ok: true, artifact, changed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, artifact: input, error: message };
  }
}

function walkForV08FeatureEmission(value: unknown, path: string, violations: string[]): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkForV08FeatureEmission(value[index], `${path}[${index}]`, violations);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }

  if (MIGRATED_INFO_ROOT_KEY in value) {
    violations.push(`${path}: must not emit '${MIGRATED_INFO_ROOT_KEY}' into a v0.6 artifact`);
  }

  if (value.status === V08_ITEM_STATUS_AUTO) {
    violations.push(`${path}.status: must not emit '${V08_ITEM_STATUS_AUTO}' into a v0.6 artifact`);
  }

  if (typeof value.type === "string" && V08_CONTAINER_ITEM_TYPES.has(value.type)) {
    violations.push(
      `${path}.type: must not emit container type '${value.type}' into a v0.6 artifact`,
    );
  }

  for (const [key, entry] of Object.entries(value)) {
    walkForV08FeatureEmission(entry, `${path}.${key}`, violations);
  }
}

/**
 * Locked rule #1 (#2034): refuse v0.8-only constructs unless the artifact declares v0.8.
 * Fail closed when the version block is missing or unreadable.
 */
export function assertFeatureEmissionAllowed(
  targetArtifact: JsonObject,
  emission: JsonObject,
): void {
  const declared = readDeclaredArtifactVersion(targetArtifact);
  if (declared === VBRIEF_VERSION) {
    return;
  }

  const violations: string[] = [];
  walkForV08FeatureEmission(emission, "emission", violations);
  if (violations.length === 0) {
    return;
  }

  const context =
    declared === null
      ? "artifact has no declared version"
      : `artifact declares version ${declared}`;
  throw new FeatureEmissionRejectedError(`${context}; ${violations.join("; ")}`);
}

/** Map a desired migrated-relative path to the legacy tree when required. */
export function resolveLayoutAwareRelativePath(
  legacyLayout: boolean,
  relativePath: string,
): string {
  if (!legacyLayout) {
    return relativePath;
  }
  return relativePath
    .replaceAll(`${MIGRATED_ARTIFACT_DIR}/`, `${LEGACY_ARTIFACT_DIR}/`)
    .replaceAll(MIGRATED_ARTIFACT_SUFFIX, LEGACY_ARTIFACT_SUFFIX);
}

/**
 * Locked rule #2 (#2034): never target `xbrief/` when the project still uses `vbrief/`.
 */
export function assertLayoutAwareWritePath(
  projectRoot: string,
  relativePath: string,
  legacyLayout: boolean,
): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (legacyLayout && normalized.includes(`${MIGRATED_ARTIFACT_DIR}/`)) {
    throw new SplitLayoutRejectedError(
      `refusing to write into '${MIGRATED_ARTIFACT_DIR}/' while legacy '${LEGACY_ARTIFACT_DIR}/' layout is present at ${projectRoot}`,
    );
  }
  return resolveLayoutAwareRelativePath(legacyLayout, normalized);
}
