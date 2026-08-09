/**
 * #3215 — pin and record framework version per eval cell; refuse mixed-version aggregation.
 * Extends #3081 empiricism; wires into the #1584 shared-benchmark manifest shape when present.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";

/** Repo-relative path for the #1584 shared-benchmark manifest. */
export const SHARED_BENCHMARK_MANIFEST_REL = "evals/shared-benchmark.json";

/** How the framework version was resolved at eval run start. */
export type FrameworkVersionSource = "package.json" | "override";

/** Policy when a treatment cell contains disagreeing framework versions. */
export type MixedVersionPolicy = "refuse" | "flag";

/** Resolved framework version pin captured once at eval run start. */
export interface FrameworkVersionPin {
  readonly frameworkVersion: string;
  readonly source: FrameworkVersionSource;
  readonly resolvedAt: string;
}

/** Minimal run identity for cell purity checks (version + treatment grouping). */
export interface VersionedEvalRun {
  readonly frameworkVersion: string;
  readonly treatment?: string;
  readonly model?: string;
  readonly harness?: string;
  readonly runId?: string;
}

/** Result of checking whether one treatment cell is version-pure. */
export interface CellVersionPurity {
  readonly pure: boolean;
  readonly frameworkVersion: string | null;
  readonly versions: readonly string[];
  readonly runCount: number;
  readonly treatment: string;
  readonly message: string;
}

export interface AggregateCellOptions {
  readonly runs: readonly VersionedEvalRun[];
  /** Treatment key when runs omit `treatment` (e.g. model or with_skill). */
  readonly treatment?: string;
  /** Default `refuse`: mixed cells block aggregation. `flag` allows with purity evidence. */
  readonly policy?: MixedVersionPolicy;
}

export interface AggregateCellResult {
  readonly purity: CellVersionPurity;
  readonly allowed: boolean;
  readonly policy: MixedVersionPolicy;
  readonly frameworkVersion: string | null;
}

/** Version block stamped onto a #1584-shaped shared-benchmark manifest. */
export interface SharedBenchmarkVersionBlock {
  readonly frameworkVersion: string;
  readonly frameworkVersionSource: FrameworkVersionSource;
  readonly frameworkVersionResolvedAt: string;
  readonly versionPurityGate: "#3215";
}

function toIsoZ(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve the directive framework version once at eval run start.
 * Prefers an explicit override (tests / pinned doctor output); else package.json pin.
 */
export function resolveFrameworkVersionPin(options?: {
  readonly override?: string;
  readonly now?: () => Date;
}): FrameworkVersionPin {
  const now = options?.now ?? (() => new Date());
  const override = options?.override?.trim();
  if (override !== undefined && override.length > 0) {
    return {
      frameworkVersion: override,
      source: "override",
      resolvedAt: toIsoZ(now()),
    };
  }
  return {
    frameworkVersion: readCorePackageVersion(),
    source: "package.json",
    resolvedAt: toIsoZ(now()),
  };
}

/**
 * Cell-level purity: all runs in one treatment must share a single framework version.
 * Empty run sets are vacuously pure.
 */
export function evaluateCellVersionPurity(
  runs: readonly VersionedEvalRun[],
  treatment?: string,
): CellVersionPurity {
  const label =
    treatment?.trim() ||
    runs.find((r) => typeof r.treatment === "string" && r.treatment.length > 0)?.treatment ||
    "default";
  const versions = [
    ...new Set(runs.map((r) => r.frameworkVersion.trim()).filter((v) => v.length > 0)),
  ].sort();

  if (runs.length === 0) {
    return {
      pure: true,
      frameworkVersion: null,
      versions: [],
      runCount: 0,
      treatment: label,
      message: `Cell "${label}": no runs (vacuously pure).`,
    };
  }

  if (versions.length <= 1) {
    const version = versions[0] ?? null;
    return {
      pure: true,
      frameworkVersion: version,
      versions,
      runCount: runs.length,
      treatment: label,
      message: `Cell "${label}": version-pure (v${version ?? "unknown"}, ${runs.length} run(s)).`,
    };
  }

  return {
    pure: false,
    frameworkVersion: null,
    versions,
    runCount: runs.length,
    treatment: label,
    message: `Cell "${label}": mixed framework versions [${versions.join(", ")}] across ${runs.length} run(s) — mixed-version aggregation blocked (#3215).`,
  };
}

/**
 * Aggregate (or refuse) runs for one treatment under the mixed-version policy.
 * `refuse` (default) sets `allowed=false` when versions disagree; `flag` allows with evidence.
 */
export function aggregateCellWithVersionPurity(options: AggregateCellOptions): AggregateCellResult {
  const policy = options.policy ?? "refuse";
  const purity = evaluateCellVersionPurity(options.runs, options.treatment);
  const allowed = purity.pure || policy === "flag";
  return {
    purity,
    allowed,
    policy,
    frameworkVersion: purity.frameworkVersion,
  };
}

/**
 * Group runs by treatment (or model×harness fallback) and evaluate purity per cell.
 */
export function evaluateLedgerVersionPurity(runs: readonly VersionedEvalRun[]): {
  readonly pure: boolean;
  readonly cells: readonly CellVersionPurity[];
  readonly summary: string;
} {
  const groups = new Map<string, VersionedEvalRun[]>();
  for (const run of runs) {
    const key =
      run.treatment?.trim() ||
      [run.model ?? "", run.harness ?? ""].filter((p) => p.length > 0).join("@") ||
      "default";
    const list = groups.get(key) ?? [];
    list.push(run);
    groups.set(key, list);
  }

  const cells = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => evaluateCellVersionPurity(group, key));

  const pure = cells.every((c) => c.pure);
  const mixed = cells.filter((c) => !c.pure);
  const summary =
    cells.length === 0
      ? "Version purity: no cells."
      : pure
        ? `Version purity: all ${cells.length} cell(s) pure.`
        : `Version purity: ${mixed.length}/${cells.length} cell(s) mixed — ${mixed.map((c) => c.treatment).join(", ")}.`;

  return { pure, cells, summary };
}

/**
 * Merge a framework version pin into a #1584-shaped shared-benchmark manifest object.
 * Stamps top-level `frameworkVersion` plus metadata for external consumers.
 */
export function wireFrameworkVersionIntoManifest(
  manifest: Record<string, unknown>,
  pin: FrameworkVersionPin,
): Record<string, unknown> {
  const priorMeta =
    typeof manifest.metadata === "object" &&
    manifest.metadata !== null &&
    !Array.isArray(manifest.metadata)
      ? { ...(manifest.metadata as Record<string, unknown>) }
      : {};

  const versionBlock: SharedBenchmarkVersionBlock = {
    frameworkVersion: pin.frameworkVersion,
    frameworkVersionSource: pin.source,
    frameworkVersionResolvedAt: pin.resolvedAt,
    versionPurityGate: "#3215",
  };

  return {
    ...manifest,
    frameworkVersion: pin.frameworkVersion,
    metadata: {
      ...priorMeta,
      ...versionBlock,
    },
  };
}

/** Load `evals/shared-benchmark.json` when present; otherwise null. */
export function loadSharedBenchmarkManifest(projectRoot: string): Record<string, unknown> | null {
  const path = resolve(projectRoot, SHARED_BENCHMARK_MANIFEST_REL);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * When a #1584 shared-benchmark manifest exists under the project root, return it
 * with the framework version pin wired in. Does not write to disk (caller owns I/O).
 */
export function applyVersionPinToSharedBenchmark(
  projectRoot: string,
  pin: FrameworkVersionPin,
): { readonly applied: boolean; readonly manifest: Record<string, unknown> | null } {
  const existing = loadSharedBenchmarkManifest(projectRoot);
  if (existing === null) {
    return { applied: false, manifest: null };
  }
  return { applied: true, manifest: wireFrameworkVersionIntoManifest(existing, pin) };
}
