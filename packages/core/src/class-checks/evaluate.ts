/**
 * verify:class-checks (#4980 / #3145 class).
 *
 * Fail-closed, diff-scoped class gate independent of file_scope digests and of
 * verify:test-boundary warn mode. Remediation is move or remove the path.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GitCommandError, GitNotFoundError } from "../encoding/git.js";
import {
  isRecognizedTestBasename,
  matchesRootGlob,
  matchesTestFilePattern,
  matchPolicyGlob,
} from "../test-boundary/evaluate.js";
import {
  defaultTestBoundaryPolicy,
  FRAMEWORK_SELF_ALLOW,
  type TestBoundaryAllowEntry,
  type TestBoundaryPolicy,
} from "../test-boundary/policy.js";
import {
  defaultClassChecksPolicy,
  loadClassChecksPolicy,
  type ClassChecksPolicy,
} from "./policy.js";

export type ClassCheckKind =
  | "test-under-source-root"
  | "production-references-test-root"
  | "test-identity-in-infra"
  | "protected-glob"
  | "same-pr-policy-edit";

export interface ClassCheckFinding {
  readonly path: string;
  readonly kind: ClassCheckKind;
  readonly detail: string;
  readonly remediation: string;
}

export interface ClassCheckResult {
  readonly exitCode: 0 | 1 | 2;
  readonly findings: readonly ClassCheckFinding[];
  readonly message: string;
}

export interface ClassCheckOptions {
  readonly baseRef?: string | null;
  readonly changedFiles?: readonly string[];
  readonly fileContents?: ReadonlyMap<string, string>;
  /** Merge-base test-boundary policy (allow / roots). */
  readonly baseTestBoundaryPolicy?: TestBoundaryPolicy;
  /** Working-tree test-boundary policy (same-PR edit detection). */
  readonly headTestBoundaryPolicy?: TestBoundaryPolicy | null;
  readonly classChecksPolicy?: ClassChecksPolicy;
  /** Path of a same-PR test-boundary policy edit, when present. */
  readonly policyEditPath?: string | null;
  readonly quiet?: boolean;
}

const MOVE_OR_REMOVE = "Move or remove the path. Class checks have no approve, skip, or phrase.";

const TEST_BOUNDARY_POLICY_PATHS = [
  ".deft/test-boundary.policy.json",
  "xbrief/PROJECT-DEFINITION.xbrief.json",
] as const;

function git(args: readonly string[], cwd: string): { status: number; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new GitNotFoundError("'git' executable not found on PATH");
    }
    throw new GitCommandError(`git ${args[0]} failed: ${String(e.message)}`);
  }
  return { status: result.status ?? 1, stdout: String(result.stdout ?? "") };
}

function unquoteGitPath(raw: string): string {
  const t = raw.replace(/\r$/, "").trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\/g, "/");
  }
  return t.replace(/\\/g, "/");
}

function normalizeRepoRelPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

/** Resolve PR-aware base ref (origin/master|main, DEFT_BASE_REF, GITHUB_BASE_REF). */
export function resolveClassCheckBaseRef(projectRoot: string): string | null {
  const envCandidates = [
    process.env.DEFT_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  for (const cand of [...envCandidates, "origin/master", "origin/main", "master", "main"]) {
    if (git(["rev-parse", "--verify", "-q", cand], projectRoot).status === 0) {
      return cand;
    }
  }
  return null;
}

function changedFilesVsBase(projectRoot: string, baseRef: string): string[] {
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (inside.status !== 0) {
    throw new GitCommandError("not a git working tree");
  }
  let resolved = baseRef;
  if (baseRef === "HEAD" || baseRef === "") {
    const upgraded = resolveClassCheckBaseRef(projectRoot);
    if (upgraded === null) {
      throw new GitCommandError(
        "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF)",
      );
    }
    resolved = upgraded;
  }
  if (git(["rev-parse", "--verify", "-q", resolved], projectRoot).status !== 0) {
    throw new GitCommandError(`base ref '${resolved}' not found; pass --base-ref`);
  }
  const out = new Set<string>();
  const addPath = (raw: string): void => {
    const t = normalizeRepoRelPath(unquoteGitPath(raw));
    if (t.length > 0) out.add(t);
  };
  const range = `${resolved}...HEAD`;
  const diff = git(["diff", "--name-only", range], projectRoot);
  if (diff.status === 0) {
    for (const line of diff.stdout.split("\n")) addPath(line);
  }
  const vsHead = git(["diff", "--name-only", "HEAD"], projectRoot);
  if (vsHead.status === 0) {
    for (const line of vsHead.stdout.split("\n")) addPath(line);
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (untracked.status === 0) {
    for (const line of untracked.stdout.split("\n")) addPath(line);
  }
  return [...out];
}

function readAtRef(projectRoot: string, ref: string, relPath: string): string | null {
  const path = normalizeRepoRelPath(relPath);
  const result = git(["show", `${ref}:${path}`], projectRoot);
  if (result.status !== 0) return null;
  return result.stdout;
}

function parseTestBoundaryPolicyText(
  text: string,
  source: TestBoundaryPolicy["source"],
): TestBoundaryPolicy {
  const raw = JSON.parse(text) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("test-boundary policy must be a JSON object");
  }
  const rec = raw as Record<string, unknown>;
  // PROJECT-DEFINITION: drill into plan.policy.testBoundary when present.
  let body = rec;
  if (source === "project-definition" || rec.plan !== undefined) {
    const plan = rec.plan as Record<string, unknown> | undefined;
    const policy = plan?.policy as Record<string, unknown> | undefined;
    const tb = policy?.testBoundary as Record<string, unknown> | undefined;
    if (tb === undefined || tb === null || typeof tb !== "object" || Array.isArray(tb)) {
      return defaultTestBoundaryPolicy("warn");
    }
    body = tb;
  }
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
      : [];
  const asAllow = (v: unknown): TestBoundaryAllowEntry[] => {
    if (!Array.isArray(v)) return [];
    const out: TestBoundaryAllowEntry[] = [];
    for (const item of v) {
      if (typeof item === "string" && item.trim().length > 0) {
        out.push({ path: item.trim(), kind: "exception" });
        continue;
      }
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const r = item as Record<string, unknown>;
        const path = typeof r.path === "string" ? r.path.trim() : "";
        if (path.length === 0) continue;
        const kind =
          r.kind === "production-liveness" || r.kind === "exception" ? r.kind : "exception";
        const reason = typeof r.reason === "string" ? r.reason : undefined;
        out.push({ path, kind, reason });
      }
    }
    return out;
  };
  const defaults = defaultTestBoundaryPolicy("warn");
  const sourceRoots = asStringArray(body.sourceRoots);
  const testRoots = asStringArray(body.testRoots);
  const fixtureRoots = asStringArray(body.fixtureRoots);
  const testFilePatterns = asStringArray(body.testFilePatterns);
  let enforcementMode: "warn" | "enforce" = "enforce";
  if (body.enforcementMode === "warn" || body.enforcementMode === "enforce") {
    enforcementMode = body.enforcementMode;
  }
  return {
    sourceRoots: sourceRoots.length > 0 ? sourceRoots : defaults.sourceRoots,
    testRoots: testRoots.length > 0 ? testRoots : defaults.testRoots,
    fixtureRoots: fixtureRoots.length > 0 ? fixtureRoots : defaults.fixtureRoots,
    testFilePatterns: testFilePatterns.length > 0 ? testFilePatterns : defaults.testFilePatterns,
    productionMayReferenceTestRoots:
      typeof body.productionMayReferenceTestRoots === "boolean"
        ? body.productionMayReferenceTestRoots
        : false,
    allow: asAllow(body.allow),
    enforcementMode,
    source: source === "project-definition" ? "project-definition" : "file",
  };
}

function loadBaseTestBoundaryPolicy(projectRoot: string, baseRef: string): TestBoundaryPolicy {
  const fileText = readAtRef(projectRoot, baseRef, ".deft/test-boundary.policy.json");
  if (fileText !== null) {
    return parseTestBoundaryPolicyText(fileText, "file");
  }
  const pdText = readAtRef(projectRoot, baseRef, "xbrief/PROJECT-DEFINITION.xbrief.json");
  if (pdText !== null) {
    return parseTestBoundaryPolicyText(pdText, "project-definition");
  }
  // Defaults + framework self-allow (same as verify:test-boundary migration defaults).
  return {
    ...defaultTestBoundaryPolicy("warn"),
    allow: [...FRAMEWORK_SELF_ALLOW],
  };
}

function loadHeadTestBoundaryPolicy(projectRoot: string): TestBoundaryPolicy | null {
  const filePath = resolve(projectRoot, ".deft", "test-boundary.policy.json");
  if (existsSync(filePath)) {
    return parseTestBoundaryPolicyText(readFileSync(filePath, "utf8"), "file");
  }
  const pdPath = resolve(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  if (existsSync(pdPath)) {
    return parseTestBoundaryPolicyText(readFileSync(pdPath, "utf8"), "project-definition");
  }
  return null;
}

function loadBaseClassChecksPolicy(projectRoot: string, baseRef: string): ClassChecksPolicy {
  const fileText = readAtRef(projectRoot, baseRef, ".deft/class-checks.policy.json");
  if (fileText !== null) {
    return loadClassChecksPolicy(projectRoot, { fileText });
  }
  const pdText = readAtRef(projectRoot, baseRef, "xbrief/PROJECT-DEFINITION.xbrief.json");
  if (pdText !== null) {
    try {
      const pd = JSON.parse(pdText) as Record<string, unknown>;
      const plan = pd.plan as Record<string, unknown> | undefined;
      const policy = plan?.policy as Record<string, unknown> | undefined;
      const cc = policy?.classChecks as Record<string, unknown> | undefined;
      if (cc !== undefined && cc !== null && typeof cc === "object" && !Array.isArray(cc)) {
        return loadClassChecksPolicy(projectRoot, { fileText: JSON.stringify(cc) });
      }
    } catch {
      // defaults
    }
  }
  return defaultClassChecksPolicy();
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

function isUnderAnyRoot(relPath: string, roots: readonly string[]): boolean {
  return roots.some((r) => matchesRootGlob(relPath, r));
}

function isExempt(relPath: string, testRoots: readonly string[]): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (posix === "CHANGELOG.md") return true;
  return isUnderAnyRoot(posix, testRoots);
}

function isProtected(relPath: string, globs: readonly string[]): boolean {
  const posix = normalizeRepoRelPath(relPath);
  return globs.some((g) => matchPolicyGlob(posix, g) || matchesRootGlob(posix, g));
}

/** Story-product path: non-exempt, non-protected, under a production/source root. */
function isStoryProductPath(
  relPath: string,
  tb: TestBoundaryPolicy,
  protectedGlobs: readonly string[],
): boolean {
  const posix = normalizeRepoRelPath(relPath);
  if (isExempt(posix, tb.testRoots)) return false;
  if (isProtected(posix, protectedGlobs)) return false;
  // Docs / task / disposition / check-composition wiring are landing companions
  // for a verifier-only diff, not story product (#4980 item 6).
  if (
    posix.startsWith("docs/") ||
    posix.startsWith("content/docs/") ||
    posix.startsWith("content/") ||
    posix.startsWith("tasks/") ||
    posix === "Taskfile.yml" ||
    posix === "xbrief/evaluator-surface-disposition.json" ||
    posix.startsWith("xbrief/") ||
    posix === "packages/core/src/index.ts" ||
    posix === "packages/core/package.json" ||
    posix === "packages/cli/package.json" ||
    posix.startsWith("packages/core/src/check/") ||
    posix.startsWith("packages/core/src/consumer-check-contract/") ||
    posix.startsWith("packages/core/src/evaluator-surface/") ||
    posix === "packages/cli/src/dispatch.ts" ||
    posix.endsWith(".test.ts") ||
    posix.endsWith(".test.tsx")
  ) {
    return false;
  }
  if (isUnderAnyRoot(posix, tb.sourceRoots)) return true;
  if (/(^|\/)(infra|deploy|deployment|terraform|bicep|cloudformation)(\/|$)/i.test(posix)) {
    return true;
  }
  if (/(^|\/)\.github\/workflows\//i.test(posix) && !isProtected(posix, protectedGlobs)) {
    return true;
  }
  return false;
}

function rootPrefix(rootGlob: string): string {
  return rootGlob.replace(/\/\*\*$/, "/").replace(/\*\*$/, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanProductionReferences(
  relPath: string,
  content: string,
  policy: TestBoundaryPolicy,
): ClassCheckFinding | null {
  if (
    matchesTestFilePattern(relPath, policy.testFilePatterns) ||
    isRecognizedTestBasename(relPath)
  ) {
    return null;
  }
  if (isUnderAnyRoot(relPath, policy.testRoots) || isUnderAnyRoot(relPath, policy.fixtureRoots)) {
    return null;
  }
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
    if (!root.includes("/") && !root.endsWith("/**")) continue;
    const needle = rootPrefix(root).replace(/\/$/, "");
    if (needle.length < 4) continue;
    if (needle === "test" || needle.endsWith("/test")) {
      if (!/fixture/i.test(root)) continue;
    }
    const patterns = [
      new RegExp(`(?:^|["'\`\\s=,:(])${escapeRegExp(needle)}/`),
      new RegExp(`(?:^|["'\`\\s=,:(])${escapeRegExp(needle.replace(/\//g, "\\\\"))}\\\\`),
    ];
    for (const re of patterns) {
      if (re.test(content)) {
        return {
          path: relPath,
          kind: "production-references-test-root",
          detail: `references test/fixture root '${needle}/' (class 2)`,
          remediation: MOVE_OR_REMOVE,
        };
      }
    }
  }
  return null;
}

function looksLikeInfraPath(relPath: string): boolean {
  return (
    /(^|\/)(infra|deploy|deployment|terraform|bicep|cloudformation)(\/|$)/i.test(relPath) ||
    /\.(bicep|tf|tfvars|arm\.json)$/i.test(relPath) ||
    /(^|\/).*pipeline.*\.(ya?ml|json)$/i.test(relPath)
  );
}

/**
 * Class 3: identity/role/principal/credential declaration whose name or bound
 * resource matches a configured test-marker token.
 */
export function scanTestIdentityInInfra(
  relPath: string,
  content: string,
  markers: readonly string[],
): ClassCheckFinding | null {
  if (!looksLikeInfraPath(relPath)) return null;
  if (markers.length === 0) return null;
  const markerAlt = markers.map(escapeRegExp).join("|");
  // Require an identity/role/principal/credential keyword near a marker token.
  const declRe = new RegExp(
    `(?:identity|role(?:Definition|Assignment)?|principal|credential|client[_-]?Id|` +
      `user[_-]?assigned|service[_-]?principal|managed[_-]?identity|` +
      `roleName|principalId|identityName)` +
      `[\\s\\S]{0,160}?(?:${markerAlt})`,
    "i",
  );
  const nameRe = new RegExp(
    `(?:name|id|value)\\s*[=:]\\s*["'\`][^"'\`]*(?:${markerAlt})[^"'\`]*["'\`]`,
    "i",
  );
  const resourceRe = new RegExp(
    `["'\`][^"'\`]*(?:${markerAlt})[^"'\`]*(?:identity|role|principal|credential)[^"'\`]*["'\`]`,
    "i",
  );
  if (declRe.test(content) || nameRe.test(content) || resourceRe.test(content)) {
    return {
      path: relPath,
      kind: "test-identity-in-infra",
      detail: "infrastructure declaration binds a test-marker identity/role/principal/credential (class 3)",
      remediation: MOVE_OR_REMOVE,
    };
  }
  return null;
}

function readContent(
  projectRoot: string,
  rel: string,
  injected?: ReadonlyMap<string, string>,
): string | undefined {
  if (injected !== undefined) {
    return injected.get(rel);
  }
  const full = resolve(projectRoot, rel);
  if (!existsSync(full)) return undefined;
  try {
    let content = readFileSync(full, "utf8");
    if (content.length > 512_000) content = content.slice(0, 512_000);
    return content;
  } catch {
    return undefined;
  }
}

function configError(message: string): ClassCheckResult {
  return { exitCode: 2, findings: [], message };
}

/**
 * Evaluate fail-closed class checks on the change set vs merge base.
 * Pure when changedFiles + policies + fileContents are injected.
 */
export function evaluateClassChecks(
  projectRoot: string,
  options: ClassCheckOptions = {},
): ClassCheckResult {
  const root = resolve(projectRoot);

  let baseRef = options.baseRef ?? null;
  if (baseRef === null || baseRef === undefined || baseRef === "") {
    baseRef = resolveClassCheckBaseRef(root);
  }
  if (baseRef === null) {
    return configError(
      "verify_class_checks: no merge-base ref found (origin/master|main or DEFT_BASE_REF).\n" +
        "  Recovery: pass --base-ref or fetch the default branch.",
    );
  }

  let changed: string[];
  try {
    changed = options.changedFiles
      ? [...options.changedFiles].map((f) => normalizeRepoRelPath(f))
      : changedFilesVsBase(root, baseRef);
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return configError(
        "verify_class_checks: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      );
    }
    if (err instanceof GitCommandError) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("not a git repository") ||
        msg.includes("outside repository") ||
        msg.includes("not a git working tree")
      ) {
        return {
          exitCode: 0,
          findings: [],
          message:
            `verify_class_checks: skipped -- not a git working tree (${err.message}). ` +
            "Initialize git, or inject changedFiles (#4980).",
        };
      }
      return configError(
        `verify_class_checks: git failed -- ${err.message}\n` +
          "  Recovery: ensure --project-root points at a healthy git working tree.",
      );
    }
    throw err;
  }

  // Empty change set: clean.
  if (changed.length === 0) {
    return {
      exitCode: 0,
      findings: [],
      message: `verify_class_checks: clean (0 changed file(s) vs ${baseRef}) (#4980).`,
    };
  }

  let baseTb: TestBoundaryPolicy;
  try {
    baseTb = options.baseTestBoundaryPolicy ?? loadBaseTestBoundaryPolicy(root, baseRef);
  } catch (err: unknown) {
    return configError(
      `verify_class_checks: merge-base test-boundary policy load failed -- ${String((err as Error).message)}`,
    );
  }

  let classPolicy: ClassChecksPolicy;
  try {
    classPolicy = options.classChecksPolicy ?? loadBaseClassChecksPolicy(root, baseRef);
  } catch (err: unknown) {
    return configError(
      `verify_class_checks: merge-base class-checks policy load failed -- ${String((err as Error).message)}`,
    );
  }

  const headTb =
    options.headTestBoundaryPolicy !== undefined
      ? options.headTestBoundaryPolicy
      : loadHeadTestBoundaryPolicy(root);

  const findings: ClassCheckFinding[] = [];
  const policyEditPath =
    options.policyEditPath ??
    changed.find((p) =>
      TEST_BOUNDARY_POLICY_PATHS.some((k) => normalizeRepoRelPath(p) === k),
    ) ??
    null;

  // Class 1 + 2 + 3 over changed files only (diff-scoped).
  for (const rel of changed) {
    const posix = normalizeRepoRelPath(rel);
    if (isExempt(posix, baseTb.testRoots)) continue;

    // Class 1: test artifact under non-test root.
    const isTest =
      matchesTestFilePattern(posix, baseTb.testFilePatterns) || isRecognizedTestBasename(posix);
    if (isTest && isUnderAnyRoot(posix, baseTb.sourceRoots)) {
      if (isAllowListed(posix, baseTb.allow) === null) {
        findings.push({
          path: posix,
          kind: "test-under-source-root",
          detail: "test-only artifact under a non-test root (class 1)",
          remediation: MOVE_OR_REMOVE,
        });
      }
    }

    // Skip binary-ish for content scans
    if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|bin|exe|dll)$/i.test(posix)) {
      continue;
    }

    const content = readContent(root, posix, options.fileContents);
    if (content === undefined) continue;

    // Class 2: production reference to test root (always; ignore productionMayReference).
    if (isAllowListed(posix, baseTb.allow) === null) {
      const refFinding = scanProductionReferences(posix, content, baseTb);
      if (refFinding !== null) findings.push(refFinding);
    }

    // Class 3: test identity in infra.
    const idFinding = scanTestIdentityInInfra(posix, content, classPolicy.testMarkers);
    if (idFinding !== null) findings.push(idFinding);
  }

  // Class 4: protected glob in a story change set (mixed with story product).
  const protectedHits = changed
    .map((p) => normalizeRepoRelPath(p))
    .filter((p) => !isExempt(p, baseTb.testRoots) && isProtected(p, classPolicy.protectedGlobs));
  const storyMix = changed.some((p) =>
    isStoryProductPath(normalizeRepoRelPath(p), baseTb, classPolicy.protectedGlobs),
  );
  if (protectedHits.length > 0 && storyMix) {
    for (const path of protectedHits) {
      findings.push({
        path,
        kind: "protected-glob",
        detail: "protected path touched by a story change set (class 4)",
        remediation: MOVE_OR_REMOVE,
      });
    }
  } else if (protectedHits.length > 0 && !storyMix) {
    // Pure protected (+ exempt/docs/wiring) landing — allowed as its own diff.
  }

  // Same-PR allow / warn flip that would clear a class-1/2 hit.
  if (policyEditPath !== null && headTb !== null && findings.length > 0) {
    const class12 = findings.filter(
      (f) =>
        f.kind === "test-under-source-root" || f.kind === "production-references-test-root",
    );
    for (const f of class12) {
      const clearedByHeadAllow = isAllowListed(f.path, headTb.allow) !== null;
      const clearedByBaseAllow = isAllowListed(f.path, baseTb.allow) !== null;
      const warnFlip =
        baseTb.enforcementMode === "enforce" && headTb.enforcementMode === "warn";
      if ((clearedByHeadAllow && !clearedByBaseAllow) || warnFlip) {
        findings.push({
          path: normalizeRepoRelPath(policyEditPath),
          kind: "same-pr-policy-edit",
          detail:
            warnFlip && !(clearedByHeadAllow && !clearedByBaseAllow)
              ? `same-PR enforcementMode warn flip would soften boundary for ${f.path}`
              : `same-PR allow entry would clear class finding for ${f.path}`,
          remediation: MOVE_OR_REMOVE,
        });
        break;
      }
    }
  }

  // Never mention scope:record-approved-scope in output.
  if (findings.length === 0) {
    return {
      exitCode: 0,
      findings,
      message:
        `verify_class_checks: clean (${changed.length} changed file(s) vs ${baseRef}) (#4980).`,
    };
  }

  const header = `verify_class_checks: ${findings.length} class violation(s) (#4980).`;
  const body = findings
    .slice(0, 50)
    .map(
      (f) =>
        `  ${f.path}\n    kind: ${f.kind}\n    detail: ${f.detail}\n    remediation: ${f.remediation}`,
    )
    .join("\n");
  const truncated =
    findings.length > 50 ? `\n  … and ${findings.length - 50} more.` : "";
  const message = `${header}\n${body}${truncated}`;
  if (/scope:record-approved-scope/i.test(message)) {
    return configError(
      "verify_class_checks: internal error — remediation must not name scope:record-approved-scope",
    );
  }
  return { exitCode: 1, findings, message };
}
