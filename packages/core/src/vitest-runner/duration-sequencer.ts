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

/**
 * Cold-worktree sequencer: committed durations + BaseSequencer fallback (#5028).
 * Does not bind host-global cache.dir. Pair with sequence.groupOrder so
 * spawn-heavy starts before unit on the Step 5 project layout.
 */
export class DurationSequencer extends BaseSequencer {
  #durations: ReadonlyMap<string, number> | null = null;

  #resolvedDurations(): ReadonlyMap<string, number> {
    if (this.#durations !== null) return this.#durations;
    const loaded = loadFileDurationsFromPath(DEFAULT_FILE_DURATIONS_PATH);
    this.#durations = loaded.kind === "ok" ? loaded.durations : new Map();
    return this.#durations;
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const baseOrdered = await super.sort(files);
    const durations = this.#resolvedDurations();
    if (durations.size === 0) return baseOrdered;

    return [...baseOrdered].sort((a, b) => {
      const groupOrderDiff =
        a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder;
      if (groupOrderDiff !== 0) return groupOrderDiff;
      if (a.project.name !== b.project.name) {
        return a.project.name < b.project.name ? -1 : 1;
      }
      const aRel = relative(this.ctx.config.root, a.moduleId).replace(/\\/g, "/");
      const bRel = relative(this.ctx.config.root, b.moduleId).replace(/\\/g, "/");
      return compareSpecsByCommittedDuration(aRel, bRel, durations);
    });
  }
}

export default DurationSequencer;
