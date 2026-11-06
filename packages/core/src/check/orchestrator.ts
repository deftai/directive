/**
 * check/orchestrator.ts -- Context-aware `task check` orchestrator (#1854 / #1883).
 *
 * TypeScript port of scripts/_project_context.py dispatch_task_check().
 * Detects whether we are running in the framework-source context or a
 * vendored-consumer context (#1519) and dispatches to the appropriate
 * aggregate Taskfile target.
 *
 * Default path uses the cached sequential gate runner (#1713) with
 * fast-before-slow ordering (#3188): cheap gates run before `ts:check-lane`
 * (vitest+coverage). A fast-gate failure aborts before the suite starts.
 * Opaque / generic-only named-cause fallbacks on that path are bugs (#1883).
 *
 * Exit codes (three-state, mirrors _project_context.py):
 *   0 -- all gates passed
 *   1 -- one or more gates failed
 *   2 -- config error (missing args, task spawn error, etc.)
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync as readFileSyncFs, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";
import {
  evaluateConsumerGateIntegrity,
  formatConsumerGateIntegrityFailure,
} from "./consumer-gate-integrity.js";
import {
  CONSUMER_HEADER_PLACEHOLDER_GATE_ID,
  evaluateConsumerHeaderPlaceholderAtRoot,
} from "./consumer-header-placeholder.js";
import { type CheckOrchestratorSeams, resolveCheckTarget } from "./context.js";
import { CONSUMER_CHECK_GATES, checkGateId, FRAMEWORK_CHECK_GATES } from "./gate-lists.js";
import { listCompositionGatesMissingSpecificRemedies } from "./named-cause.js";
import {
  CHECK_EMPTY_PLANNING_NARRATIVES_GATE_ID,
  checkRejectsEmptyPlanningNarratives,
  evaluateCheckPersistedPlanningNarratives,
} from "./persisted-planning-narratives-gate.js";

export type {
  CachedCheckCompletion,
  CheckOrchestratorOptions,
  CheckOrchestratorSeams,
} from "./context.js";
export { isFrameworkRepoRoot, isFrameworkSourceContext, resolveCheckTarget } from "./context.js";

/**
 * Composition gates (framework ∪ consumer) still missing a concrete GATE_REMEDIES
 * entry — residual audit for the named-cause seam (#1883). Empty is the ship bar.
 */
export function auditCheckCompositionNamedRemedies(): readonly string[] {
  const ids = [...new Set([...FRAMEWORK_CHECK_GATES, ...CONSUMER_CHECK_GATES].map(checkGateId))];
  return listCompositionGatesMissingSpecificRemedies(ids);
}

/**
 * Dispatch to the context-appropriate `task check` aggregate target.
 *
 * Invokes `task [target] --taskfile <frameworkRoot>/Taskfile.yml` from the
 * appropriate cwd so that go-task's `USER_WORKING_DIR` resolves correctly:
 *   - framework-source: cwd = frameworkRoot (USER_WORKING_DIR = frameworkRoot ✓)
 *   - consumer:         cwd = projectRoot  (USER_WORKING_DIR = projectRoot  ✓)
 */
export function dispatchTaskCheck(
  frameworkRoot: string,
  projectRoot: string,
  seams: CheckOrchestratorSeams = {},
): number {
  const resolvedFramework = resolve(frameworkRoot);
  const resolvedProject = resolve(projectRoot);
  const useTaskCache = seams.useTaskCache !== false && !seams.noCache;

  if (useTaskCache) {
    return dispatchCachedTaskCheck(resolvedFramework, resolvedProject, seams);
  }

  const taskfilePath = join(resolvedFramework, "Taskfile.yml");
  const taskBin = seams.taskBin ?? "task";

  const target = resolveCheckTarget(resolvedFramework, resolvedProject);
  const cwd = target === "check:framework-source" ? resolvedFramework : resolvedProject;

  // #3070: pre-flight consumer check-graph integrity (same path as cached
  // orchestrator) so uncached aggregate shelling also fails with recovery text.
  if (target === "check:consumer") {
    const integrity = evaluateConsumerGateIntegrity(resolvedFramework);
    if (!integrity.ok) {
      process.stderr.write(formatConsumerGateIntegrityFailure(integrity));
      return 2;
    }
  }

  // #5176 Prefer-A: refuse empty PD narratives only with product-mutation
  // completion (mirror #4544). Missing PD and scaffold-empty stay legal here;
  // setup Phase 2 verify stays unconditional. Do not shell the verify task
  // from Taskfile check deps — that exits 2 on missing PD.
  const planning = evaluateCheckPersistedPlanningNarratives(resolvedProject);
  if (checkRejectsEmptyPlanningNarratives(planning.narratives, planning.productMutation)) {
    process.stderr.write(`check: ${planning.narratives.message}\n`);
    process.stderr.write(
      `check: gate ${CHECK_EMPTY_PLANNING_NARRATIVES_GATE_ID} failed (exit 1)\n` +
        `  cause: ${planning.narratives.cause}\n` +
        `  remedy: ${planning.narratives.remedy}\n`,
    );
    return 1;
  }

  // #4544 Prefer-A: fail closed on uncached / Taskfile path too (cached
  // orchestrator already runs this before composition).
  const headerPlaceholder = evaluateConsumerHeaderPlaceholderAtRoot(resolvedProject);
  if (!headerPlaceholder.ok) {
    process.stderr.write(`${headerPlaceholder.message}\n`);
    process.stderr.write(
      `check: gate ${CONSUMER_HEADER_PLACEHOLDER_GATE_ID} failed (exit 1)\n` +
        `  cause: ${headerPlaceholder.reason}\n` +
        `  remedy: ${headerPlaceholder.message}\n`,
    );
    return 1;
  }

  // #6071: cited-skip inventory every framework-source check; refuse unsanctioned.
  if (target === "check:framework-source" && seams.skipCitedSkipScan !== true) {
    const cited = evaluateCitedSkipScan({
      projectRoot: resolvedProject,
      changedFiles: seams.citedSkipChangedFiles,
      hotfixShapeB: seams.citedSkipHotfixShapeB === true,
      fetchIssue: seams.citedSkipFetchIssue,
      skipCommitTimeIso: seams.citedSkipCommitTimeIso,
    });
    process.stderr.write(`${cited.listing}\n`);
    if (!cited.ok) {
      for (const failure of cited.failures) {
        process.stderr.write(`check: ${failure}\n`);
      }
      process.stderr.write(
        "check: gate cited-skip-scan failed (exit 1)\n" +
          "  cause: unsanctioned or unvalidated test skips (#6071)\n" +
          "  remedy: cite open deftai/directive#N with skipped-tests block under admitted shape B, or remove the skip\n",
      );
      return 1;
    }
  }

  const spawn = seams.spawnFn ?? defaultSpawn;
  const result = spawn(taskBin, [target, "--taskfile", taskfilePath], {
    cwd,
    stdio: "inherit",
    env: seams.env,
    timeoutMs: seams.timeoutMs,
  });

  if (result.error !== undefined) {
    // #3282: named cause + remedy instead of bare spawn failure.
    const detail = result.error.message;
    const missingTask = /ENOENT|not found|not recognized/i.test(detail);
    process.stderr.write(
      `check: gate ${target} failed (exit 2)\n` +
        `  cause: ${missingTask ? "task binary not found on PATH (cannot spawn go-task)" : detail}\n` +
        "  remedy: Install go-task (https://taskfile.dev/installation/) and ensure `task` is on PATH; then re-run task check\n",
    );
    return 2;
  }

  if (result.signal === "SIGTERM" && result.status === null && seams.timeoutMs !== undefined) {
    process.stderr.write(
      `check: timed out after ${seams.timeoutMs / 60_000}m (Step 5 vitest coverage budget; #2652)\n`,
    );
    return 124;
  }

  return result.status ?? 1;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): { status: number | null; signal?: NodeJS.Signals | null; error?: Error } {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.stdio as "inherit",
    env: opts.env ?? process.env,
    ...(opts.timeoutMs !== undefined
      ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" as const }
      : {}),
  });
  return { status: result.status, signal: result.signal, error: result.error };
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
      source = readFileSyncFs(abs, "utf8");
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
  // undefined changedFiles => inventory-only (list every run; no live probes).
  // provided list (including []) => live-validate only those paths (#6071 Bound).
  const liveProbe = options.changedFiles !== undefined;
  const changed = new Set((options.changedFiles ?? []).map((f) => f.replaceAll("\\", "/")));

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
    if (!liveProbe || !changed.has(site.file)) {
      // Static inventory only for unchanged / inventory-only runs.
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
