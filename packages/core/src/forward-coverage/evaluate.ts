/**
 * forward-coverage/evaluate.ts -- deterministic forward-coverage gate
 * (#1310 / #3514).
 *
 * Two halves:
 *  1. Fail-closed new-file existence (#1310): each NEW source file
 *     (`*.py` / `*.go` / `*.ts` / `*.tsx`, excluding tests and `*.d.ts`)
 *     must ship a corresponding test file in the same diff.
 *  2. Warn-first diff coverage (#3514): intersect `coverage-final.json`
 *     with added/modified lines and report uncovered changed branches.
 *     Default threshold is 90% of those branches. That 90% is per-change
 *     coverage of new code; the project vitest floor (75) is a collapse
 *     detector for the aggregate -- they are not interchangeable.
 *
 * Missing coverage reports skip the diff half (existence still runs).
 * Pass `enforceDiffCoverage` / `--enforce` to fail closed on uncovered
 * changed branches. Three-state exit: 0 clean or warn / 1 missing
 * existence (or enforced diff findings) / 2 config error.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import { fnmatchCase } from "../encoding/text.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import {
  type DiffCoverageReport,
  evaluateDiffCoverage,
  hasDiffCoverageFindings,
} from "./diff-coverage.js";
import {
  allLinesChanged,
  type ChangedLineMap,
  countFileLines,
  parseUnifiedDiffAddedLines,
} from "./diff-lines.js";

export {
  DEFAULT_DIFF_COVERAGE_THRESHOLD,
  type DiffCoverageReport,
  type UncoveredChangedBranch,
} from "./diff-coverage.js";

/** Diff scope: `staged` = index vs HEAD; `head` = working tree + index vs HEAD. */
export type ForwardCoverageMode = "head" | "staged";

/** A new source file that has no corresponding test file in the same diff. */
export interface MissingCoverage {
  /** POSIX-form repo-relative path of the uncovered new source file. */
  readonly path: string;
  /** Candidate test-file basenames the gate searched the diff for. */
  readonly expectedTests: string[];
}

/** Result of a forward-coverage evaluation; mirrors the encoding-gate tuple. */
export interface ForwardCoverageResult {
  readonly exitCode: 0 | 1 | 2;
  readonly missing: MissingCoverage[];
  readonly message: string;
  readonly diffCoverage: DiffCoverageReport | null;
}

export interface ForwardCoverageOptions {
  readonly mode?: ForwardCoverageMode;
  readonly allowListPath?: string | null;
  /** Fail closed on uncovered changed branches. Default warn-only. */
  readonly enforceDiffCoverage?: boolean;
  /** Override coverage-final.json path. Default `<root>/coverage/coverage-final.json`. */
  readonly coverageReportPath?: string | null;
  /** Per-diff branch threshold. Default 90 -- not the 75 global floor. */
  readonly diffThreshold?: number;
}

/** Source-file extensions in scope for v1. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".go", ".ts", ".tsx"]);

/** Raised by `loadAllowList` when the path does not exist. */
class AllowListNotFoundError extends Error {}

/** Return the final `.ext` (lowercased) of a path, or "" when none. */
function extOf(pathStr: string): string {
  const b = basename(pathStr);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(dot).toLowerCase() : "";
}

/**
 * True when `relPath` is a test file (excluded from the "needs coverage" set
 * AND counted as available coverage). Covers the co-located TS/TSX
 * `.test` / `.spec` convention, Go `*_test.go`, and Python `test_*.py` /
 * `*_test.py`.
 */
export function isTestFile(relPath: string): boolean {
  const b = basename(relPath).toLowerCase();
  if (
    b.endsWith(".test.ts") ||
    b.endsWith(".test.tsx") ||
    b.endsWith(".spec.ts") ||
    b.endsWith(".spec.tsx")
  ) {
    return true;
  }
  if (b.endsWith("_test.go")) {
    return true;
  }
  if (b.endsWith(".py") && (b.startsWith("test_") || b.endsWith("_test.py"))) {
    return true;
  }
  return false;
}

/** True when `relPath` is an in-scope, non-test, non-`.d.ts` source file. */
export function isSourceFile(relPath: string): boolean {
  const b = basename(relPath).toLowerCase();
  if (b.endsWith(".d.ts")) {
    return false;
  }
  if (!SOURCE_EXTENSIONS.has(extOf(b))) {
    return false;
  }
  return !isTestFile(relPath);
}

/**
 * Candidate test-file basenames that would satisfy forward coverage for a
 * given source file, keyed on its extension + stem. Matched by basename
 * (directory-agnostic) so co-located, `tests/`, and `__tests__/` layouts all
 * count -- keeping the false-positive rate near zero for v1.
 */
export function expectedTestBasenames(sourcePath: string): string[] {
  const b = basename(sourcePath);
  const ext = extOf(b);
  const stem = b.slice(0, b.length - ext.length);
  switch (ext) {
    case ".ts":
      return [`${stem}.test.ts`, `${stem}.spec.ts`];
    case ".tsx":
      return [`${stem}.test.tsx`, `${stem}.spec.tsx`, `${stem}.test.ts`, `${stem}.spec.ts`];
    case ".py":
      return [`test_${stem}.py`, `${stem}_test.py`];
    case ".go":
      return [`${stem}_test.go`];
    default:
      return [];
  }
}

function loadAllowList(path: string | null | undefined): string[] {
  if (path === null || path === undefined) {
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new AllowListNotFoundError(path);
    }
    throw err;
  }
  const out: string[] = [];
  for (const line of raw.split(/\r\n|[\n\r]/)) {
    const stripped = line.trim();
    if (stripped.length === 0 || stripped.startsWith("#")) {
      continue;
    }
    out.push(stripped);
  }
  return out;
}

function isAllowListed(relPath: string, patterns: string[]): boolean {
  return patterns.some((pat) => fnmatchCase(relPath, pat));
}

/** Run `git` and return its status + stdout, mapping ENOENT to GitNotFoundError. */
function git(args: string[], projectRoot: string): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    throw new GitCommandError(`git ${args.join(" ")} failed: ${String(e.message)}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** Run `git`, throwing GitCommandError on any non-zero exit; returns stdout. */
function gitOrThrow(args: string[], projectRoot: string): string {
  const { status, stdout } = git(args, projectRoot);
  if (status !== 0) {
    throw new GitCommandError(`git ${args.join(" ")} exited ${status}`);
  }
  return stdout;
}

function toLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0);
}

/**
 * Enumerate files ADDED in the diff scope, as POSIX-form rel paths.
 *
 * - `staged`: `git diff --cached --diff-filter=A` (index vs HEAD).
 * - `head`: files added vs HEAD (`git diff --diff-filter=A HEAD`) plus
 *   untracked-but-not-ignored files (`git ls-files --others`). When the repo
 *   has no commits yet, every tracked file counts as added.
 */
function addedFiles(projectRoot: string, mode: ForwardCoverageMode): string[] {
  // Confirm we are inside a work tree; a non-repo path raises exit 2 upstream.
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (inside.status !== 0) {
    throw new GitCommandError("not a git working tree");
  }
  if (mode === "staged") {
    return toLines(gitOrThrow(["diff", "--cached", "--name-only", "--diff-filter=A"], projectRoot));
  }
  const added = new Set<string>();
  const hasHead = git(["rev-parse", "--verify", "-q", "HEAD"], projectRoot).status === 0;
  if (hasHead) {
    for (const f of toLines(
      gitOrThrow(["diff", "--name-only", "--diff-filter=A", "HEAD"], projectRoot),
    )) {
      added.add(f);
    }
  } else {
    for (const f of toLines(gitOrThrow(["ls-files"], projectRoot))) {
      added.add(f);
    }
  }
  for (const f of toLines(
    gitOrThrow(["ls-files", "--others", "--exclude-standard"], projectRoot),
  )) {
    added.add(f);
  }
  return [...added];
}

function configError(message: string): ForwardCoverageResult {
  return { exitCode: 2, missing: [], message, diffCoverage: null };
}

function mergeChangedLines(into: ChangedLineMap, from: ChangedLineMap): void {
  for (const [path, lines] of from) {
    const posix = path.replace(/\\/g, "/");
    const set = into.get(posix) ?? new Set<number>();
    for (const n of lines) {
      set.add(n);
    }
    into.set(posix, set);
  }
}

/**
 * Added, modified, and renamed new-file line numbers in the diff scope.
 * Untracked files in head mode count as fully added. Rename-classified
 * edits (`--diff-filter=AMR`) still contribute their added lines.
 */
function changedLinesByFile(projectRoot: string, mode: ForwardCoverageMode): ChangedLineMap {
  const maps: ChangedLineMap = new Map();
  if (mode === "staged") {
    const diff = git(["diff", "--cached", "-U0", "--diff-filter=AMR", "--no-color"], projectRoot);
    if (diff.status === 0) {
      mergeChangedLines(maps, parseUnifiedDiffAddedLines(diff.stdout));
    }
    return maps;
  }
  const hasHead = git(["rev-parse", "--verify", "-q", "HEAD"], projectRoot).status === 0;
  if (hasHead) {
    const diff = git(["diff", "-U0", "--diff-filter=AMR", "--no-color", "HEAD"], projectRoot);
    if (diff.status === 0) {
      mergeChangedLines(maps, parseUnifiedDiffAddedLines(diff.stdout));
    }
  }
  for (const rel of toLines(
    gitOrThrow(["ls-files", "--others", "--exclude-standard"], projectRoot),
  )) {
    const posix = rel.replace(/\\/g, "/");
    let content: string;
    try {
      content = readFileSync(join(projectRoot, posix), "utf8");
    } catch {
      continue;
    }
    const set = maps.get(posix) ?? new Set<number>();
    for (const n of allLinesChanged(countFileLines(content))) {
      set.add(n);
    }
    maps.set(posix, set);
  }
  return maps;
}

function formatDiffCoverage(report: DiffCoverageReport, enforce: boolean): string {
  if (!report.reportPresent) {
    return "";
  }
  const findings = hasDiffCoverageFindings(report);
  if (!findings && report.changedBranchTotal === 0) {
    return "";
  }
  const pct = report.percent.toFixed(2);
  const roles =
    `  The ${report.threshold}% per-diff threshold covers added/modified branches; the 75 global ` +
    "floor is a collapse detector for the aggregate -- they are not interchangeable (#3514 / #3512).";
  if (!findings) {
    return (
      `verify_forward_coverage: diff coverage ${pct}% of ${report.changedBranchTotal} ` +
      `changed branch(es) (threshold ${report.threshold}%).\n${roles}`
    );
  }
  const header =
    `verify_forward_coverage: ${report.uncovered.length} uncovered changed branch(es) ` +
    `(diff ${pct}% vs ${report.threshold}% threshold).\n${roles}`;
  const body = report.uncovered
    .slice(0, 20)
    .map((u) => `  ${u.path}:${u.line} (${u.type} #${u.branchId}[${u.pathIndex}])`)
    .join("\n");
  const more = report.uncovered.length > 20 ? `\n  ... ${report.uncovered.length - 20} more` : "";
  const posture = enforce
    ? "FAIL: --enforce is set; cover the changed branches or raise the tests (#3514)."
    : "ADVISORY (warn-only): exit 0 for the diff half. Pass --enforce to fail closed (#3514). " +
      "New-file existence remains fail-closed.";
  return `${header}\n${body}${more}\n${posture}`;
}

/**
 * Pure evaluation returning `{ exitCode, missing, message }`. Three-state exit
 * (0 clean / 1 missing forward coverage / 2 config error). Mirrors the shape of
 * `encoding.evaluate` (#798) so both gates read the same way.
 */
export function evaluateForwardCoverage(
  projectRoot: string,
  options: ForwardCoverageOptions = {},
): ForwardCoverageResult {
  const mode: ForwardCoverageMode = options.mode ?? "head";
  if (mode !== "head" && mode !== "staged") {
    return configError(
      `verify_forward_coverage: unrecognised mode '${mode}' (expected 'head' or 'staged').`,
    );
  }

  let allowGlobs: string[];
  try {
    allowGlobs = loadAllowList(options.allowListPath);
  } catch (err: unknown) {
    if (err instanceof AllowListNotFoundError) {
      return configError(
        `verify_forward_coverage: --allow-list file not found: ${err.message}\n` +
          "  Recovery: pass an existing path or omit the flag.",
      );
    }
    return configError(
      `verify_forward_coverage: --allow-list unreadable: ${String((err as Error).message)}\n` +
        "  Recovery: check file permissions.",
    );
  }

  let added: string[];
  let changedLines: ChangedLineMap;
  try {
    added = addedFiles(projectRoot, mode);
    changedLines = changedLinesByFile(projectRoot, mode);
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return configError(
        "verify_forward_coverage: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      );
    }
    if (err instanceof GitCommandError) {
      return configError(
        `verify_forward_coverage: git failed -- ${err.message}\n` +
          "  Recovery: ensure --project-root points at a git working tree.",
      );
    }
    throw err;
  }

  const posixAdded = added.map((p) => p.replace(/\\/g, "/"));
  const testBasenames = new Set<string>(
    posixAdded.filter((p) => isTestFile(p)).map((p) => basename(p)),
  );

  const missing: MissingCoverage[] = [];
  let checked = 0;
  for (const rel of posixAdded) {
    if (!isSourceFile(rel)) {
      continue;
    }
    if (isAllowListed(rel, allowGlobs)) {
      continue;
    }
    checked += 1;
    const expected = expectedTestBasenames(rel);
    const covered = expected.some((name) => testBasenames.has(name));
    if (!covered) {
      missing.push({ path: rel, expectedTests: expected });
    }
  }

  const sourceChanged: ChangedLineMap = new Map();
  for (const [rel, lines] of changedLines) {
    if (!isSourceFile(rel) || isAllowListed(rel, allowGlobs)) {
      continue;
    }
    sourceChanged.set(rel, lines);
  }

  const coverageReportPath =
    options.coverageReportPath ?? join(projectRoot, "coverage", "coverage-final.json");
  const enforce = options.enforceDiffCoverage === true;
  const diffCoverage = evaluateDiffCoverage({
    projectRoot,
    coverageReportPath,
    changedLinesByFile: sourceChanged,
    threshold: options.diffThreshold,
  });
  const diffSection = formatDiffCoverage(diffCoverage, enforce);

  if (missing.length > 0) {
    const header =
      `verify_forward_coverage: ${missing.length} new source file(s) added without a ` +
      "corresponding test in the same diff (#1310).\n" +
      "  Rule: a new source file MUST ship with a test in the SAME diff -- running existing\n" +
      "  tests alone does not satisfy forward coverage. Add a co-located test (e.g. <name>.test.ts,\n" +
      "  <name>_test.go, test_<name>.py) or allow-list a documented exception via --allow-list <path>.";
    const body = missing
      .map((m) => `  ${m.path}\n    expected one of: ${m.expectedTests.join(", ")}`)
      .join("\n");
    const message =
      diffSection === "" ? `${header}\n${body}` : `${header}\n${body}\n${diffSection}`;
    return { exitCode: 1, missing, message, diffCoverage };
  }

  const existence =
    `verify_forward_coverage: ${checked} new source file(s) checked -- ` +
    "all have forward coverage in the diff (#1310).";
  const findings = hasDiffCoverageFindings(diffCoverage);
  const exitCode: 0 | 1 = enforce && findings ? 1 : 0;
  const message = diffSection === "" ? existence : `${existence}\n${diffSection}`;
  return { exitCode, missing, message, diffCoverage };
}
