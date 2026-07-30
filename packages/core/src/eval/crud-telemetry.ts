import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";
import { containedWrite } from "../fs/contained-write.js";
import { helpedMetricsHistoryPath } from "../metrics/resolve-metrics-home.js";
import { scanVbrief } from "../vbrief-validate/conformance.js";
import { validateVbriefSchema } from "../vbrief-validate/schema.js";

/** Relative path under the resolved metrics home for helped / value telemetry (#2545). */
export const CRUD_METRICS_HISTORY_REL = "helped/crud-metrics.jsonl";

export type CrudOperation = "create" | "read" | "update" | "delete";

export type ByteDiffMinimality = "surgical" | "whole-file-rewrite";

export interface CrudOperationMetric {
  readonly directiveVersion: string;
  readonly operation: CrudOperation;
  readonly path: string;
  readonly schemaValid: boolean;
  readonly schemaErrors: readonly string[];
  readonly fieldInventionCount: number;
  readonly inventedKeys: readonly string[];
  readonly byteDiffMinimality: ByteDiffMinimality | null;
  readonly byteDiffChangedRatio: number | null;
  readonly recordedAt: string;
}

export interface CrudResult {
  readonly ok: boolean;
  readonly content?: string;
  readonly error?: string;
}

export interface InstrumentedVbriefCrudOptions {
  readonly directiveVersion?: string;
  readonly now?: () => Date;
}

/** Whole-file rewrites change at least half of the bytes or re-serialize with high drift. */
export const BYTE_DIFF_WHOLE_FILE_THRESHOLD = 0.5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Edit distance between two UTF-8 strings (Levenshtein, two-row). */
function levenshteinDistance(before: string, after: string): number {
  if (before === after) {
    return 0;
  }
  if (before.length === 0) {
    return after.length;
  }
  if (after.length === 0) {
    return before.length;
  }

  let prev = Array.from({ length: after.length + 1 }, (_, index) => index);
  let curr = new Array<number>(after.length + 1).fill(0);

  for (let row = 1; row <= before.length; row += 1) {
    curr[0] = row;
    for (let col = 1; col <= after.length; col += 1) {
      const cost = before[row - 1] === after[col - 1] ? 0 : 1;
      const up = prev[col] ?? 0;
      const left = curr[col - 1] ?? 0;
      const diag = prev[col - 1] ?? 0;
      curr[col] = Math.min(up + 1, left + 1, diag + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[after.length] ?? 0;
}

/** Ratio of edit distance to the longer string length. */
export function computeChangedByteRatio(before: string, after: string): number {
  const maxLen = Math.max(before.length, after.length);
  if (maxLen === 0) {
    return 0;
  }
  return levenshteinDistance(before, after) / maxLen;
}

/** Classify whether an update preserved bytes (surgical) or rewrote the file. */
export function classifyByteDiffMinimality(
  before: string,
  after: string,
): { readonly kind: ByteDiffMinimality; readonly changedRatio: number } {
  const changedRatio = computeChangedByteRatio(before, after);
  try {
    const oldParsed: unknown = JSON.parse(before);
    const newParsed: unknown = JSON.parse(after);
    if (JSON.stringify(oldParsed) === JSON.stringify(newParsed) && changedRatio > 0) {
      return { kind: "whole-file-rewrite", changedRatio };
    }
  } catch {
    // Fall through to byte-ratio classification.
  }
  if (changedRatio >= BYTE_DIFF_WHOLE_FILE_THRESHOLD) {
    return { kind: "whole-file-rewrite", changedRatio };
  }
  return { kind: "surgical", changedRatio };
}

function assessDocument(
  path: string,
  parsed: unknown,
): {
  schemaValid: boolean;
  schemaErrors: string[];
  inventedKeys: string[];
} {
  if (!isRecord(parsed)) {
    return {
      schemaValid: false,
      schemaErrors: [`${path}: document must be a JSON object`],
      inventedKeys: [],
    };
  }
  const schemaErrors = validateVbriefSchema(parsed, path);
  const findings = scanVbrief(path, parsed);
  const inventedKeys = findings.map((finding) => finding.key);
  return {
    schemaValid: schemaErrors.length === 0,
    schemaErrors,
    inventedKeys,
  };
}

function sanitizeInlineMessage(message: string): string {
  return message.replace(/\r?\n/g, " ");
}

/**
 * Contained replace under the target's parent directory (#2980 wave C).
 * Metrics/CRUD sinks may live outside the project tree (platform metrics home).
 */
function containedReplaceAt(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  containedWrite({
    root: resolve(dir),
    target: basename(path),
    data: content,
    mode: "replace",
  });
}

/** Absolute path to the versioned CRUD metrics ledger (#1703 Tier 1 / #2545). */
export function crudMetricsHistoryPath(projectRoot: string): string | null {
  return helpedMetricsHistoryPath(projectRoot);
}

/** Append CRUD operation metrics to the versioned ledger (#1703 Tier 1 / #2545). */
export function persistCrudMetrics(
  projectRoot: string,
  metrics: readonly CrudOperationMetric[],
): void {
  if (metrics.length === 0) {
    return;
  }
  const path = crudMetricsHistoryPath(projectRoot);
  if (path === null) {
    return;
  }
  // #2980 wave C: product write sink routes through containedWrite.
  // Metrics home is often outside the project tree (#2545) — contain under ledger parent.
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  for (const metric of metrics) {
    containedWrite({
      root: resolve(dir),
      target: basename(path),
      data: `${JSON.stringify(metric)}\n`,
      mode: "append",
    });
  }
}

/**
 * Instrumented vBRIEF/xBRIEF CRUD chokepoint (#1703 Tier 1).
 * Every operation emits a version-tagged metric covering schema validity,
 * field invention, and (for updates) byte-diff minimality.
 * Delete intentionally succeeds on schema-invalid files so corrupt artifacts can be removed.
 */
export class InstrumentedVbriefCrud {
  private readonly directiveVersion: string;
  private readonly now: () => Date;
  private readonly metrics: CrudOperationMetric[] = [];

  constructor(options: InstrumentedVbriefCrudOptions = {}) {
    this.directiveVersion = options.directiveVersion ?? readCorePackageVersion();
    this.now = options.now ?? (() => new Date());
  }

  getMetrics(): readonly CrudOperationMetric[] {
    return this.metrics;
  }

  clearMetrics(): void {
    this.metrics.length = 0;
  }

  create(path: string, content: string): CrudResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: unknown) {
      const message = sanitizeInlineMessage(err instanceof Error ? err.message : String(err));
      this.recordMetric({
        operation: "create",
        path,
        schemaValid: false,
        schemaErrors: [`${path}: invalid JSON -- ${message}`],
        inventedKeys: [],
        byteDiffMinimality: null,
        byteDiffChangedRatio: null,
      });
      return { ok: false, error: message };
    }

    const assessment = assessDocument(path, parsed);
    this.recordMetric({
      operation: "create",
      path,
      schemaValid: assessment.schemaValid,
      schemaErrors: assessment.schemaErrors,
      inventedKeys: assessment.inventedKeys,
      byteDiffMinimality: null,
      byteDiffChangedRatio: null,
    });

    if (!assessment.schemaValid) {
      return { ok: false, error: assessment.schemaErrors.join("; ") };
    }

    // #2980 wave C: product write sink routes through containedWrite.
    containedReplaceAt(path, content);
    return { ok: true };
  }

  read(path: string): CrudResult {
    if (!existsSync(path)) {
      this.recordMetric({
        operation: "read",
        path,
        schemaValid: false,
        schemaErrors: [`${path}: file not found`],
        inventedKeys: [],
        byteDiffMinimality: null,
        byteDiffChangedRatio: null,
      });
      return { ok: false, error: "ENOENT" };
    }

    const content = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: unknown) {
      const message = sanitizeInlineMessage(err instanceof Error ? err.message : String(err));
      this.recordMetric({
        operation: "read",
        path,
        schemaValid: false,
        schemaErrors: [`${path}: invalid JSON -- ${message}`],
        inventedKeys: [],
        byteDiffMinimality: null,
        byteDiffChangedRatio: null,
      });
      return { ok: false, error: message };
    }

    const assessment = assessDocument(path, parsed);
    this.recordMetric({
      operation: "read",
      path,
      schemaValid: assessment.schemaValid,
      schemaErrors: assessment.schemaErrors,
      inventedKeys: assessment.inventedKeys,
      byteDiffMinimality: null,
      byteDiffChangedRatio: null,
    });

    if (!assessment.schemaValid) {
      return { ok: false, error: assessment.schemaErrors.join("; ") };
    }

    return { ok: true, content };
  }

  update(path: string, content: string, options: { trustedWrite?: boolean } = {}): CrudResult {
    const previousBytes =
      options.trustedWrite || !existsSync(path) ? null : readFileSync(path, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: unknown) {
      const message = sanitizeInlineMessage(err instanceof Error ? err.message : String(err));
      this.recordMetric({
        operation: "update",
        path,
        schemaValid: false,
        schemaErrors: [`${path}: invalid JSON -- ${message}`],
        inventedKeys: [],
        byteDiffMinimality: null,
        byteDiffChangedRatio: null,
      });
      return { ok: false, error: message };
    }

    const assessment = assessDocument(path, parsed);
    let byteDiffMinimality: ByteDiffMinimality | null = null;
    let byteDiffChangedRatio: number | null = null;
    if (previousBytes !== null) {
      const diff = classifyByteDiffMinimality(previousBytes, content);
      byteDiffMinimality = diff.kind;
      byteDiffChangedRatio = diff.changedRatio;
    }

    this.recordMetric({
      operation: "update",
      path,
      schemaValid: assessment.schemaValid,
      schemaErrors: assessment.schemaErrors,
      inventedKeys: assessment.inventedKeys,
      byteDiffMinimality,
      byteDiffChangedRatio,
    });

    if (!assessment.schemaValid && !options.trustedWrite) {
      return { ok: false, error: assessment.schemaErrors.join("; ") };
    }

    // #2980 wave C: product write sink routes through containedWrite.
    containedReplaceAt(path, content);
    return { ok: true };
  }

  /** Record update metrics without persisting (caller owns validated atomic write). */
  recordTrustedUpdate(path: string, content: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: unknown) {
      const message = sanitizeInlineMessage(err instanceof Error ? err.message : String(err));
      this.recordMetric({
        operation: "update",
        path,
        schemaValid: false,
        schemaErrors: [`${path}: invalid JSON -- ${message}`],
        inventedKeys: [],
        byteDiffMinimality: null,
        byteDiffChangedRatio: null,
      });
      return;
    }

    const assessment = assessDocument(path, parsed);
    this.recordMetric({
      operation: "update",
      path,
      schemaValid: assessment.schemaValid,
      schemaErrors: assessment.schemaErrors,
      inventedKeys: assessment.inventedKeys,
      byteDiffMinimality: null,
      byteDiffChangedRatio: null,
    });
  }

  delete(path: string): CrudResult {
    if (!existsSync(path)) {
      this.recordMetric({
        operation: "delete",
        path,
        schemaValid: false,
        schemaErrors: [`${path}: file not found`],
        inventedKeys: [],
        byteDiffMinimality: null,
        byteDiffChangedRatio: null,
      });
      return { ok: false, error: "ENOENT" };
    }

    const content = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: unknown) {
      const message = sanitizeInlineMessage(err instanceof Error ? err.message : String(err));
      this.recordMetric({
        operation: "delete",
        path,
        schemaValid: false,
        schemaErrors: [`${path}: invalid JSON -- ${message}`],
        inventedKeys: [],
        byteDiffMinimality: null,
        byteDiffChangedRatio: null,
      });
      unlinkSync(path);
      return { ok: true };
    }

    const assessment = assessDocument(path, parsed);
    this.recordMetric({
      operation: "delete",
      path,
      schemaValid: assessment.schemaValid,
      schemaErrors: assessment.schemaErrors,
      inventedKeys: assessment.inventedKeys,
      byteDiffMinimality: null,
      byteDiffChangedRatio: null,
    });

    unlinkSync(path);
    return { ok: true };
  }

  private recordMetric(input: {
    operation: CrudOperation;
    path: string;
    schemaValid: boolean;
    schemaErrors: readonly string[];
    inventedKeys: readonly string[];
    byteDiffMinimality: ByteDiffMinimality | null;
    byteDiffChangedRatio: number | null;
  }): void {
    this.metrics.push({
      directiveVersion: this.directiveVersion,
      operation: input.operation,
      path: input.path,
      schemaValid: input.schemaValid,
      schemaErrors: input.schemaErrors,
      fieldInventionCount: input.inventedKeys.length,
      inventedKeys: input.inventedKeys,
      byteDiffMinimality: input.byteDiffMinimality,
      byteDiffChangedRatio: input.byteDiffChangedRatio,
      recordedAt: this.now().toISOString(),
    });
  }
}
