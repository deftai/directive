/**
 * verify:class-checks (#4980 / #3145 class).
 *
 * Fail-closed, diff-scoped class gate independent of file_scope digests and of
 * verify:test-boundary warn mode. Remediation is move or remove the path; a
 * class 1 hit may instead be declared in the base-ref test-boundary policy.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseUnifiedDiffAddedLines } from "../forward-coverage/diff-lines.js";
import { classifyDirectiveOwnedChange } from "../install-health/owned-paths.js";
import { isLifecycleArtifactPath } from "../layout/resolve.js";
import { unquoteGitPath } from "../scope-provenance/evaluate.js";
import {
  CO_LOCATED_TEST_EXTENSIONS,
  CO_LOCATED_TEST_STEMS,
  isCoLocatedTestName,
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
  type ClassChecksPolicy,
  defaultClassChecksPolicy,
  isClassChecksPolicyLoadError,
  loadClassChecksPolicy,
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
  /**
   * Directive wiring files class 4 did not count because their change is not
   * committed (D-026 / #6616). Omitted when there are none.
   */
  readonly notCounted?: readonly string[];
}

export interface ClassCheckOptions {
  readonly baseRef?: string | null;
  readonly changedFiles?: readonly string[];
  readonly fileContents?: ReadonlyMap<string, string>;
  /**
   * Added line numbers (1-based) per path, for injected callers (#7077). Read
   * only when `changedFiles` is injected; injected mode never reads git. A path
   * with no entry is scanned on every line by class 2.
   */
  readonly addedLines?: ReadonlyMap<string, ReadonlySet<number>>;
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

/**
 * Class 1 remediation (#6668): move the path, or declare it in the test-boundary
 * policy read from the base ref. Names only the file when the base ref has one.
 */
function testUnderSourceRootRemediation(baseTb: TestBoundaryPolicy): string {
  const where =
    baseTb.source === "file"
      ? "the base-ref .deft/test-boundary.policy.json"
      : "the base-ref test-boundary policy (.deft/test-boundary.policy.json when the base ref has " +
        "that file, else plan.policy.testBoundary in xbrief/PROJECT-DEFINITION.xbrief.json)";
  return (
    `Move the path under a test root, or declare it in ${where}, preferably as a narrow ` +
    "allow entry with a reason. An authored testRoots list replaces every default root, so " +
    "repeat the defaults you still need. The policy is read from the base ref, so land the " +
    "policy change in an earlier PR. See content/docs/test-boundary.md (#6668)."
  );
}

/**
 * True when a module specifier's last path segment is `<name>.test` or
 * `<name>.spec`, optionally followed by one co-located extension (#6668).
 * No module resolution.
 */
function isCoLocatedTestModuleSpecifier(specifier: string): boolean {
  const lower = (specifier.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  const ext = CO_LOCATED_TEST_EXTENSIONS.find((e) => lower.endsWith(`.${e}`));
  const stem = ext === undefined ? lower : lower.slice(0, -(ext.length + 1));
  return CO_LOCATED_TEST_STEMS.some((s) => stem.endsWith(s) && stem.length > s.length);
}

/**
 * True when a string literal that follows `code` (the line's code so far, with
 * comments removed and earlier strings blanked) sits in a module-specifier
 * position: `import … from`, `export … from`, a continuation `} from`, bare
 * `import "x"`, `import("x")` or `require("x")`.
 */
function isModuleSpecifierPosition(code: string): boolean {
  const before = code.trimEnd();
  const lead = before.trimStart();
  const startsStatement = /^(?:import|export|from)\b/.test(lead) || lead.startsWith("}");
  if (startsStatement && /(?:^|[\s}*])from$/.test(before)) return true;
  if (lead === "import") return true;
  return /(?:^|[^\w$.])(?:import|require)\s*\($/.test(before);
}

/**
 * Module specifiers on one source line (#6668 class 2 import rule). A one-line
 * lexer drops `//` and `/* … *\/` comments and reads each string literal once,
 * so text inside a comment or inside another string is never a specifier, and
 * a comment between `import(` and its path does not hide it. A line that starts
 * with `*` continues a block comment; after a leading `*\/` the rest is code.
 */
function moduleSpecifiersOnLine(rawLine: string): string[] {
  const lead = rawLine.trimStart();
  const line = lead.startsWith("*/") ? lead.slice(2) : rawLine;
  if (!lead.startsWith("*/") && lead.startsWith("*")) return [];
  const out: string[] = [];
  let code = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) break;
      code += " ";
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      if (j >= line.length) break;
      const spec = line.slice(i + 1, j);
      if (spec.length > 0 && isModuleSpecifierPosition(code)) out.push(spec);
      code += '""';
      i = j + 1;
      continue;
    }
    code += ch;
    i += 1;
  }
  return out;
}

const TEST_BOUNDARY_POLICY_PATHS = [
  ".deft/test-boundary.policy.json",
  "xbrief/PROJECT-DEFINITION.xbrief.json",
] as const;

type GitRun =
  | { readonly ok: true; readonly status: number; readonly stdout: string }
  | { readonly ok: false; readonly kind: "not-found" | "spawn-error"; readonly message: string };

function git(args: readonly string[], cwd: string): GitRun {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ok: false, kind: "not-found", message: "'git' executable not found on PATH" };
    }
    return {
      ok: false,
      kind: "spawn-error",
      message: `git ${args[0]} failed: ${String(e.message)}`,
    };
  }
  if (result.signal !== null && result.signal !== undefined) {
    return {
      ok: false,
      kind: "spawn-error",
      message: `git ${args[0]} killed by signal ${String(result.signal)}`,
    };
  }
  return { ok: true, status: result.status ?? 1, stdout: String(result.stdout ?? "") };
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
    const ran = git(["rev-parse", "--verify", "-q", cand], projectRoot);
    if (!ran.ok) {
      if (ran.kind === "not-found") return null;
      continue;
    }
    if (ran.status === 0) return cand;
  }
  return null;
}

type ChangedFilesResult =
  | { readonly ok: true; readonly files: string[]; readonly mergeBase: string }
  | {
      readonly ok: false;
      readonly kind: "not-found" | "not-git" | "git-error";
      readonly message: string;
    };

type CandidateTreeBase =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly kind: "not-found" | "git-error"; readonly message: string };

/**
 * Merge base of `baseRef` and HEAD for the candidate tree (#6336). A missing
 * merge base (shallow clone, unrelated history) falls back to the base ref so
 * the walk still runs; a missing git binary stays a config error.
 */
function candidateTreeBase(projectRoot: string, baseRef: string): CandidateTreeBase {
  const ran = git(["merge-base", baseRef, "HEAD"], projectRoot);
  if (!ran.ok) {
    if (ran.kind === "not-found") return { ok: false, kind: "not-found", message: ran.message };
    return { ok: false, kind: "git-error", message: ran.message };
  }
  const sha = ran.stdout.trim();
  if (ran.status === 0 && sha.length > 0) return { ok: true, sha };
  return { ok: true, sha: baseRef };
}

function changedFilesVsBase(projectRoot: string, baseRef: string): ChangedFilesResult {
  const inside = git(["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (!inside.ok) {
    if (inside.kind === "not-found") {
      return { ok: false, kind: "not-found", message: inside.message };
    }
    return { ok: false, kind: "git-error", message: inside.message };
  }
  if (inside.status !== 0) {
    return { ok: false, kind: "not-git", message: "not a git working tree" };
  }
  let resolved = baseRef;
  if (baseRef === "HEAD" || baseRef === "") {
    const upgraded = resolveClassCheckBaseRef(projectRoot);
    if (upgraded === null) {
      return {
        ok: false,
        kind: "git-error",
        message: "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF)",
      };
    }
    resolved = upgraded;
  }
  const verify = git(["rev-parse", "--verify", "-q", resolved], projectRoot);
  if (!verify.ok) {
    if (verify.kind === "not-found") {
      return { ok: false, kind: "not-found", message: verify.message };
    }
    return { ok: false, kind: "git-error", message: verify.message };
  }
  if (verify.status !== 0) {
    return {
      ok: false,
      kind: "git-error",
      message: `base ref '${resolved}' not found; pass --base-ref`,
    };
  }
  const out = new Set<string>();
  const addPath = (raw: string): void => {
    const t = normalizeRepoRelPath(unquoteGitPath(raw));
    if (t.length > 0) out.add(t);
  };
  // #6336 item 5: one candidate tree — the working tree against the merge base,
  // plus untracked files. A change committed and then reverted in the working
  // tree nets out; base-only commits never enter the set. On a clean committed
  // tip this equals CI's `<base>...HEAD`.
  const mergeBase = candidateTreeBase(projectRoot, resolved);
  if (!mergeBase.ok) {
    return { ok: false, kind: mergeBase.kind, message: mergeBase.message };
  }
  const diff = git(["diff", "--name-only", mergeBase.sha], projectRoot);
  if (!diff.ok) {
    if (diff.kind === "not-found") {
      return { ok: false, kind: "not-found", message: diff.message };
    }
    return { ok: false, kind: "git-error", message: diff.message };
  }
  if (diff.status !== 0) {
    return {
      ok: false,
      kind: "git-error",
      message: `git diff --name-only ${mergeBase.sha} failed (exit ${diff.status})`,
    };
  }
  for (const line of diff.stdout.split("\n")) addPath(line);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], projectRoot);
  if (!untracked.ok) {
    if (untracked.kind === "not-found") {
      return { ok: false, kind: "not-found", message: untracked.message };
    }
    return { ok: false, kind: "git-error", message: untracked.message };
  }
  if (untracked.status !== 0) {
    return {
      ok: false,
      kind: "git-error",
      message: `git ls-files --others --exclude-standard failed (exit ${untracked.status})`,
    };
  }
  for (const line of untracked.stdout.split("\n")) addPath(line);
  return { ok: true, files: [...out], mergeBase: mergeBase.sha };
}

/**
 * Directive wiring globs (D-026 / #6616). A protected path under one of these
 * counts for class 4 only when it is committed, if Directive owns its change.
 * Matches the wiring entries of DEFAULT_PROTECTED_GLOBS; ownership itself comes
 * from classifyDirectiveOwnedChange (#6615), not from this list.
 */
const DIRECTIVE_WIRING_GLOBS = [".githooks/**", ".cursor/hooks.json", ".cursor/hooks/**"] as const;

function isDirectiveWiringCandidate(relPath: string): boolean {
  const posix = normalizeRepoRelPath(relPath);
  return DIRECTIVE_WIRING_GLOBS.some((g) => matchPolicyGlob(posix, g) || matchesRootGlob(posix, g));
}

/** Paths that differ between the merge base and HEAD (committed changes only). */
function committedFilesVsBase(projectRoot: string, mergeBase: string): Set<string> | null {
  const diff = git(["diff", "--name-only", mergeBase, "HEAD"], projectRoot);
  if (!diff.ok || diff.status !== 0) return null;
  const out = new Set<string>();
  for (const line of diff.stdout.split("\n")) {
    const t = normalizeRepoRelPath(unquoteGitPath(line));
    if (t.length > 0) out.add(t);
  }
  return out;
}

function readWorkingTreeFile(projectRoot: string, relPath: string): string | null {
  const full = resolve(projectRoot, relPath);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

/**
 * Directive wiring paths in the change set whose change is not committed
 * (D-026 / #6616): changed only in the working tree or untracked, and the
 * uncommitted change (HEAD to working tree) is Directive's own per
 * classifyDirectiveOwnedChange. A non-Directive file, or a change that also
 * holds non-Directive material, is not returned and keeps the working-tree rule.
 * Returns null when the committed set cannot be read (fail closed: count all).
 */
function uncommittedDirectiveWiring(
  projectRoot: string,
  mergeBase: string,
  protectedHits: readonly string[],
): string[] | null {
  const candidates = protectedHits.filter((p) => isDirectiveWiringCandidate(p));
  if (candidates.length === 0) return [];
  const committed = committedFilesVsBase(projectRoot, mergeBase);
  if (committed === null) return null;
  const out: string[] = [];
  for (const path of candidates) {
    if (committed.has(path)) continue;
    const before = readAtRef(projectRoot, "HEAD", path);
    const after = readWorkingTreeFile(projectRoot, path);
    if (classifyDirectiveOwnedChange(path, before, after) === "directive-only") out.push(path);
  }
  return out;
}

function notCountedLines(paths: readonly string[]): string {
  return paths
    .map(
      (p) =>
        `\n  Not counted: \`${p}\` (uncommitted change to Directive wiring, for example by automatic setup).`,
    )
    .join("");
}

function readAtRef(projectRoot: string, ref: string, relPath: string): string | null {
  const path = normalizeRepoRelPath(relPath);
  const result = git(["show", `${ref}:${path}`], projectRoot);
  if (!result.ok || result.status !== 0) return null;
  return result.stdout;
}

type ParseTbResult =
  | { readonly ok: true; readonly policy: TestBoundaryPolicy }
  | { readonly ok: false; readonly message: string };

function parseTestBoundaryPolicyText(
  text: string,
  source: TestBoundaryPolicy["source"],
): ParseTbResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    return {
      ok: false,
      message: `test-boundary policy is not valid JSON: ${String((err as Error).message ?? err)}`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "test-boundary policy must be a JSON object" };
  }
  const rec = raw as Record<string, unknown>;
  // PROJECT-DEFINITION: drill into plan.policy.testBoundary when present.
  let body = rec;
  if (source === "project-definition" || rec.plan !== undefined) {
    const plan = rec.plan as Record<string, unknown> | undefined;
    const policy = plan?.policy as Record<string, unknown> | undefined;
    const tb = policy?.testBoundary as Record<string, unknown> | undefined;
    if (tb === undefined || tb === null || typeof tb !== "object" || Array.isArray(tb)) {
      return { ok: true, policy: defaultTestBoundaryPolicy("warn") };
    }
    body = tb;
  }
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((s) => s.trim())
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
    ok: true,
    policy: {
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
    },
  };
}

type LoadTbResult =
  | { readonly ok: true; readonly policy: TestBoundaryPolicy }
  | { readonly ok: false; readonly message: string };

function loadBaseTestBoundaryPolicy(projectRoot: string, baseRef: string): LoadTbResult {
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
    ok: true,
    policy: {
      ...defaultTestBoundaryPolicy("warn"),
      allow: [...FRAMEWORK_SELF_ALLOW],
    },
  };
}

type LoadHeadTbResult =
  | { readonly ok: true; readonly policy: TestBoundaryPolicy | null }
  | { readonly ok: false; readonly message: string };

function loadHeadTestBoundaryPolicy(projectRoot: string): LoadHeadTbResult {
  const filePath = resolve(projectRoot, ".deft", "test-boundary.policy.json");
  if (existsSync(filePath)) {
    return parseTestBoundaryPolicyText(readFileSync(filePath, "utf8"), "file");
  }
  const pdPath = resolve(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  if (existsSync(pdPath)) {
    return parseTestBoundaryPolicyText(readFileSync(pdPath, "utf8"), "project-definition");
  }
  return { ok: true, policy: null };
}

export type ParseClassChecksFromProjectDefinitionResult =
  | { readonly ok: true; readonly policy: ClassChecksPolicy | null }
  | { readonly ok: false; readonly message: string };

/**
 * Parse plan.policy.classChecks from PROJECT-DEFINITION text.
 * Malformed JSON / non-object classChecks returns `{ ok: false }` (fail closed).
 * `policy: null` when the document has no classChecks block (caller uses defaults).
 */
export function parseClassChecksFromProjectDefinition(
  pdText: string,
  projectRoot = ".",
): ParseClassChecksFromProjectDefinitionResult {
  let pd: Record<string, unknown>;
  try {
    pd = JSON.parse(pdText) as Record<string, unknown>;
  } catch (err: unknown) {
    return {
      ok: false,
      message:
        "merge-base xbrief/PROJECT-DEFINITION.xbrief.json is not valid JSON: " +
        String((err as Error).message),
    };
  }
  if (pd === null || typeof pd !== "object" || Array.isArray(pd)) {
    return {
      ok: false,
      message: "merge-base xbrief/PROJECT-DEFINITION.xbrief.json must be a JSON object",
    };
  }
  const plan = pd.plan as Record<string, unknown> | undefined;
  const policy = plan?.policy as Record<string, unknown> | undefined;
  const cc = policy?.classChecks;
  if (cc === undefined || cc === null) return { ok: true, policy: null };
  if (typeof cc !== "object" || Array.isArray(cc)) {
    return { ok: false, message: "merge-base plan.policy.classChecks must be a JSON object" };
  }
  const loaded = loadClassChecksPolicy(projectRoot, {
    fileText: JSON.stringify(cc as Record<string, unknown>),
  });
  if (isClassChecksPolicyLoadError(loaded)) {
    return { ok: false, message: loaded.error };
  }
  return { ok: true, policy: loaded };
}

type LoadClassPolicyResult =
  | { readonly ok: true; readonly policy: ClassChecksPolicy }
  | { readonly ok: false; readonly message: string };

function loadBaseClassChecksPolicy(projectRoot: string, baseRef: string): LoadClassPolicyResult {
  const fileText = readAtRef(projectRoot, baseRef, ".deft/class-checks.policy.json");
  if (fileText !== null) {
    const loaded = loadClassChecksPolicy(projectRoot, { fileText });
    if (isClassChecksPolicyLoadError(loaded)) {
      return { ok: false, message: loaded.error };
    }
    return { ok: true, policy: loaded };
  }
  const pdText = readAtRef(projectRoot, baseRef, "xbrief/PROJECT-DEFINITION.xbrief.json");
  if (pdText !== null) {
    const parsed = parseClassChecksFromProjectDefinition(pdText, projectRoot);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    if (parsed.policy !== null) return { ok: true, policy: parsed.policy };
  }
  return { ok: true, policy: defaultClassChecksPolicy() };
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
  // Docs / task / disposition / exact composition-registration paths are
  // landing companions for a verifier-only diff, not story product (#4980
  // item 6). Directory blankets under check / consumer-check-contract /
  // evaluator-surface would let substantive runtime edits bypass class 4.
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
    posix === "packages/core/src/check/gate-lists.ts" ||
    posix === "packages/core/src/check/named-cause.ts" ||
    posix === "packages/core/src/consumer-check-contract/evaluate.ts" ||
    posix === "packages/core/src/evaluator-surface/evaluate.ts" ||
    posix === "packages/runtime/src/dispatch.ts" ||
    posix.endsWith(".test.ts") ||
    posix.endsWith(".test.tsx")
  ) {
    return false;
  }
  if (isUnderAnyRoot(posix, tb.sourceRoots)) return true;
  if (/(^|\/)(infra|deploy|deployment|terraform|bicep|cloudformation)(\/|$)/i.test(posix)) {
    return true;
  }
  // CI harness workflow basenames are gate/infra companions (like tasks/), not
  // story product — tip-dogfood materialize steps in ci.yml must not flip class 4.
  if (isCiHarnessGithubWorkflow(posix)) {
    return false;
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

function isGithubWorkflowPath(relPath: string): boolean {
  return /(^|\/)\.github\/workflows\//i.test(relPath.replace(/\\/g, "/"));
}

/**
 * Explicit CI harness workflow basenames (fail-closed). Unknown workflow names
 * — including release/publish variants — stay under class 2 (#5097).
 */
function isCiHarnessGithubWorkflow(relPath: string): boolean {
  const base = relPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return (
    base === "ci.yml" ||
    base === "ci.yaml" ||
    base === "ci-lane.yml" ||
    base === "ci-lane.yaml" ||
    base === "branch-gate.yml" ||
    base === "branch-gate.yaml" ||
    base.startsWith("greenfield-") ||
    base.startsWith("one-pr-unit")
  );
}

/**
 * Class 2 scans only added lines (#7077). `added` undefined means no added-line
 * data for the path: every line is scanned (fail closed). Lines split on `\n`
 * with one trailing `\r` stripped; no whitespace normalisation.
 */
function scanProductionReferences(
  relPath: string,
  content: string,
  policy: TestBoundaryPolicy,
  added: ReadonlySet<number> | undefined,
): ClassCheckFinding | null {
  if (
    matchesTestFilePattern(relPath, policy.testFilePatterns) ||
    isRecognizedTestBasename(relPath) ||
    isCoLocatedTestName(relPath)
  ) {
    return null;
  }
  if (isUnderAnyRoot(relPath, policy.testRoots) || isUnderAnyRoot(relPath, policy.fixtureRoots)) {
    return null;
  }
  // Only known CI harness workflows may stage fixtures/test roots. Shipping and
  // unknown workflow names remain class-2 fail-closed (#5097).
  if (isGithubWorkflowPath(relPath) && isCiHarnessGithubWorkflow(relPath)) {
    return null;
  }

  const underSource = isUnderAnyRoot(relPath, policy.sourceRoots);
  const looksLikeDeploy =
    /(^|\/)(infra|deploy|deployment|terraform|bicep|cloudformation)(\/|$)/i.test(relPath) ||
    /(^|\/)\.github\/workflows\//i.test(relPath) ||
    /(^|\/)Dockerfile(\.|$)/i.test(relPath) ||
    pathLooksLikePipeline(relPath, [".yml", ".yaml", ".json", ".sh", ".ps1"]);
  if (!underSource && !looksLikeDeploy) {
    return null;
  }

  const scanned: { readonly lineNo: number; readonly text: string }[] = [];
  content.split("\n").forEach((raw, i) => {
    const lineNo = i + 1;
    if (added !== undefined && !added.has(lineNo)) return;
    scanned.push({ lineNo, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
  });
  if (scanned.length === 0) return null;

  const regexes: { readonly needle: string; readonly re: RegExp }[] = [];
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
    for (const re of patterns) regexes.push({ needle, re });
  }
  for (const { lineNo, text } of scanned) {
    for (const { needle, re } of regexes) {
      if (re.test(text)) {
        return {
          path: relPath,
          kind: "production-references-test-root",
          detail: `references test/fixture root '${needle}/' on line ${lineNo} (class 2)`,
          remediation: MOVE_OR_REMOVE,
        };
      }
    }
    // A production file must not import a co-located test module (#6668).
    const spec = moduleSpecifiersOnLine(text).find(isCoLocatedTestModuleSpecifier);
    if (spec !== undefined) {
      return {
        path: relPath,
        kind: "production-references-test-root",
        detail: `imports co-located test module '${spec}' on line ${lineNo} (class 2)`,
        remediation: MOVE_OR_REMOVE,
      };
    }
  }
  return null;
}

/**
 * Added line numbers per path from one `git diff -U0` of the working tree
 * against the merge base (#7077). Any failure returns an empty map, so every
 * path is scanned on every line (fail closed).
 */
function gitAddedLines(
  projectRoot: string,
  mergeBase: string,
  paths: readonly string[],
): ReadonlyMap<string, ReadonlySet<number>> {
  const out = new Map<string, ReadonlySet<number>>();
  if (paths.length === 0) return out;
  const ran = git(
    [
      "diff",
      "-U0",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      mergeBase,
      "--",
      ...paths,
    ],
    projectRoot,
  );
  if (!ran.ok || ran.status !== 0) return out;
  for (const [path, lines] of parseUnifiedDiffAddedLines(ran.stdout)) {
    out.set(normalizeRepoRelPath(path), lines);
  }
  return out;
}

function isBinaryLikePath(posix: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|bin|exe|dll)$/i.test(posix);
}

/**
 * True when a deploy-ish extension is present and 'pipeline' appears in the
 * basename or any path segment (ancestor dirs included). String checks only.
 */
function pathLooksLikePipeline(relPath: string, extensions: readonly string[]): boolean {
  const posix = relPath.replace(/\\/g, "/").toLowerCase();
  if (isLifecycleArtifactPath(posix)) return false;
  const slash = posix.lastIndexOf("/");
  const base = slash >= 0 ? posix.slice(slash + 1) : posix;
  if (!extensions.some((ext) => base.endsWith(ext))) return false;
  return posix.split("/").some((seg) => seg.includes("pipeline"));
}

function looksLikeInfraPath(relPath: string): boolean {
  return (
    /(^|\/)(infra|deploy|deployment|terraform|bicep|cloudformation)(\/|$)/i.test(relPath) ||
    /\.(bicep|tf|tfvars|arm\.json)$/i.test(relPath) ||
    pathLooksLikePipeline(relPath, [".yml", ".yaml", ".json"])
  );
}

/**
 * Class 3: identity/role/principal/credential declaration whose name or bound
 * resource matches a configured test-marker token.
 */

/**
 * Strong content markers that identify a test-only artifact (contract class 1).
 * Requires harness/fixture signals — not bare prose containing "test".
 */
export function contentMarksTestOnly(content: string): boolean {
  const head = content.length > 64_000 ? content.slice(0, 64_000) : content;
  // Vitest/Jest-style suites with assertions.
  if (
    /\b(?:describe|suite)\s*\(/m.test(head) &&
    /\b(?:it|test)\s*\(\s*['"`]/m.test(head) &&
    /\b(?:expect|assert)\s*\(/m.test(head)
  ) {
    return true;
  }
  // Python pytest / unittest.
  if (/\b(?:import\s+pytest|from\s+pytest\b|@pytest\.|from\s+unittest\b)/m.test(head)) {
    return true;
  }
  // Explicit fixture/mock/smoke harness markers.
  if (/\b(?:vi|jest)\.mock\b|\bfixture\s*\(/m.test(head)) return true;
  if (/^\s*(?:\/\/|#)\s*(?:smoke|fixture|mock)[- ]?test\b/im.test(head)) return true;
  return false;
}

export function scanTestIdentityInInfra(
  relPath: string,
  content: string,
  markers: readonly string[],
): ClassCheckFinding | null {
  if (!looksLikeInfraPath(relPath)) return null;
  if (markers.length === 0) return null;
  const markerAlt = markers.map(escapeRegExp).join("|");
  // Marker must sit in a name/id/value binding near an identity keyword — not
  // anywhere in a wide window (tags, comments, adjacent decls, resource labels).
  const declRe = new RegExp(
    `(?:identity|role(?:Definition|Assignment)?|principal|credential|client[_-]?Id|` +
      `user[_-]?assigned|service[_-]?principal|managed[_-]?identity|` +
      `roleName|principalId|identityName)` +
      `[\\s\\S]{0,80}?` +
      `(?:name|id|value|key|clientId|principalId|identityName|roleName)\\s*[:=]\\s*` +
      `["'\`][^"'\`]{0,120}?\\b(?:${markerAlt})\\b[^"'\`]{0,120}?["'\`]`,
    "i",
  );
  // Quoted value must combine a marker token with an identity keyword.
  const resourceRe = new RegExp(
    `["'\`][^"'\`]*\\b(?:${markerAlt})\\b[^"'\`]*(?:identity|role|principal|credential)[^"'\`]*["'\`]` +
      `|["'\`][^"'\`]*(?:identity|role|principal|credential)[^"'\`]*\\b(?:${markerAlt})\\b[^"'\`]*["'\`]`,
    "i",
  );

  if (declRe.test(content) || resourceRe.test(content)) {
    return {
      path: relPath,
      kind: "test-identity-in-infra",
      detail:
        "infrastructure declaration binds a test-marker identity/role/principal/credential (class 3)",
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
  // Merge base of the git-enumerated candidate tree; null when changedFiles is
  // injected (no working tree to compare, so every path counts as today).
  let candidateMergeBase: string | null = null;
  if (options.changedFiles) {
    changed = [...options.changedFiles].map((f) => normalizeRepoRelPath(f));
  } else {
    const changedResult = changedFilesVsBase(root, baseRef);
    if (!changedResult.ok) {
      if (changedResult.kind === "not-found") {
        return configError(
          "verify_class_checks: 'git' executable not found on PATH.\n" +
            "  Recovery: install git or run inside a git working tree.",
        );
      }
      if (changedResult.kind === "not-git") {
        return {
          exitCode: 0,
          findings: [],
          message:
            `verify_class_checks: skipped -- not a git working tree (${changedResult.message}). ` +
            "Initialize git, or inject changedFiles (#4980).",
        };
      }
      const msg = changedResult.message.toLowerCase();
      if (
        msg.includes("not a git repository") ||
        msg.includes("outside repository") ||
        msg.includes("not a git working tree")
      ) {
        return {
          exitCode: 0,
          findings: [],
          message:
            `verify_class_checks: skipped -- not a git working tree (${changedResult.message}). ` +
            "Initialize git, or inject changedFiles (#4980).",
        };
      }
      return configError(
        `verify_class_checks: git failed -- ${changedResult.message}\n` +
          "  Recovery: ensure --project-root points at a healthy git working tree.",
      );
    }
    changed = changedResult.files;
    candidateMergeBase = changedResult.mergeBase;
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
  if (options.baseTestBoundaryPolicy !== undefined) {
    baseTb = options.baseTestBoundaryPolicy;
  } else {
    const loadedTb = loadBaseTestBoundaryPolicy(root, baseRef);
    if (!loadedTb.ok) {
      return configError(
        `verify_class_checks: merge-base test-boundary policy load failed -- ${loadedTb.message}`,
      );
    }
    baseTb = loadedTb.policy;
  }

  let classPolicy: ClassChecksPolicy;
  if (options.classChecksPolicy !== undefined) {
    classPolicy = options.classChecksPolicy;
  } else {
    const loadedCc = loadBaseClassChecksPolicy(root, baseRef);
    if (!loadedCc.ok) {
      return configError(
        `verify_class_checks: merge-base class-checks policy load failed -- ${loadedCc.message}`,
      );
    }
    classPolicy = loadedCc.policy;
  }

  let headTb: TestBoundaryPolicy | null;
  if (options.headTestBoundaryPolicy !== undefined) {
    headTb = options.headTestBoundaryPolicy;
  } else {
    const loadedHead = loadHeadTestBoundaryPolicy(root);
    if (!loadedHead.ok) {
      return configError(
        `verify_class_checks: head test-boundary policy load failed -- ${loadedHead.message}`,
      );
    }
    headTb = loadedHead.policy;
  }

  const findings: ClassCheckFinding[] = [];
  const policyEditPath =
    options.policyEditPath ??
    changed.find((p) => TEST_BOUNDARY_POLICY_PATHS.some((k) => normalizeRepoRelPath(p) === k)) ??
    null;

  // Class 2 added lines (#7077): injected callers supply them; git mode reads
  // one diff against the candidate merge base over the paths class 2 scans.
  let addedLines: ReadonlyMap<string, ReadonlySet<number>>;
  if (options.changedFiles) {
    const injected = new Map<string, ReadonlySet<number>>();
    for (const [path, lines] of options.addedLines ?? []) {
      injected.set(normalizeRepoRelPath(path), lines);
    }
    addedLines = injected;
  } else {
    const class2Paths = changed
      .map((p) => normalizeRepoRelPath(p))
      .filter(
        (p) =>
          !isExempt(p, baseTb.testRoots) &&
          !isBinaryLikePath(p) &&
          !isProtected(p, classPolicy.protectedGlobs) &&
          isAllowListed(p, baseTb.allow) === null,
      );
    addedLines =
      candidateMergeBase === null
        ? new Map()
        : gitAddedLines(root, candidateMergeBase, class2Paths);
  }

  // Class 1 + 2 + 3 over changed files only (diff-scoped).
  for (const rel of changed) {
    const posix = normalizeRepoRelPath(rel);
    if (isExempt(posix, baseTb.testRoots)) continue;

    // Class 1: test artifact under non-test root (name or contents).
    let isTest =
      matchesTestFilePattern(posix, baseTb.testFilePatterns) || isRecognizedTestBasename(posix);
    // A co-located test name (#6668) is never a class 1 finding, by name or by
    // content. It is not a test root: classes 2 to 4 still see the path.
    const class1Candidate =
      isUnderAnyRoot(posix, baseTb.sourceRoots) && !isCoLocatedTestName(posix);
    const protectedPath = isProtected(posix, classPolicy.protectedGlobs);

    // Skip binary-ish for content scans
    if (isBinaryLikePath(posix)) {
      if (isTest && class1Candidate && isAllowListed(posix, baseTb.allow) === null) {
        findings.push({
          path: posix,
          kind: "test-under-source-root",
          detail: "test-only artifact under a non-test root (class 1)",
          remediation: testUnderSourceRootRemediation(baseTb),
        });
      }
      continue;
    }

    const content = readContent(root, posix, options.fileContents);
    if (!isTest && class1Candidate && content !== undefined && contentMarksTestOnly(content)) {
      isTest = true;
    }
    if (isTest && class1Candidate && isAllowListed(posix, baseTb.allow) === null) {
      findings.push({
        path: posix,
        kind: "test-under-source-root",
        detail: "test-only artifact under a non-test root (class 1)",
        remediation: testUnderSourceRootRemediation(baseTb),
      });
    }
    if (content === undefined) continue;

    // Class 2: production reference to test root. Skip protected verifier/authz
    // paths — their source legitimately mentions configured test roots.
    if (!protectedPath && isAllowListed(posix, baseTb.allow) === null) {
      const refFinding = scanProductionReferences(posix, content, baseTb, addedLines.get(posix));
      if (refFinding !== null) findings.push(refFinding);
    }

    // Class 3: test identity in infra.
    const idFinding = scanTestIdentityInInfra(posix, content, classPolicy.testMarkers);
    if (idFinding !== null) findings.push(idFinding);
  }

  // Class 4: protected glob in a story change set (mixed with story product).
  const allProtectedHits = changed
    .map((p) => normalizeRepoRelPath(p))
    .filter((p) => !isExempt(p, baseTb.testRoots) && isProtected(p, classPolicy.protectedGlobs));
  // D-026 / #6616: Directive's own wiring counts only by what is committed.
  // Automatic setup rewrites it in CI before this check; that uncommitted
  // rewrite is not a story edit. If the committed set cannot be read, count all.
  const notCounted =
    candidateMergeBase === null
      ? []
      : (uncommittedDirectiveWiring(root, candidateMergeBase, allProtectedHits) ?? []);
  const notCountedSet = new Set(notCounted);
  const protectedHits = allProtectedHits.filter((p) => !notCountedSet.has(p));
  // CLI authz is a composition companion only when paired with core authz
  // protected paths (#4233 / #4980) — not a blanket story-product exemption.
  const authzProtectedHit = protectedHits.some((p) => p.startsWith("packages/core/src/authz/"));
  // ensureGitHooks SoT companions only when paired with .githooks/ (#4980 Lane A).
  const githooksProtectedHit = protectedHits.some(
    (p) => p === ".githooks" || p.startsWith(".githooks/"),
  );
  // #5994 host-hook deposit companions when paired with Cursor hook protected globs
  // (and/or .githooks/ when the same landing rewrites helper + host outers).
  const hostHookDepositProtectedHit = protectedHits.some(
    (p) => p === ".cursor/hooks.json" || p.startsWith(".cursor/hooks/"),
  );
  const hookDepositCompanionHit = githooksProtectedHit || hostHookDepositProtectedHit;
  const HOOK_DEPOSIT_COMPANIONS: ReadonlySet<string> = new Set([
    "packages/runtime/src/setup-wiring.ts",
    "packages/runtime/src/doctor-diagnose.ts",
    "packages/runtime/src/pre-pr-run.ts",
    "packages/core/src/init-deposit/agent-hooks.ts",
    "packages/core/src/init-deposit/host-hook-outer.ts",
    "packages/core/src/init-deposit/hygiene.ts",
    "packages/core/src/install-health/constants.ts",
    "packages/core/src/install-health/wiring.ts",
    "packages/core/src/coverage-applicability/evaluate.ts",
  ]);
  const storyMix = changed.some((p) => {
    const posix = normalizeRepoRelPath(p);
    if (posix === "packages/cli/src/authz.ts" && authzProtectedHit) return false;
    if (hookDepositCompanionHit && HOOK_DEPOSIT_COMPANIONS.has(posix)) {
      return false;
    }
    return isStoryProductPath(posix, baseTb, classPolicy.protectedGlobs);
  });
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
      (f) => f.kind === "test-under-source-root" || f.kind === "production-references-test-root",
    );
    for (const f of class12) {
      const clearedByHeadAllow = isAllowListed(f.path, headTb.allow) !== null;
      const clearedByBaseAllow = isAllowListed(f.path, baseTb.allow) !== null;
      const warnFlip = baseTb.enforcementMode === "enforce" && headTb.enforcementMode === "warn";
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

  const notCountedText = notCountedLines(notCounted);
  const notCountedField = notCounted.length > 0 ? { notCounted } : {};

  // Never mention scope:record-approved-scope in output.
  if (findings.length === 0) {
    return {
      exitCode: 0,
      findings,
      message: `verify_class_checks: clean (${changed.length} changed file(s) vs ${baseRef}) (#4980).${notCountedText}`,
      ...notCountedField,
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
  const truncated = findings.length > 50 ? `\n  … and ${findings.length - 50} more.` : "";
  const message = `${header}\n${body}${truncated}${notCountedText}`;
  if (/scope:record-approved-scope/i.test(message)) {
    return configError(
      "verify_class_checks: internal error — remediation must not name scope:record-approved-scope",
    );
  }
  return { exitCode: 1, findings, message, ...notCountedField };
}
