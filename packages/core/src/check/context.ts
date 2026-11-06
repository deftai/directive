import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface CheckOrchestratorOptions {
  readonly noCache?: boolean;
  readonly useTaskCache?: boolean;
}

export interface CheckOrchestratorSeams extends CheckOrchestratorOptions {
  /** Override the `task` binary path (default: "task"). */
  readonly taskBin?: string;
  /** Override the spawnSync implementation for unit testing. */
  readonly spawnFn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; stdio: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error };
  /** Child-process environment (default: process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock spawn timeout in milliseconds (default: none). */
  readonly timeoutMs?: number;
  /**
   * Gate-outcome collector (#4230). Cached orchestrator forwards outcomes
   * without changing `dispatchTaskCheck`'s number return.
   */
  readonly onCheckComplete?: (completion: CachedCheckCompletion) => void;
  /** #6072: skip sanctioned-skip baseline gate (tests). */
  readonly skipSanctionedSkipBaseline?: boolean;
  /** #6072: pre-pr vs merge-readiness phase for baseline ratchet. */
  readonly sanctionedSkipBaselinePhase?: "pre-pr" | "merge-readiness";
  /** #6072: shape-(B) authorization from #6071. */
  readonly sanctionedSkipShapeB?: {
    readonly admitted: boolean;
    readonly authorizedNetNew: number;
  };
  /** #6072: merge-base / target baseline count override. */
  readonly sanctionedSkipTargetBaselineCount?: number;
  /** #6072: injected #6071 inventory rows (tests / callers). */
  readonly sanctionedSkipInventoryRows?: readonly {
    readonly path: string;
    readonly title: string;
    readonly issueNumber: number | null;
    readonly citationShape: "cited" | "uncited" | "malformed";
  }[];
}

/** Completion snapshot forwarded to release Step 5 (suite-ran vs skip). */
export interface CachedCheckCompletion {
  readonly exitCode: number;
  readonly gates: readonly import("../run-summary/types.js").CheckGateOutcome[];
  readonly suiteTeeText: string;
}

/** True when `path` is the directive framework source checkout root. */
export function isFrameworkRepoRoot(path: string): boolean {
  const root = resolve(path);
  return (
    existsSync(join(root, "packages", "cli", "package.json")) &&
    existsSync(join(root, "biome.json")) &&
    existsSync(join(root, "Taskfile.yml"))
  );
}

/** Return true when running in the framework's own source checkout (#1519). */
export function isFrameworkSourceContext(frameworkRoot: string, projectRoot: string): boolean {
  const fw = resolve(frameworkRoot);
  const pr = resolve(projectRoot);
  if (fw === pr) {
    return true;
  }
  if (!isFrameworkRepoRoot(fw)) {
    return false;
  }
  return pr.startsWith(`${fw}${sep}`);
}

/** Select the Taskfile target for the given context. */
export function resolveCheckTarget(frameworkRoot: string, projectRoot: string): string {
  return isFrameworkSourceContext(frameworkRoot, projectRoot)
    ? "check:framework-source"
    : "check:consumer";
}

// ---------------------------------------------------------------------------
// Sanctioned skip-count baseline ratchet (#6072 Prefer-A Bound Recut-3)
// Lives beside the #6071 cited-skip scanner under packages/core/src/check/.
// Does not invent a parallel scanner; callers inject #6071 citation-shaped rows.
// ---------------------------------------------------------------------------

export const SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID = "verify:sanctioned-skip-count-baseline";

/** Repo-relative path of the committed baseline count file. */
export const SANCTIONED_SKIP_COUNT_BASELINE_REL =
  "packages/core/src/check/sanctioned-skip-count-baseline.json";

/**
 * Shape-(B) touch-set must admit this path alongside test skip sites (#6072
 * Recut-3 second P2 limb / Depends-on #6071).
 */
export const SHAPE_B_ALLOWED_BASELINE_PATHS = [SANCTIONED_SKIP_COUNT_BASELINE_REL] as const;

export const SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA =
  "deft.sanctioned-skip-count-baseline.v1" as const;

export type SanctionedSkipCitationShape = "cited" | "uncited" | "malformed";

/** #6071 inventory row before live issue-state filtering. */
export type SanctionedSkipInventoryRow = {
  readonly path: string;
  readonly title: string;
  readonly issueNumber: number | null;
  readonly citationShape: SanctionedSkipCitationShape;
};

export type SanctionedSkipCountBaselineFile = {
  readonly schema: typeof SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA;
  readonly count: number;
};

export type ShapeBBaselineAuthorization = {
  /** True when #6071 admits this PR as shape-(B) hotfix. */
  readonly admitted: boolean;
  /** Net new skips #6071 authorizes on this diff (0 when none). */
  readonly authorizedNetNew: number;
};

export type SanctionedSkipCountBaselinePhase = "pre-pr" | "merge-readiness";

export type EvaluateSanctionedSkipCountBaselineInput = {
  /** Candidate tree-syntax count (#6071 cited-shape rows; ignore issue-state). */
  readonly candidateTreeSyntaxCount: number;
  /** Baseline count at the target revision (merge-base or current target). */
  readonly targetBaselineCount: number;
  /**
   * Candidate committed baseline count. null = missing or invalid file
   * (refuse; never seed zero at verification time).
   */
  readonly candidateBaselineCount: number | null;
  readonly shapeB: ShapeBBaselineAuthorization;
  readonly phase?: SanctionedSkipCountBaselinePhase;
};

export type SanctionedSkipCountBaselineOutcome =
  | "pass"
  | "raise-refused"
  | "baseline-missing"
  | "baseline-mismatch"
  | "baseline-bump-mismatch";

export type EvaluateSanctionedSkipCountBaselineResult = {
  readonly ok: boolean;
  readonly code: 0 | 1 | 2;
  readonly outcome: SanctionedSkipCountBaselineOutcome;
  readonly message: string;
  readonly candidateTreeSyntaxCount: number;
  readonly targetBaselineCount: number;
  readonly candidateBaselineCount: number | null;
  readonly authorizedNetNew: number;
  /** True when this evaluator path invoked task check (must stay false). */
  readonly invokedTaskCheck: false;
};

/**
 * Count #6071 listed rows that carry a cited citation shape.
 * Issue-state is intentionally ignored for the ratchet denominator.
 */
export function countCitationShapedSanctionedSkips(
  rows: readonly SanctionedSkipInventoryRow[],
): number {
  let n = 0;
  for (const row of rows) {
    if (row.citationShape === "cited") n += 1;
  }
  return n;
}

export function parseSanctionedSkipCountBaselineJson(
  text: string,
):
  | { readonly ok: true; readonly value: SanctionedSkipCountBaselineFile }
  | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "baseline JSON is not parseable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "baseline JSON must be an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA) {
    return {
      ok: false,
      reason: `baseline schema must be ${SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA}`,
    };
  }
  if (typeof obj.count !== "number" || !Number.isInteger(obj.count) || obj.count < 0) {
    return { ok: false, reason: "baseline count must be a non-negative integer" };
  }
  return {
    ok: true,
    value: {
      schema: SANCTIONED_SKIP_COUNT_BASELINE_SCHEMA,
      count: obj.count,
    },
  };
}

export function readSanctionedSkipCountBaselineAtRoot(
  root: string,
  seams: {
    readonly readText?: (absPath: string) => string | null;
    readonly exists?: (absPath: string) => boolean;
  } = {},
):
  | { readonly ok: true; readonly value: SanctionedSkipCountBaselineFile }
  | { readonly ok: false; readonly reason: string } {
  const abs = resolveBaselineAbs(root);
  const exists = seams.exists ?? ((p: string) => existsSync(p));
  if (!exists(abs)) {
    return {
      ok: false,
      reason: `missing baseline file at ${SANCTIONED_SKIP_COUNT_BASELINE_REL}`,
    };
  }
  const readText =
    seams.readText ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const text = readText(abs);
  if (text === null) {
    return {
      ok: false,
      reason: `unreadable baseline file at ${SANCTIONED_SKIP_COUNT_BASELINE_REL}`,
    };
  }
  return parseSanctionedSkipCountBaselineJson(text);
}

function resolveBaselineAbs(root: string): string {
  const base = isAbsolute(root) ? root : join(process.cwd(), root);
  return join(base, ...SANCTIONED_SKIP_COUNT_BASELINE_REL.split("/"));
}

/** Normalize a repo-relative path for shape-(B) touch-set membership. */
export function normalizeRepoRelativePath(path: string): string {
  const n = normalize(path).split(sep).join("/");
  return n.replace(/^\.?\//, "");
}

/** True when a changed path is the baseline count file (#6072 shape-B admit). */
export function isSanctionedSkipCountBaselinePath(path: string): boolean {
  const n = normalizeRepoRelativePath(path);
  return (SHAPE_B_ALLOWED_BASELINE_PATHS as readonly string[]).includes(n);
}

/**
 * Pure baseline ratchet evaluator. Callers supply #6071 inventory-derived counts
 * and shape-(B) authorization; this module does not scan the tree itself.
 */
export function evaluateSanctionedSkipCountBaseline(
  input: EvaluateSanctionedSkipCountBaselineInput,
): EvaluateSanctionedSkipCountBaselineResult {
  const candidate = input.candidateTreeSyntaxCount;
  const target = input.targetBaselineCount;
  const baseline = input.candidateBaselineCount;
  const authorizedNetNew = input.shapeB.authorizedNetNew;
  const phase = input.phase ?? "merge-readiness";

  if (!Number.isInteger(candidate) || candidate < 0) {
    return baselineFail(
      2,
      "baseline-missing",
      "candidate tree-syntax count must be a non-negative integer",
      { candidate, target, baseline, authorizedNetNew },
    );
  }
  if (!Number.isInteger(target) || target < 0) {
    return baselineFail(
      2,
      "baseline-missing",
      "target baseline count must be a non-negative integer",
      { candidate, target, baseline, authorizedNetNew },
    );
  }
  if (!Number.isInteger(authorizedNetNew) || authorizedNetNew < 0) {
    return baselineFail(
      2,
      "baseline-bump-mismatch",
      "authorizedNetNew must be a non-negative integer",
      { candidate, target, baseline, authorizedNetNew },
    );
  }

  if (baseline === null) {
    return baselineFail(
      1,
      "baseline-missing",
      `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: missing or invalid candidate baseline at ${SANCTIONED_SKIP_COUNT_BASELINE_REL} (phase=${phase}); refuse rather than seed zero`,
      { candidate, target, baseline, authorizedNetNew },
    );
  }
  if (!Number.isInteger(baseline) || baseline < 0) {
    return baselineFail(
      1,
      "baseline-missing",
      `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: invalid candidate baseline count`,
      { candidate, target, baseline, authorizedNetNew },
    );
  }

  // P4: candidate committed baseline must equal candidate tree-syntax count.
  if (baseline !== candidate) {
    return baselineFail(
      1,
      "baseline-mismatch",
      `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: candidate baseline ${baseline} must equal candidate tree-syntax count ${candidate}`,
      { candidate, target, baseline, authorizedNetNew },
    );
  }

  if (candidate < target) {
    return baselinePass(
      `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: down-ratchet ok (count ${candidate} < target baseline ${target}; phase=${phase})`,
      { candidate, target, baseline, authorizedNetNew },
    );
  }

  if (candidate === target) {
    return baselinePass(
      `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: count ${candidate} matches target baseline (phase=${phase})`,
      { candidate, target, baseline, authorizedNetNew },
    );
  }

  const bump = baseline - target;
  if (!input.shapeB.admitted) {
    return baselineFail(
      1,
      "raise-refused",
      `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: sanctioned skip count ${candidate} exceeds target baseline ${target}; refuse raise without shape-(B) hotfix authorization (phase=${phase})`,
      { candidate, target, baseline, authorizedNetNew },
    );
  }
  if (bump !== authorizedNetNew) {
    return baselineFail(
      1,
      "baseline-bump-mismatch",
      `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: baseline bump ${bump} must equal #6071-authorized net-new skips ${authorizedNetNew} (phase=${phase})`,
      { candidate, target, baseline, authorizedNetNew },
    );
  }

  return baselinePass(
    `${SANCTIONED_SKIP_COUNT_BASELINE_GATE_ID}: shape-(B) raise admitted (count ${candidate}, bump ${bump}, phase=${phase})`,
    { candidate, target, baseline, authorizedNetNew },
  );
}

/**
 * Convenience: derive candidate count from #6071 rows, read candidate baseline,
 * evaluate. Does not perform live issue probes or tree scanning.
 */
export function evaluateSanctionedSkipCountBaselineFromInventory(input: {
  readonly candidateRows: readonly SanctionedSkipInventoryRow[];
  readonly candidateRoot: string;
  readonly targetBaselineCount: number;
  readonly shapeB: ShapeBBaselineAuthorization;
  readonly phase?: SanctionedSkipCountBaselinePhase;
  readonly seams?: {
    readonly readText?: (absPath: string) => string | null;
    readonly exists?: (absPath: string) => boolean;
  };
}): EvaluateSanctionedSkipCountBaselineResult {
  const candidateTreeSyntaxCount = countCitationShapedSanctionedSkips(input.candidateRows);
  const read = readSanctionedSkipCountBaselineAtRoot(input.candidateRoot, input.seams ?? {});
  const candidateBaselineCount = read.ok ? read.value.count : null;
  return evaluateSanctionedSkipCountBaseline({
    candidateTreeSyntaxCount,
    targetBaselineCount: input.targetBaselineCount,
    candidateBaselineCount,
    shapeB: input.shapeB,
    phase: input.phase,
  });
}

function baselinePass(
  message: string,
  counts: {
    candidate: number;
    target: number;
    baseline: number | null;
    authorizedNetNew: number;
  },
): EvaluateSanctionedSkipCountBaselineResult {
  return {
    ok: true,
    code: 0,
    outcome: "pass",
    message,
    candidateTreeSyntaxCount: counts.candidate,
    targetBaselineCount: counts.target,
    candidateBaselineCount: counts.baseline,
    authorizedNetNew: counts.authorizedNetNew,
    invokedTaskCheck: false,
  };
}

function baselineFail(
  code: 1 | 2,
  outcome: Exclude<SanctionedSkipCountBaselineOutcome, "pass">,
  message: string,
  counts: {
    candidate: number;
    target: number;
    baseline: number | null;
    authorizedNetNew: number;
  },
): EvaluateSanctionedSkipCountBaselineResult {
  return {
    ok: false,
    code,
    outcome,
    message,
    candidateTreeSyntaxCount: counts.candidate,
    targetBaselineCount: counts.target,
    candidateBaselineCount: counts.baseline,
    authorizedNetNew: counts.authorizedNetNew,
    invokedTaskCheck: false,
  };
}

// --- Cited-skip scanner (#6071 Prefer-A Recut-2) ---

/** Token-boundary skip forms; deliberately excludes skipIf (#6071 Recut-2). */
const SKIP_CALL_RE =
  /(?<![\w$.])((?:it|test|describe)\.skip)\s*\(\s*(?:(["'`])((?:\\.|(?!\2)[\s\S])*?)\2|([A-Za-z_$][\w$]*))/g;

const SKIP_COMMENT_RE = /\/\/\s*skip:\s*deftai\/directive#(\d+)/i;
const SKIPPED_TESTS_BLOCK_RE = /```skipped-tests:\r?\n([\s\S]*?)```/;

export interface CitedSkipSite {
  readonly file: string;
  readonly kind: "it.skip" | "test.skip" | "describe.skip";
  readonly title: string | null;
  readonly dynamicTitle: boolean;
  readonly issue: number | null;
  readonly line: number;
}

/** Four-site baseline allowlist (legacy-bridge describe.skip+it.skip + two yoloSterile aliases). */
export const CITED_SKIP_BASELINE: readonly {
  readonly file: string;
  readonly kind: CitedSkipSite["kind"];
  readonly dynamicTitle: boolean;
}[] = [
  {
    file: "packages/core/src/release-e2e/legacy-bridge-leg.test.ts",
    kind: "describe.skip",
    dynamicTitle: false,
  },
  {
    file: "packages/core/src/release-e2e/legacy-bridge-leg.test.ts",
    kind: "it.skip",
    dynamicTitle: false,
  },
  {
    file: "packages/core/src/content-contracts/skills/agents_md_session_start.test.ts",
    kind: "it.skip",
    dynamicTitle: true,
  },
  {
    file: "packages/core/src/content-contracts/standards/branch_gate.test.ts",
    kind: "it.skip",
    dynamicTitle: true,
  },
] as const;

export function parseSkippedTestsBlock(body: string): string[] {
  const m = SKIPPED_TESTS_BLOCK_RE.exec(body);
  if (m === null || m[1] === undefined) return [];
  return m[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Inventory it.skip/test.skip/describe.skip with token boundary excluding skipIf. */
export function inventoryCitedSkipsInSource(
  source: string,
  file: string,
): CitedSkipSite[] {
  const sites: CitedSkipSite[] = [];
  const re = new RegExp(SKIP_CALL_RE.source, SKIP_CALL_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const kind = match[1] as CitedSkipSite["kind"];
    const title = match[3] ?? null;
    const dynamicTitle = title === null && match[4] !== undefined;
    const line = lineNumberAt(source, match.index);
    const windowStart = Math.max(0, match.index - 200);
    const window = source.slice(windowStart, match.index + match[0].length);
    const comment = SKIP_COMMENT_RE.exec(window);
    const issue = comment?.[1] !== undefined ? Number(comment[1]) : null;
    sites.push({
      file: file.replaceAll("\\", "/"),
      kind,
      title,
      dynamicTitle,
      issue,
      line,
    });
  }
  // yoloSterile alias form: `const itX = cond ? it.skip : it` (dynamic title; not a call).
  const aliasRe = /\byoloSterile\s*\?\s*it\.skip\b/g;
  let alias: RegExpExecArray | null;
  while ((alias = aliasRe.exec(source)) !== null) {
    sites.push({
      file: file.replaceAll("\\", "/"),
      kind: "it.skip",
      title: null,
      dynamicTitle: true,
      issue: null,
      line: lineNumberAt(source, alias.index),
    });
  }
  return sites;
}

function walkTestFiles(root: string, dir: string, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTestFiles(root, full, out);
      continue;
    }
    if (/\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(name)) {
      out.push(full);
    }
  }
}

export function inventoryCitedSkipsInTree(projectRoot: string): CitedSkipSite[] {
  const files: string[] = [];
  walkTestFiles(projectRoot, projectRoot, files);
  const sites: CitedSkipSite[] = [];
  for (const abs of files) {
    let source = "";
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = relative(projectRoot, abs).replaceAll("\\", "/");
    sites.push(...inventoryCitedSkipsInSource(source, rel));
  }
  return sites;
}

function isBaselineSite(site: CitedSkipSite): boolean {
  return CITED_SKIP_BASELINE.some(
    (b) =>
      b.file === site.file &&
      b.kind === site.kind &&
      (b.dynamicTitle ? site.dynamicTitle : true),
  );
}

export interface CitedSkipScanOptions {
  readonly projectRoot: string;
  /** When set, only these relative paths are live-validated for issue probes. */
  readonly changedFiles?: readonly string[];
  readonly hotfixShapeB?: boolean;
  readonly fetchIssue?: (
    issue: number,
  ) => { state: string; created_at: string; body: string } | null;
  readonly skipCommitTimeIso?: string;
}

export interface CitedSkipScanResult {
  readonly ok: boolean;
  readonly inventory: readonly CitedSkipSite[];
  readonly failures: readonly string[];
  readonly listing: string;
}

export function formatCitedSkipListing(sites: readonly CitedSkipSite[]): string {
  if (sites.length === 0) return "cited-skips: (none)";
  const lines = sites.map(
    (s) =>
      `- ${s.file}:${s.line} ${s.kind} title=${JSON.stringify(s.title)} issue=${s.issue ?? "none"}`,
  );
  return ["cited-skips:", ...lines].join("\n");
}

/**
 * Scan tree for unsanctioned skips. Lists inventory every run; live-probes
 * only changed sites when changedFiles is provided (#6071).
 */
export function evaluateCitedSkipScan(options: CitedSkipScanOptions): CitedSkipScanResult {
  const inventory = inventoryCitedSkipsInTree(options.projectRoot);
  const listing = formatCitedSkipListing(inventory);
  const failures: string[] = [];
  const changed = new Set(
    (options.changedFiles ?? []).map((f) => f.replaceAll("\\", "/")),
  );
  const liveAll = changed.size === 0;

  for (const site of inventory) {
    if (isBaselineSite(site)) {
      continue;
    }
    if (site.kind === "describe.skip") {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} describe.skip refused in v1 (#6071)`,
      );
      continue;
    }
    const inDiff = liveAll || changed.has(site.file);
    if (!inDiff) {
      // Static inventory only for unchanged sites.
      continue;
    }
    if (!options.hotfixShapeB) {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} skip added outside admitted shape (B) hotfix (#6071)`,
      );
      continue;
    }
    if (site.issue === null) {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} missing // skip: deftai/directive#N citation (#6071)`,
      );
      continue;
    }
    if (options.fetchIssue === undefined) {
      continue;
    }
    const issue = options.fetchIssue(site.issue);
    if (issue === null) {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} issue #${site.issue} missing (#6071)`,
      );
      continue;
    }
    if (issue.state !== "open") {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} issue #${site.issue} is ${issue.state} (#6071)`,
      );
      continue;
    }
    if (
      options.skipCommitTimeIso !== undefined &&
      Date.parse(issue.created_at) > Date.parse(options.skipCommitTimeIso)
    ) {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} issue #${site.issue} created_at after skip commit (#6071)`,
      );
      continue;
    }
    const titles = parseSkippedTestsBlock(issue.body);
    if (titles.length === 0) {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} issue #${site.issue} lacks skipped-tests block (#6071)`,
      );
      continue;
    }
    if (site.title !== null && !titles.includes(site.title)) {
      failures.push(
        `unsanctioned-test-skip: ${site.file}:${site.line} title not in issue #${site.issue} skipped-tests (#6071)`,
      );
    }
  }

  return { ok: failures.length === 0, inventory, failures, listing };
}

/** Map #6071 inventory sites to #6072 citation-shaped rows (issue-state ignored). */
export function mapCitedSkipSitesToSanctionedRows(
  sites: readonly CitedSkipSite[],
): SanctionedSkipInventoryRow[] {
  return sites.map((site) => ({
    path: site.file,
    title: site.title ?? "",
    issueNumber: site.issue,
    citationShape: site.issue !== null ? ("cited" as const) : ("uncited" as const),
  }));
}

/**
 * Production wire for #6072 Bound P3: run baseline ratchet on check paths.
 * Uses #6071 inventory rows; merge-base target via options for pre-pr phase.
 */
export function runSanctionedSkipCountBaselineGate(options: {
  readonly projectRoot: string;
  readonly phase: SanctionedSkipCountBaselinePhase;
  readonly shapeB?: ShapeBBaselineAuthorization;
  readonly targetBaselineCount?: number;
  readonly candidateRows?: readonly SanctionedSkipInventoryRow[];
}): { readonly ok: boolean; readonly code: 0 | 1 | 2; readonly message: string } {
  const sites = inventoryCitedSkipsInTree(options.projectRoot);
  const rows = options.candidateRows ?? mapCitedSkipSitesToSanctionedRows(sites);
  let targetBaselineCount = options.targetBaselineCount;
  if (targetBaselineCount === undefined) {
    const targetRead = readSanctionedSkipCountBaselineAtRoot(options.projectRoot);
    if (!targetRead.ok) {
      return { ok: false, code: 1, message: targetRead.reason };
    }
    targetBaselineCount = targetRead.value.count;
  }
  const result = evaluateSanctionedSkipCountBaselineFromInventory({
    candidateRows: rows,
    candidateRoot: options.projectRoot,
    targetBaselineCount,
    shapeB: options.shapeB ?? { admitted: false, authorizedNetNew: 0 },
    phase: options.phase,
  });
  return { ok: result.ok, code: result.code, message: result.message };
}

