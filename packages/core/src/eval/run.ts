import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveEvalPath } from "../layout/resolve.js";
import { BYTE_DIFF_WHOLE_FILE_THRESHOLD, InstrumentedVbriefCrud } from "./crud-telemetry.js";
import { evaluateHealth } from "./health.js";
import {
  applyVersionPinToSharedBenchmark,
  type FrameworkVersionPin,
  resolveFrameworkVersionPin,
} from "./version-pin.js";

export const GOLDEN_RUNS_HISTORY_REL = "results/golden-runs.jsonl";
export const GOLDEN_RUN_SCHEMA_VERSION = 1 as const;
export const GOLDEN_CORPUS_VERSION = "2026-07-05-tier2-fixture-v1";

const VALID_VBRIEF = `{
  "vBRIEFInfo": { "version": "0.6", "description": "golden fixture" },
  "plan": {
    "id": "golden-fixture",
    "title": "Golden fixture",
    "status": "pending",
    "narratives": { "Description": "Valid golden corpus document." },
    "items": [
      {
        "id": "golden-a1",
        "title": "Item",
        "status": "pending",
        "narrative": { "Acceptance": "Schema valid." }
      }
    ]
  }
}`;

const INVENTED_KEY_VBRIEF = VALID_VBRIEF.replace(
  '"items": [',
  '"agentInventedField": "bad",\n    "items": [',
);

/** One synthetic golden-task definition with an objective grader. */
export interface GoldenTaskDefinition {
  readonly id: string;
  readonly title: string;
  readonly holdout: boolean;
  readonly grade: (context: GoldenTaskContext) => GoldenTaskGrade;
}

/** Runtime context passed to golden-task graders. */
export interface GoldenTaskContext {
  readonly tempDir: string;
  readonly seed: number;
  readonly directiveVersion: string;
  readonly model: string;
}

/** Objective grader output for a single task × seed. */
export interface GoldenTaskGrade {
  readonly passed: boolean;
  readonly metrics: Readonly<Record<string, number | boolean>>;
}

/** One graded task outcome within a golden run. */
export interface GoldenTaskResult {
  readonly taskId: string;
  readonly seed: number;
  readonly passed: boolean;
  readonly holdout: boolean;
  readonly metrics: Readonly<Record<string, number | boolean>>;
}

/** Versioned golden-run record persisted to the `.eval` ledger (#1703 Tier 2). */
export interface GoldenRunRecord {
  readonly schemaVersion: typeof GOLDEN_RUN_SCHEMA_VERSION;
  readonly runId: string;
  /** Framework version pin for this run (alias of frameworkVersionPin.frameworkVersion). */
  readonly directiveVersion: string;
  /**
   * Resolved framework version pin captured at run start (#3215).
   * Optional for ledger rows written before the purity gate shipped.
   */
  readonly frameworkVersionPin?: FrameworkVersionPin;
  readonly model: string;
  readonly harness: string;
  readonly seeds: readonly number[];
  readonly corpusVersion: string;
  readonly recordedAt: string;
  readonly results: readonly GoldenTaskResult[];
  readonly summary: GoldenRunSummary;
}

/** Aggregate metrics for one golden run. */
export interface GoldenRunSummary {
  readonly primaryPassRate: number;
  readonly holdoutPassRate: number;
  readonly passRate: number;
  readonly primaryTotal: number;
  readonly holdoutTotal: number;
}

export interface RunGoldenEvalOptions {
  readonly projectRoot?: string;
  readonly model: string;
  readonly seeds?: readonly number[];
  readonly directiveVersion?: string;
  readonly harness?: string;
  readonly persist?: boolean;
  readonly now?: () => Date;
  readonly mkTempDir?: () => string;
}

export interface RunGoldenEvalResult {
  readonly code: 0 | 1 | 2;
  readonly record: GoldenRunRecord | null;
  readonly message: string;
  /** #1584 shared-benchmark manifest after version pin wire, when present on disk. */
  readonly sharedBenchmarkManifest?: Record<string, unknown> | null;
}

function passRate(results: readonly GoldenTaskResult[], holdout: boolean): number {
  const subset = results.filter((r) => r.holdout === holdout);
  if (subset.length === 0) {
    return 0;
  }
  return subset.filter((r) => r.passed).length / subset.length;
}

function summarizeResults(results: readonly GoldenTaskResult[]): GoldenRunSummary {
  const primary = results.filter((r) => !r.holdout);
  const holdout = results.filter((r) => r.holdout);
  const primaryPassRate = passRate(results, false);
  const holdoutPassRate = passRate(results, true);
  return {
    primaryPassRate,
    holdoutPassRate,
    passRate: results.length === 0 ? 0 : results.filter((r) => r.passed).length / results.length,
    primaryTotal: primary.length,
    holdoutTotal: holdout.length,
  };
}

function gradeCrudValidCreate(context: GoldenTaskContext): GoldenTaskGrade {
  const path = join(context.tempDir, "create.json");
  const crud = new InstrumentedVbriefCrud({ directiveVersion: context.directiveVersion });
  const result = crud.create(path, VALID_VBRIEF);
  const metric = crud.getMetrics()[0];
  return {
    passed: result.ok && metric?.schemaValid === true,
    metrics: {
      schemaValid: metric?.schemaValid === true,
      fieldInventionCount: metric?.fieldInventionCount ?? -1,
    },
  };
}

function gradeCrudRejectInvention(context: GoldenTaskContext): GoldenTaskGrade {
  const path = join(context.tempDir, "invented.json");
  const crud = new InstrumentedVbriefCrud({ directiveVersion: context.directiveVersion });
  crud.create(path, INVENTED_KEY_VBRIEF);
  const metric = crud.getMetrics()[0];
  const inventedKeys = metric?.inventedKeys.length ?? 0;
  return {
    passed:
      metric?.schemaValid === true && inventedKeys > 0 && (metric?.fieldInventionCount ?? 0) > 0,
    metrics: {
      detectedInvention: inventedKeys > 0,
      fieldInventionCount: metric?.fieldInventionCount ?? -1,
    },
  };
}

function gradeCrudSurgicalUpdate(context: GoldenTaskContext): GoldenTaskGrade {
  const path = join(context.tempDir, "update.json");
  const crud = new InstrumentedVbriefCrud({ directiveVersion: context.directiveVersion });
  crud.create(path, VALID_VBRIEF);
  const updated = VALID_VBRIEF.replace('"pending"', '"running"');
  crud.update(path, updated);
  const updateMetric = crud.getMetrics().find((m) => m.operation === "update");
  return {
    passed:
      updateMetric?.schemaValid === true &&
      updateMetric.byteDiffMinimality === "surgical" &&
      (updateMetric.byteDiffChangedRatio ?? 1) < BYTE_DIFF_WHOLE_FILE_THRESHOLD,
    metrics: {
      schemaValid: updateMetric?.schemaValid === true,
      byteDiffMinimalitySurgical: updateMetric?.byteDiffMinimality === "surgical",
      changedRatio: updateMetric?.byteDiffChangedRatio ?? -1,
    },
  };
}

function seedHealthFixture(tempDir: string): void {
  const root = resolve(tempDir);
  // #2980 wave C: product fixture seed routes through containedWrite.
  containedWrite({
    root,
    target: join("xbrief", "PROJECT-DEFINITION.xbrief.json"),
    data: JSON.stringify({
      xBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Golden health fixture",
        status: "running",
        items: [],
        "x-directive/policy": { triageScope: [{ rule: "all-open" }] },
      },
    }),
    mode: "replace",
  });
  containedWrite({
    root,
    target: "AGENTS.md",
    data: "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
    mode: "replace",
  });
}

function gradeHealthFixture(context: GoldenTaskContext): GoldenTaskGrade {
  seedHealthFixture(context.tempDir);
  const health = evaluateHealth({
    projectRoot: context.tempDir,
    persist: false,
    frameworkSource: false,
  });
  return {
    passed: health.report !== null && typeof health.report.score === "number",
    metrics: {
      score: health.report?.score ?? -1,
      gateCount: health.report?.gates.length ?? -1,
    },
  };
}

function gradeHoldoutSchemaRoundtrip(context: GoldenTaskContext): GoldenTaskGrade {
  const path = join(context.tempDir, "roundtrip.json");
  const crud = new InstrumentedVbriefCrud({ directiveVersion: context.directiveVersion });
  crud.create(path, VALID_VBRIEF);
  const read = crud.read(path);
  const roundtripOk = read.ok && read.content === VALID_VBRIEF;
  const noise = (context.seed % 997) / 997;
  return {
    passed: roundtripOk && noise < 0.99,
    metrics: { roundtripOk, seedNoise: noise },
  };
}

function gradeHoldoutByteDiffTripwire(context: GoldenTaskContext): GoldenTaskGrade {
  const path = join(context.tempDir, "rewrite.json");
  const crud = new InstrumentedVbriefCrud({ directiveVersion: context.directiveVersion });
  crud.create(path, VALID_VBRIEF);
  const rewritten = JSON.stringify(JSON.parse(VALID_VBRIEF), null, 2);
  crud.update(path, rewritten);
  const updateMetric = crud.getMetrics().find((m) => m.operation === "update");
  const detectedRewrite = updateMetric?.byteDiffMinimality === "whole-file-rewrite";
  const tripwire = (context.seed % 991) / 991;
  return {
    passed: detectedRewrite && tripwire < 0.99,
    metrics: {
      detectedRewrite,
      tripwire,
    },
  };
}

/** Fixed golden corpus with objective graders (#1703 Tier 2). */
export const GOLDEN_CORPUS: readonly GoldenTaskDefinition[] = [
  {
    id: "crud-valid-create",
    title: "Instrumented create accepts valid vBRIEF",
    holdout: false,
    grade: gradeCrudValidCreate,
  },
  {
    id: "crud-reject-invention",
    title: "Instrumented create rejects invented keys",
    holdout: false,
    grade: gradeCrudRejectInvention,
  },
  {
    id: "crud-surgical-update",
    title: "Instrumented update classifies surgical edits",
    holdout: false,
    grade: gradeCrudSurgicalUpdate,
  },
  {
    id: "health-fixture-score",
    title: "Tier-0 health eval runs on fixture repo",
    holdout: false,
    grade: gradeHealthFixture,
  },
  {
    id: "holdout-schema-roundtrip",
    title: "Holdout: read-after-create roundtrip",
    holdout: true,
    grade: gradeHoldoutSchemaRoundtrip,
  },
  {
    id: "holdout-byte-diff-tripwire",
    title: "Holdout: whole-file rewrite detection tripwire",
    holdout: true,
    grade: gradeHoldoutByteDiffTripwire,
  },
];

/** Absolute path to the golden-run results ledger. */
export function goldenRunsHistoryPath(projectRoot: string): string {
  return resolveEvalPath(projectRoot, GOLDEN_RUNS_HISTORY_REL);
}

/** Append one golden run to the versioned ledger (#1703 Tier 2). */
export function persistGoldenRun(projectRoot: string, record: GoldenRunRecord): void {
  const path = goldenRunsHistoryPath(projectRoot);
  // #2980 wave C: product write sink routes through containedWrite.
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: `${JSON.stringify(record)}\n`,
    mode: "append",
  });
}

/** Stable hash for rotating holdout selection (#1703 Goodhart mitigation). */
export function holdoutRotationIndex(
  directiveVersion: string,
  model: string,
  holdoutCount: number,
): number {
  if (holdoutCount <= 0) {
    return 0;
  }
  const digest = createHash("sha256")
    .update(`${directiveVersion}\0${model}\0${GOLDEN_CORPUS_VERSION}`)
    .digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) % holdoutCount;
}

/** Select the active holdout task for this version × model tuple. */
export function selectRotatingHoldoutTask(
  directiveVersion: string,
  model: string,
): GoldenTaskDefinition | null {
  const holdouts = GOLDEN_CORPUS.filter((task) => task.holdout);
  if (holdouts.length === 0) {
    return null;
  }
  return holdouts[holdoutRotationIndex(directiveVersion, model, holdouts.length)] ?? null;
}

function seedTempDir(taskId: string, seed: number): string {
  const base = mkdtempSync(join(tmpdir(), `deft-golden-${taskId}-seed-${seed}-`));
  mkdirSync(join(base, "xbrief"), { recursive: true });
  return base;
}

function runIdFor(
  directiveVersion: string,
  model: string,
  harness: string,
  seeds: readonly number[],
): string {
  const digest = createHash("sha256")
    .update(
      `${directiveVersion}\0${model}\0${harness}\0${seeds.join(",")}\0${GOLDEN_CORPUS_VERSION}`,
    )
    .digest("hex");
  return digest.slice(0, 12);
}

/** Execute the golden corpus for one model × seed set and optionally persist (#1703 Tier 2). */
export function runGoldenEval(options: RunGoldenEvalOptions): RunGoldenEvalResult {
  if (!options.model.trim()) {
    return { code: 2, record: null, message: "eval:run: --model is required" };
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const now = options.now ?? (() => new Date());
  // #3215: resolve framework version once at run start (package.json pin or override).
  const frameworkVersionPin = resolveFrameworkVersionPin({
    override: options.directiveVersion,
    now,
  });
  const directiveVersion = frameworkVersionPin.frameworkVersion;
  const harness = options.harness ?? "deterministic-fixture";
  const seeds = options.seeds ?? [1, 2, 3];
  const persist = options.persist ?? true;

  if (seeds.length === 0) {
    return { code: 2, record: null, message: "eval:run: at least one seed is required" };
  }

  const primaryTasks = GOLDEN_CORPUS.filter((task) => !task.holdout);
  const rotatingHoldout = selectRotatingHoldoutTask(directiveVersion, options.model);
  const tasksToRun: GoldenTaskDefinition[] = [...primaryTasks];
  if (rotatingHoldout !== null) {
    tasksToRun.push(rotatingHoldout);
  }

  const results: GoldenTaskResult[] = [];
  const scratchDirs: string[] = [];
  for (const task of tasksToRun) {
    for (const seed of seeds) {
      const tempDir = seedTempDir(task.id, seed);
      scratchDirs.push(tempDir);
      const grade = task.grade({
        tempDir,
        seed,
        directiveVersion,
        model: options.model,
      });
      results.push({
        taskId: task.id,
        seed,
        passed: grade.passed,
        holdout: task.holdout,
        metrics: grade.metrics,
      });
    }
  }

  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  const summary = summarizeResults(results);
  const record: GoldenRunRecord = {
    schemaVersion: GOLDEN_RUN_SCHEMA_VERSION,
    runId: runIdFor(directiveVersion, options.model, harness, seeds),
    directiveVersion,
    frameworkVersionPin,
    model: options.model,
    harness,
    seeds,
    corpusVersion: GOLDEN_CORPUS_VERSION,
    recordedAt: now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    results,
    summary,
  };

  // #1584 / #3215: when shared-benchmark.json is present, wire + persist the pin.
  let sharedBenchmark: {
    applied: boolean;
    persisted: boolean;
    manifest: Record<string, unknown> | null;
  } = { applied: false, persisted: false, manifest: null };
  try {
    sharedBenchmark = applyVersionPinToSharedBenchmark(projectRoot, frameworkVersionPin, {
      persist,
    });
  } catch (err: unknown) {
    return {
      code: 2,
      record,
      message: `eval:run: failed to wire shared-benchmark pin: ${String(err)}`,
      sharedBenchmarkManifest: null,
    };
  }

  if (persist) {
    try {
      persistGoldenRun(projectRoot, record);
    } catch (err: unknown) {
      return {
        code: 2,
        record,
        message: `eval:run: failed to persist golden run: ${String(err)}`,
        sharedBenchmarkManifest: sharedBenchmark.manifest,
      };
    }
  }

  const lines = [
    `eval:run v${record.directiveVersion} model=${record.model} harness=${record.harness} seeds=[${record.seeds.join(",")}]`,
    `  framework version pin: ${frameworkVersionPin.frameworkVersion} (source=${frameworkVersionPin.source})`,
    `  primary pass rate: ${(summary.primaryPassRate * 100).toFixed(1)}% (${summary.primaryTotal} trials)`,
    `  holdout pass rate: ${(summary.holdoutPassRate * 100).toFixed(1)}% (${summary.holdoutTotal} trials)`,
    `  rotating holdout task: ${rotatingHoldout?.id ?? "none"}`,
    `  runId=${record.runId}`,
  ];
  if (sharedBenchmark.persisted) {
    lines.push("  shared-benchmark manifest: frameworkVersion pin persisted (#1584 / #3215)");
  } else if (sharedBenchmark.applied) {
    lines.push("  shared-benchmark manifest: frameworkVersion wired in-memory (#1584 / #3215)");
  }
  return {
    code: 0,
    record,
    message: lines.join("\n"),
    sharedBenchmarkManifest: sharedBenchmark.manifest,
  };
}
