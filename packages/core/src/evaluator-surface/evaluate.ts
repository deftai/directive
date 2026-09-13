/**
 * verify:evaluator-surface (#4386 / #3156).
 *
 * Thin first ship: declared evaluator-definition diffs fail regardless of
 * prior color, unless a committed disclosure disposition covers them.
 * Prior color is unobserved here. Do not equate unknown with never-red.
 * Do not treat a commit-body issue/PR URL as reviewed authorization (#3164).
 *
 * Product-oracle fail-then-method-change history stays on #3322
 * (`flagPassAfterFailWithMethodChange`). This gate does not reimplement it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchAny, matchPath, normalizePath } from "../orchestration/pathspec.js";

export type OutputStream = "stdout" | "stderr" | "none";

export const DISPOSITION_REL = "xbrief/evaluator-surface-disposition.json";
export const DISPOSITION_SCHEMA = "deft.evaluator-surface-disposition.v1";
export const DISPOSITION_KIND_DISCLOSURE = "disclosure";

/** Declared evaluator-definition homes. Keep this list explicit and small. */
export const EVALUATOR_SURFACE_PATH_PATTERNS = [
  "Taskfile.yml",
  "tasks/verify.yml",
  "tasks/coverage.yml",
  ".deft/test-boundary.policy.json",
  "vitest.config.ts",
  "vitest.config.mjs",
  "vitest.config.js",
  "packages/core/src/check/gate-lists.ts",
  "packages/core/src/consumer-check-contract/evaluate.ts",
  "packages/core/src/evaluator-surface/**",
] as const;

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly skipped?: boolean;
}

export interface EvaluateOptions {
  readonly projectRoot?: string;
  readonly baseRef?: string;
  readonly staged?: boolean;
  readonly paths?: readonly string[];
  readonly quiet?: boolean;
  readonly dispositionText?: string | null;
}

export interface EvaluatorSurfaceDisposition {
  readonly schema: typeof DISPOSITION_SCHEMA;
  readonly kind: typeof DISPOSITION_KIND_DISCLOSURE;
  readonly issue?: number;
  readonly surfaces: readonly string[];
  readonly note?: string;
}

export function isEvaluatorSurfacePath(path: string): boolean {
  return matchAny(EVALUATOR_SURFACE_PATH_PATTERNS, normalizePath(path));
}

export function classifyEvaluatorSurfacePaths(paths: readonly string[]): {
  readonly isEvaluatorSurface: boolean;
  readonly matchedPaths: readonly string[];
} {
  const matchedPaths = paths.map(normalizePath).filter(isEvaluatorSurfacePath);
  return { isEvaluatorSurface: matchedPaths.length > 0, matchedPaths };
}

function gitNameOnlyDiff(projectRoot: string, args: string[]): string[] | { error: string } {
  try {
    const stdout = execFileSync("git", ["-C", projectRoot, "diff", "--name-only", ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err: unknown) {
    return { error: String(err) };
  }
}

export function collectChangedPaths(
  projectRoot: string,
  options: { baseRef?: string; staged?: boolean },
): string[] | { error: string } {
  if (options.staged) {
    return gitNameOnlyDiff(projectRoot, ["--cached"]);
  }
  if (options.baseRef !== undefined && options.baseRef.length > 0) {
    return gitNameOnlyDiff(projectRoot, [options.baseRef, "HEAD"]);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a committed disposition. v1 accepts disclosure only.
 * Authorization / reviewed kinds fail closed so a pasteable URL cannot
 * masquerade as #3164 protection.
 */
export function parseDisposition(raw: unknown): EvaluatorSurfaceDisposition | { error: string } {
  if (!isRecord(raw)) {
    return { error: "disposition must be a JSON object" };
  }
  if (raw.schema !== DISPOSITION_SCHEMA) {
    return { error: `disposition.schema must be ${DISPOSITION_SCHEMA}` };
  }
  if (raw.kind !== DISPOSITION_KIND_DISCLOSURE) {
    return {
      error:
        'disposition.kind must be "disclosure". A commit-body issue/PR URL is not reviewed authorization under #3164.',
    };
  }
  if (
    !Array.isArray(raw.surfaces) ||
    raw.surfaces.some((s) => typeof s !== "string" || s.length === 0)
  ) {
    return { error: "disposition.surfaces must be a non-empty-string array" };
  }
  const surfaces = raw.surfaces as string[];
  if (surfaces.length === 0) {
    return { error: "disposition.surfaces must list at least one path or glob" };
  }
  const issue = raw.issue;
  if (
    issue !== undefined &&
    (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0)
  ) {
    return { error: "disposition.issue must be a positive integer when set" };
  }
  const note = raw.note;
  if (note !== undefined && typeof note !== "string") {
    return { error: "disposition.note must be a string when set" };
  }
  return {
    schema: DISPOSITION_SCHEMA,
    kind: DISPOSITION_KIND_DISCLOSURE,
    issue: typeof issue === "number" ? issue : undefined,
    surfaces,
    note: typeof note === "string" ? note : undefined,
  };
}

export function dispositionCovers(disposition: EvaluatorSurfaceDisposition, path: string): boolean {
  const normalized = normalizePath(path);
  return disposition.surfaces.some((pattern) => matchPath(pattern, normalized));
}

export function dispositionPath(projectRoot: string): string {
  return join(resolve(projectRoot), DISPOSITION_REL);
}

export function readDisposition(
  projectRoot: string,
  injectedText?: string | null,
): EvaluatorSurfaceDisposition | { error: string } | null {
  let text: string;
  if (injectedText !== undefined) {
    if (injectedText === null) {
      return null;
    }
    text = injectedText;
  } else {
    const path = dispositionPath(projectRoot);
    if (!existsSync(path)) {
      return null;
    }
    try {
      text = readFileSync(path, "utf8");
    } catch (err: unknown) {
      return { error: `cannot read ${DISPOSITION_REL}: ${String(err)}` };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    return { error: `${DISPOSITION_REL} is not valid JSON: ${String(err)}` };
  }
  return parseDisposition(parsed);
}

function formatSkipMessage(): string {
  return (
    "verify:evaluator-surface: no declared evaluator-surface paths in the diff " +
    `(checked ${EVALUATOR_SURFACE_PATH_PATTERNS.length} patterns). ` +
    "Prior color is unobserved; unknown is not never-red."
  );
}

function formatPassMessage(
  matchedPaths: readonly string[],
  disposition: EvaluatorSurfaceDisposition,
): string {
  const issueBit = disposition.issue !== undefined ? ` issue=#${disposition.issue}` : "";
  return (
    `verify:evaluator-surface: disclosure recorded for ${matchedPaths.join(", ")}` +
    `${issueBit}. This is disclosure, not reviewed authorization under #3164. ` +
    "A commit-body issue/PR URL is not this record. Prior color is unobserved."
  );
}

function formatFailMessage(matchedPaths: readonly string[], detail: string): string {
  return (
    `verify:evaluator-surface: declared evaluator-surface diff requires a disclosure ` +
    `disposition at ${DISPOSITION_REL}. Prior color is unobserved; this gate fails ` +
    `regardless of prior color. Surfaces: ${matchedPaths.join(", ")}. ${detail} ` +
    "A commit-body issue/PR URL is disclosure only and does not satisfy this gate."
  );
}

/** Fail-closed evaluator-definition diff check. */
export function evaluate(options: EvaluateOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? ".");
  let paths: string[];
  if (options.paths !== undefined) {
    paths = [...options.paths];
  } else {
    const collected = collectChangedPaths(projectRoot, {
      baseRef: options.baseRef ?? "origin/master",
      staged: options.staged === true,
    });
    if (!Array.isArray(collected)) {
      return {
        code: 2,
        message: `verify:evaluator-surface: ${collected.error}`,
        stream: "stderr",
      };
    }
    paths = collected;
  }

  const classified = classifyEvaluatorSurfacePaths(paths);
  if (!classified.isEvaluatorSurface) {
    return {
      code: 0,
      message: options.quiet === true ? "" : formatSkipMessage(),
      stream: "stdout",
      skipped: true,
    };
  }

  const disposition = readDisposition(projectRoot, options.dispositionText);
  if (disposition !== null && "error" in disposition) {
    return {
      code: 1,
      message: formatFailMessage(classified.matchedPaths, disposition.error),
      stream: "stderr",
    };
  }
  if (disposition === null) {
    return {
      code: 1,
      message: formatFailMessage(classified.matchedPaths, `Missing ${DISPOSITION_REL}.`),
      stream: "stderr",
    };
  }

  const uncovered = classified.matchedPaths.filter((path) => !dispositionCovers(disposition, path));
  if (uncovered.length > 0) {
    return {
      code: 1,
      message: formatFailMessage(
        classified.matchedPaths,
        `Disposition does not cover: ${uncovered.join(", ")}.`,
      ),
      stream: "stderr",
    };
  }

  return {
    code: 0,
    message: options.quiet === true ? "" : formatPassMessage(classified.matchedPaths, disposition),
    stream: "stdout",
  };
}
