import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Committed durations schema for cold-worktree slowest-first (#5028). */
export const FILE_DURATIONS_SCHEMA = "deft.vitest-file-durations.v1" as const;

/** Default fixture path (repo-relative via this module). */
export const DEFAULT_FILE_DURATIONS_PATH = resolve(
  import.meta.dirname,
  "../../fixtures/vitest-file-durations.json",
);

export type FileDurationsLoad =
  | { readonly kind: "ok"; readonly durations: ReadonlyMap<string, number> }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Strip optional Vitest project prefixes (`unit:`, `spawn-heavy:`, bare `:`).
 * Repo-relative paths with drive/colon stay intact.
 */
export function normalizeDurationPathKey(raw: string): string {
  const slash = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const idx = slash.indexOf(":");
  if (idx === -1) return slash;
  const left = slash.slice(0, idx);
  // Keep Windows drive paths (C:/...). Strip empty / project prefixes only.
  if (/^[A-Za-z]$/.test(left)) return slash;
  if (left === "" || !left.includes("/")) {
    return slash.slice(idx + 1).replace(/^\.\//, "");
  }
  return slash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a committed durations document into a path→ms map (returned failures). */
export function parseFileDurationsDocument(raw: unknown): FileDurationsLoad {
  if (!isRecord(raw)) {
    return { kind: "invalid", reason: "durations document must be a JSON object" };
  }
  if (raw.schema !== FILE_DURATIONS_SCHEMA) {
    return {
      kind: "invalid",
      reason: `expected schema ${FILE_DURATIONS_SCHEMA}`,
    };
  }
  if (!isRecord(raw.files)) {
    return { kind: "invalid", reason: "durations document requires files object" };
  }
  const durations = new Map<string, number>();
  for (const [key, value] of Object.entries(raw.files)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return {
        kind: "invalid",
        reason: `files[${key}] must be a non-negative finite number`,
      };
    }
    durations.set(normalizeDurationPathKey(key), value);
  }
  return { kind: "ok", durations };
}

/** Load committed durations from disk; missing/invalid become returned failures. */
export function loadFileDurationsFromPath(filePath: string): FileDurationsLoad {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return { kind: "missing", reason: `durations file not found: ${filePath}` };
    }
    return {
      kind: "invalid",
      reason: `failed to read durations file: ${filePath}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { kind: "invalid", reason: `durations file is not valid JSON: ${filePath}` };
  }
  return parseFileDurationsDocument(parsed);
}

/**
 * Longer listed files first. Unlisted pairs keep caller order (return 0).
 * A listed file sorts before an unlisted peer so known-slow work starts early.
 */
export function compareSpecsByCommittedDuration(
  aPath: string,
  bPath: string,
  durations: ReadonlyMap<string, number>,
): number {
  const da = durations.get(normalizeDurationPathKey(aPath));
  const db = durations.get(normalizeDurationPathKey(bPath));
  if (da !== undefined && db !== undefined) return db - da;
  if (da !== undefined) return -1;
  if (db !== undefined) return 1;
  return 0;
}

/** Spec fields DurationSequencer.sort uses after BaseSequencer order. */
export type DurationSequenceSpec = {
  readonly projectName: string;
  readonly groupOrder: number;
  readonly relativePath: string;
};

/**
 * Same comparator DurationSequencer.sort applies (groupOrder, then project
 * name, then committed duration). Exported so unit tests assert returned order
 * without constructing a Vitest ctx (#5140).
 */
export function compareSpecsForDurationSequence(
  a: DurationSequenceSpec,
  b: DurationSequenceSpec,
  durations: ReadonlyMap<string, number>,
): number {
  const groupOrderDiff = a.groupOrder - b.groupOrder;
  if (groupOrderDiff !== 0) return groupOrderDiff;
  if (a.projectName !== b.projectName) {
    return a.projectName < b.projectName ? -1 : 1;
  }
  return compareSpecsByCommittedDuration(a.relativePath, b.relativePath, durations);
}

/** Stable sort using {@link compareSpecsForDurationSequence}; returns a new array. */
export function sortSpecsByDurationSequence<T extends DurationSequenceSpec>(
  specs: readonly T[],
  durations: ReadonlyMap<string, number>,
): T[] {
  return [...specs].sort((a, b) => compareSpecsForDurationSequence(a, b, durations));
}

/**
 * Cold-worktree sequencer: committed durations + BaseSequencer fallback (#5028).
 * Does not bind host-global cache.dir. Keep unit and spawn-heavy on the same
 * Vitest groupOrder so projects overlap; do not serialize via groupOrder.
 */
export class DurationSequencer extends BaseSequencer {
  #durations: ReadonlyMap<string, number> | null = null;
  #loadWarned = false;

  #resolvedDurations(): ReadonlyMap<string, number> {
    if (this.#durations !== null) return this.#durations;
    const loaded = loadFileDurationsFromPath(DEFAULT_FILE_DURATIONS_PATH);
    if (loaded.kind !== "ok") {
      if (!this.#loadWarned) {
        this.#loadWarned = true;
        console.warn(
          `[DurationSequencer] committed durations unavailable (${loaded.kind}): ${loaded.reason}; falling back to BaseSequencer order`,
        );
      }
      this.#durations = new Map();
      return this.#durations;
    }
    this.#durations = loaded.durations;
    return this.#durations;
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const baseOrdered = await super.sort(files);
    const durations = this.#resolvedDurations();
    if (durations.size === 0) return baseOrdered;

    const keyed = baseOrdered.map((spec) => ({
      spec,
      projectName: spec.project.name,
      groupOrder: spec.project.config.sequence.groupOrder,
      relativePath: relative(this.ctx.config.root, spec.moduleId).replace(/\\/g, "/"),
    }));
    return sortSpecsByDurationSequence(keyed, durations).map((row) => row.spec);
  }
}

export default DurationSequencer;
