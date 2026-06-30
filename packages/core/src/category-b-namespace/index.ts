/**
 * Category B corpus codemod (#1650 / #2034).
 *
 * Renames the two grandfathered bare directive-config plan keys (`policy`,
 * `completedNote`) to their `x-directive/` namespaced form across the vBRIEF
 * corpus so the #1620 conformance gate can drop its temporary ALLOW_LIST.
 *
 * The transform is idempotent (already-namespaced artifacts are unchanged) and
 * order-preserving (the namespaced key takes the legacy key's slot, keeping
 * artifact diffs minimal).
 */
import { type Dirent, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import {
  LEGACY_PLAN_COMPLETED_NOTE_KEY,
  LEGACY_PLAN_POLICY_KEY,
  PLAN_COMPLETED_NOTE_KEY,
  PLAN_POLICY_KEY,
} from "../policy/plan-extensions.js";

type JsonObject = Record<string, unknown>;

export interface CategoryBKeyRename {
  readonly legacyKey: string;
  readonly namespacedKey: string;
}

/** The locked Category B renames (#1650): directive's own config, not xbrief data. */
export const CATEGORY_B_KEY_RENAMES: readonly CategoryBKeyRename[] = [
  { legacyKey: LEGACY_PLAN_POLICY_KEY, namespacedKey: PLAN_POLICY_KEY },
  { legacyKey: LEGACY_PLAN_COMPLETED_NOTE_KEY, namespacedKey: PLAN_COMPLETED_NOTE_KEY },
];

/** Raised when both the bare and namespaced form of a Category B key exist. */
export class CategoryBConflictError extends Error {
  constructor(legacyKey: string, namespacedKey: string) {
    super(
      `plan has both bare '${legacyKey}' and namespaced '${namespacedKey}' -- ` +
        "resolve the conflict by hand before migrating.",
    );
    this.name = "CategoryBConflictError";
  }
}

export interface NamespaceResult {
  readonly doc: JsonObject;
  readonly changed: boolean;
  readonly renamedKeys: readonly string[];
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Idempotently rename Category B bare plan keys to their namespaced form.
 * Mutates and returns the supplied document. Throws {@link CategoryBConflictError}
 * when a plan carries both the bare and namespaced form of the same key.
 */
export function namespaceCategoryBPlan(doc: unknown): NamespaceResult {
  if (!isPlainObject(doc)) {
    return { doc: doc as JsonObject, changed: false, renamedKeys: [] };
  }
  const plan = doc.plan;
  if (!isPlainObject(plan)) {
    return { doc, changed: false, renamedKeys: [] };
  }

  const renames = CATEGORY_B_KEY_RENAMES.filter((rename) => rename.legacyKey in plan);
  if (renames.length === 0) {
    return { doc, changed: false, renamedKeys: [] };
  }
  for (const { legacyKey, namespacedKey } of renames) {
    if (namespacedKey in plan) {
      throw new CategoryBConflictError(legacyKey, namespacedKey);
    }
  }

  const renameMap = new Map(renames.map((r) => [r.legacyKey, r.namespacedKey]));
  const rebuilt: JsonObject = {};
  for (const [key, value] of Object.entries(plan)) {
    rebuilt[renameMap.get(key) ?? key] = value;
  }
  doc.plan = rebuilt;

  return { doc, changed: true, renamedKeys: renames.map((r) => r.namespacedKey) };
}

export interface CorpusMigrationConflict {
  readonly path: string;
  readonly message: string;
}

export interface CorpusMigrationResult {
  readonly scanned: number;
  readonly changed: readonly string[];
  readonly conflicts: readonly CorpusMigrationConflict[];
}

function collectVbriefFiles(dir: string, acc: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectVbriefFiles(full, acc);
    } else if (entry.isFile() && hasArtifactSuffix(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Walk `vbrief/**\/*.vbrief.json` under projectRoot and namespace every
 * Category B key in place. Idempotent: a second run reports zero changes.
 * Files with a bare/namespaced conflict are reported, not rewritten.
 */
export function migrateCategoryBCorpus(projectRoot: string): CorpusMigrationResult {
  const root = resolve(projectRoot);
  const vbriefDir = resolveLifecycleRoot(root);
  let scanned = 0;
  const changed: string[] = [];
  const conflicts: CorpusMigrationConflict[] = [];

  for (const file of collectVbriefFiles(vbriefDir)) {
    if (!statSync(file).isFile()) {
      continue;
    }
    scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const relPath = relative(root, file).replace(/\\/g, "/");
    let result: NamespaceResult;
    try {
      result = namespaceCategoryBPlan(parsed);
    } catch (err) {
      conflicts.push({ path: relPath, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (result.changed) {
      writeFileSync(file, `${JSON.stringify(result.doc, null, 2)}\n`, "utf8");
      changed.push(relPath);
    }
  }

  return { scanned, changed: changed.sort(), conflicts };
}
