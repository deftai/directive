/**
 * verify:test-boundary evaluation (#3145).
 *
 * Rejects recognized test artifacts under production roots and production
 * references to test/fixture roots unless allowlisted or classified as
 * production-liveness. Three-state exit: 0 clean / 1 violation / 2 config.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import { fnmatchCase } from "../encoding/text.js";
import {
  loadTestBoundaryPolicy,
  type TestBoundaryAllowEntry,
  type TestBoundaryPolicy,
} from "./policy.js";

export type TestBoundaryViolationKind =
  | "test-under-source-root"
  | "production-references-test-root";

export interface TestBoundaryFinding {
  readonly path: string;
  readonly kind: TestBoundaryViolationKind;
  readonly detail: string;
  readonly remediation: string;
}

export interface TestBoundaryResult {
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly TestBoundaryFinding[];
  readonly message: string;
  readonly policy: TestBoundaryPolicy | null;
}

export interface TestBoundaryOptions {
  readonly policyPath?: string | null;
  /** Inject policy for pure unit tests (skips disk load). */
  readonly policy?: TestBoundaryPolicy;
  /** Inject file list for pure unit tests. */
  readonly files?: readonly string[];
  /** Inject file contents for reference scanning (posix path -> text). */
  readonly fileContents?: ReadonlyMap<string, string>;
  /** Force enforcement mode override. */
  readonly enforce?: boolean;
  readonly quiet?: boolean;
}

function gitTrackedFiles(projectRoot: string): string[] {
  const result = spawnSync("git", ["ls-files"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    throw new GitCommandError(`git ls-files failed: ${String(e.message)}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new GitCommandError(`git ls-files exited ${result.status ?? 1}`);
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((l) => l.replace(/\r$/, "").replace(/\\/g, "/"))
    .filter((l) => l.trim().length > 0);
}

/** Normalize a root glob like `src/**` or `infra/**` to a path prefix matcher. */
function rootPrefix(rootGlob: string): string {
  return rootGlob.replace(/\/\*\*$/, "/").replace(/\*\*$/, "");
}

/**
 * Glob match with double-star as zero-or-more path segments.
 * Plain fnmatchCase treats double-star as two greedy stars and fails nested
 * colocated paths (e.g. packages/cli/src/foo/bar.test.ts vs packages star globs).
 */
export function matchPolicyGlob(relPath: string, pattern: string): boolean {
  const posix = relPath.replace(/\\/g, "/");
  const g = pattern.replace(/\\/g, "/");
  if (fnmatchCase(posix, g)) return true;
  // Translate ** → «any path including empty», * → «any segment chars»
  let reSrc = "";
  for (let i = 0; i < g.length; ) {
    if (g.startsWith("**/", i)) {
      reSrc += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (g.startsWith("**", i)) {
      reSrc += ".*";
      i += 2;
      continue;
    }
    const c = g.charAt(i);
    i += 1;
    if (c === "*") {
      reSrc += "[^/]*";
    } else if (c === "?") {
      reSrc += "[^/]";
    } else if ("\\.[]{}()+-^$|".includes(c)) {
      reSrc += `\\${c}`;
    } else {
      reSrc += c;
    }
  }
  try {
    return new RegExp(`^${reSrc}$`).test(posix);
  } catch {
    return false;
  }
}

/**
 * Match repo-relative path against a policy root glob.
 * Supports foo/**-style prefixes, packages star-src globs, and basename patterns.
 */
export function matchesRootGlob(relPath: string, rootGlob: string): boolean {
  const posix = relPath.replace(/\\/g, "/");
  const g = rootGlob.replace(/\\/g, "/");
  if (matchPolicyGlob(posix, g)) return true;
  // Prefix form: src/** matches src/foo.py
  if (g.endsWith("/**")) {
    const prefix = g.slice(0, -3);
    if (!prefix.includes("*")) {
      return posix === prefix || posix.startsWith(`${prefix}/`);
    }
    // packages/*/src/** — match prefix with matchPolicyGlob against path or ancestors
    if (matchPolicyGlob(posix, `${prefix}/**`) || matchPolicyGlob(posix, prefix)) {
      return true;
    }
    // Any file under a matching prefix directory
    const parts = posix.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = parts.slice(0, depth).join("/");
      if (matchPolicyGlob(candidate, prefix)) {
        return true;
      }
    }
  }
  if (g.includes("*")) {
    return matchPolicyGlob(posix, g) || matchPolicyGlob(posix, g.endsWith("/**") ? g : `${g}/**`);
  }
  const prefix = rootPrefix(g);
  return posix === prefix.replace(/\/$/, "") || posix.startsWith(prefix);
}

/** True when basename/path matches a test-file pattern (fnmatch / ** globs). */
export function matchesTestFilePattern(relPath: string, patterns: readonly string[]): boolean {
  const posix = relPath.replace(/\\/g, "/");
  const base = basename(posix);
  for (const pat of patterns) {
    const p = pat.replace(/\\/g, "/");
    if (
      matchPolicyGlob(posix, p) ||
      matchPolicyGlob(base, p) ||
      fnmatchCase(base, basename(p)) ||
      fnmatchCase(posix, p)
    ) {
      return true;
    }
  }
  return false;
}

function isUnderAnyRoot(relPath: string, roots: readonly string[]): boolean {
  return roots.some((r) => matchesRootGlob(relPath, r));
}

function isAllowListed(
  relPath: string,
  allow: readonly TestBoundaryAllowEntry[],
): TestBoundaryAllowEntry | null {
  const posix = relPath.replace(/\\/g, "/");
  for (const entry of allow) {
    if (matchPolicyGlob(posix, entry.path) || matchesRootGlob(posix, entry.path)) {
      return entry;
    }
  }
  return null;
}

/** Recognise conventional test basenames without full glob (fast path). */
export function isRecognizedTestBasename(relPath: string): boolean {
  const b = basename(relPath);
  if (/^test_.+\.py$/i.test(b) || /.+_test\.py$/i.test(b)) return true;
  if (/.+Tests?\.cs$/i.test(b)) return true;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(b)) return true;
  if (/.+_test\.go$/i.test(b)) return true;
  return false;
}

function productionReferenceRemediation(): string {
  return (
    "Move the reference under a declared test root, add a narrow allow entry " +
    "with kind production-liveness (health/canary only), or set " +
    "productionMayReferenceTestRoots=true after review. See content/docs/test-boundary.md."
  );
}

function testUnderSourceRemediation(): string {
  return (
    "Move the test artifact under a declared test root (e.g. tests/**), " +
    "or add a reviewed allow entry in plan.policy.testBoundary.allow / " +
    ".deft/test-boundary.policy.json. See content/docs/test-boundary.md (#3145)."
  );
}

function scanProductionReferences(
  relPath: string,
  content: string,
  policy: TestBoundaryPolicy,
): TestBoundaryFinding | null {
  // Only scan non-test production-ish paths
  if (
    matchesTestFilePattern(relPath, policy.testFilePatterns) ||
    isRecognizedTestBasename(relPath)
  ) {
    return null;
  }
  if (isUnderAnyRoot(relPath, policy.testRoots) || isUnderAnyRoot(relPath, policy.fixtureRoots)) {
    return null;
  }
  // Prefer production roots; also scan infra/deploy scripts (path segments only —
  // do not match free-text tokens inside xbrief story slugs).
  const underSource = isUnderAnyRoot(relPath, policy.sourceRoots);
  const looksLikeDeploy =
    /(^|\/)(infra|deploy|deployment|terraform|bicep|cloudformation)(\/|$)/i.test(relPath) ||
    /(^|\/)\.github\/workflows\//i.test(relPath) ||
    /(^|\/)Dockerfile(\.|$)/i.test(relPath) ||
    /(^|\/).*pipeline.*\.(ya?ml|json|sh|ps1)$/i.test(relPath);
  if (!underSource && !looksLikeDeploy) {
    return null;
  }

  const rootsToForbid = [...policy.testRoots, ...policy.fixtureRoots];
  for (const root of rootsToForbid) {
    // Only path-shaped roots (e.g. tests/**, tests/fixtures/**) — skip basename globs
    // like **/*_test.go which are not importable path prefixes.
    if (!root.includes("/") && !root.endsWith("/**")) {
      continue;
    }
    const needle = rootPrefix(root).replace(/\/$/, "");
    // Require at least "tests" length and a path separator in references so bare
    // English "test" / CI job names do not false-positive.
    if (needle.length < 4) continue;
    if (needle === "test" || needle.endsWith("/test")) {
      // Bare test/ is too common in prose; only match test/fixtures-style
      if (!/fixture/i.test(root)) continue;
    }
    // Path-like only: tests/…, "tests/foo", tests\foo — not the word "tests" alone
    const patterns = [
      new RegExp(`(?:^|["'\`\\s=,:(])${escapeRegExp(needle)}/`),
      new RegExp(`(?:^|["'\`\\s=,:(])${escapeRegExp(needle.replace(/\//g, "\\\\"))}\\\\`),
    ];
    for (const re of patterns) {
      if (re.test(content)) {
        return {
          path: relPath,
          kind: "production-references-test-root",
          detail: `references test/fixture root '${needle}/' while productionMayReferenceTestRoots is false`,
          remediation: productionReferenceRemediation(),
        };
      }
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configError(message: string): TestBoundaryResult {
  return { exitCode: 2, findings: [], message, policy: null };
}

/**
 * Evaluate test/source boundary for a project.
 * Pure when `policy` + `files` (+ optional `fileContents`) are injected.
 */
export function evaluateTestBoundary(
  projectRoot: string,
  options: TestBoundaryOptions = {},
): TestBoundaryResult {
  const root = resolve(projectRoot);

  let policy: TestBoundaryPolicy;
  try {
    policy = options.policy ?? loadTestBoundaryPolicy(root, { policyPath: options.policyPath });
  } catch (err: unknown) {
    return configError(
      `verify_test_boundary: policy load failed -- ${String((err as Error).message)}\n` +
        "  Recovery: fix .deft/test-boundary.policy.json or plan.policy.testBoundary, or omit for defaults.",
    );
  }

  if (options.enforce === true) {
    policy = { ...policy, enforcementMode: "enforce" };
  } else if (options.enforce === false) {
    policy = { ...policy, enforcementMode: "warn" };
  }

  let files: string[];
  try {
    files = options.files
      ? [...options.files].map((f) => f.replace(/\\/g, "/"))
      : gitTrackedFiles(root);
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return configError(
        "verify_test_boundary: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      );
    }
    if (err instanceof GitCommandError) {
      // Greenfield / non-git consumer trees (release smoke) must not fail closed
      // on migration defaults — skip clean with guidance (#3145 smoke).
      return {
        exitCode: 0,
        findings: [],
        message:
          `verify_test_boundary: skipped -- not a usable git working tree (${err.message}). ` +
          "Initialize git, or inject files for offline evaluation (#3145).",
        policy,
      };
    }
    throw err;
  }

  const findings: TestBoundaryFinding[] = [];

  for (const rel of files) {
    const allow = isAllowListed(rel, policy.allow);
    if (allow !== null) {
      continue;
    }

    const isTest =
      matchesTestFilePattern(rel, policy.testFilePatterns) || isRecognizedTestBasename(rel);
    if (!isTest) {
      continue;
    }

    // Test files under declared test roots are fine
    if (isUnderAnyRoot(rel, policy.testRoots)) {
      continue;
    }

    // Colocated under source root without test-root classification = violation
    if (isUnderAnyRoot(rel, policy.sourceRoots)) {
      findings.push({
        path: rel,
        kind: "test-under-source-root",
        detail: `test file pattern under production source root`,
        remediation: testUnderSourceRemediation(),
      });
    }
  }

  if (!policy.productionMayReferenceTestRoots) {
    for (const rel of files) {
      if (isAllowListed(rel, policy.allow) !== null) continue;
      // Skip binary-ish extensions
      if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|bin|exe|dll)$/i.test(rel)) {
        continue;
      }
      let content: string | undefined;
      if (options.fileContents !== undefined) {
        content = options.fileContents.get(rel);
      } else {
        const full = resolve(root, rel);
        if (!existsSync(full)) continue;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
      }
      if (content === undefined) continue;
      // Cap scan size
      if (content.length > 512_000) {
        content = content.slice(0, 512_000);
      }
      const finding = scanProductionReferences(rel, content, policy);
      if (finding !== null) {
        findings.push(finding);
      }
    }
  }

  if (findings.length === 0) {
    return {
      exitCode: 0,
      findings,
      policy,
      message:
        `verify_test_boundary: clean (${files.length} file(s), policy source=${policy.source}, ` +
        `mode=${policy.enforcementMode}) (#3145).`,
    };
  }

  const header =
    policy.enforcementMode === "warn"
      ? `verify_test_boundary: WARN ${findings.length} boundary finding(s) (migration/discovery mode; not failing) (#3145).`
      : `verify_test_boundary: ${findings.length} boundary violation(s) (#3145).`;

  // Cap diagnostic body so migration discovery does not flood task check logs.
  const maxShown = policy.enforcementMode === "warn" ? 15 : 50;
  const shown = findings.slice(0, maxShown);
  const body = shown
    .map(
      (f) =>
        `  ${f.path}\n    kind: ${f.kind}\n    detail: ${f.detail}\n    remediation: ${f.remediation}`,
    )
    .join("\n");
  const truncated =
    findings.length > maxShown
      ? `\n  … and ${findings.length - maxShown} more (re-run with authored policy to triage).`
      : "";

  const exitCode: 0 | 1 = policy.enforcementMode === "warn" ? 0 : 1;
  return {
    exitCode,
    findings,
    policy,
    message: `${header}\n${body}${truncated}`,
  };
}
