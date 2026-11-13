/** Gate execution order mirrors Taskfile.yml check targets (#1713 dogfood). */

import { readFileSync as readFileSyncFs } from "node:fs";
import { relative } from "node:path";
import { PRODUCT_AC_GATE_ID } from "../product-first-done-gate/types.js";
import { walkTestFiles } from "./walk-test-files.js";

/**
 * A check gate is either a bare Taskfile task name, or a public task plus CLI
 * args (after `--`). Framework-only shims that are `internal: true` in
 * Taskfile.yml cannot be shelled by name under go-task 3.50 (#2791) — use the
 * public surface with the shim's flags instead.
 */
export type CheckGateSpec =
  | string
  | {
      readonly task: string;
      readonly args?: readonly string[];
    };

/**
 * Product-first AC gate (#3284): always first; `--soft-missing-xbrief` skips
 * only when no story was active this session. A same-session complete targets
 * xbrief/completed instead of skipping (#3357). Multi-active soft-missing
 * selects via DEFT_ACTIVE_SCOPE / explicit path (#4285); never soft-greens past
 * stated AC for the selected story.
 */
export const PRODUCT_FIRST_AC_GATE: CheckGateSpec = {
  task: PRODUCT_AC_GATE_ID,
  args: ["--soft-missing-xbrief"],
};

/**
 * Candidate-scoped orphan-active for check aggregates (#3893).
 *
 * The unscoped sweep on the merge chokepoint gave a brief stranded by one
 * merge authority over every other open PR, and N stranded briefs made N
 * single-brief lifecycle PRs mutually unmergeable. It was never preventive for
 * the candidate either: that candidate's linked PR still reads
 * `merged_at: null` while its own gate runs.
 *
 * Bare `verify:orphan-active` stays repo-wide for `deft doctor`, manual runs,
 * swarm finalize, and the after-merge `--issue N` DONE gate (#3429); the
 * scoped form still falls back to the full sweep at the delivery tip.
 */
export const ORPHAN_ACTIVE_MERGE_GATE: CheckGateSpec = {
  task: "verify:orphan-active",
  args: ["--changed-only"],
};

export function checkGateId(spec: CheckGateSpec): string {
  return typeof spec === "string" ? spec : spec.task;
}

/** Args for `task … --taskfile <path>` (optional `--` + public CLI flags). */
export function checkGateSpawnArgs(spec: CheckGateSpec, taskfilePath: string): string[] {
  const task = checkGateId(spec);
  const extra = typeof spec === "string" ? undefined : spec.args;
  if (extra !== undefined && extra.length > 0) {
    return [task, "--taskfile", taskfilePath, "--", ...extra];
  }
  return [task, "--taskfile", taskfilePath];
}

/**
 * Gates that own the long vitest+coverage (or equivalent) suite path.
 * Shared `task check` composition runs every non-suite gate first so cheap
 * failures never pay suite wall-clock (#3188). Release suite stamp/resume
 * remains #3187 / release-scoped.
 */
export const SUITE_CHECK_GATE_IDS: readonly string[] = [
  "ts:check-lane",
  "verify:consumer-test-lane",
];

export function isSuiteCheckGate(spec: CheckGateSpec | string): boolean {
  const id = typeof spec === "string" ? spec : checkGateId(spec);
  return (SUITE_CHECK_GATE_IDS as readonly string[]).includes(id);
}

/**
 * True when every suite gate appears after all non-suite gates (#3188).
 * Empty lists and suite-only lists are valid; a non-suite after a suite is not.
 */
export function isFastBeforeSlowOrder(gates: readonly CheckGateSpec[]): boolean {
  let sawSuite = false;
  for (const gate of gates) {
    if (isSuiteCheckGate(gate)) {
      sawSuite = true;
    } else if (sawSuite) {
      return false;
    }
  }
  return true;
}

/**
 * Framework-source check composition (#1713 / #3188 / #3284).
 *
 * Order contract:
 *  1. Product AC first (fail-fast; never skippable when commands exist) — #3284
 *  2. Cheap hygiene preflight — #3188
 *  3. `ts:check-lane` suite last
 */
export const FRAMEWORK_CHECK_GATES: readonly CheckGateSpec[] = [
  // --- Product-first done-gate (#3284) — AC before any hygiene ---
  PRODUCT_FIRST_AC_GATE,
  // --- Fast preflight (seconds–few min) — #3188 ---
  "verify:branch",
  "verify:encoding",
  "verify:closing-keywords",
  "verify:cache-fresh",
  ORPHAN_ACTIVE_MERGE_GATE,
  "verify:completed-write-guard",
  "verify:license-sync",
  "verify:contract-drift",
  "toolchain:check",
  "verify:stubs",
  "verify:links",
  "verify:rule-ownership",
  "verify:rule-to-verb-parity",
  "verify:biome-config",
  "verify:content-manifest",
  // #3900 check 1: C1 declaration vs staged pack. Checks 2/3 compose C3/C2.
  "verify:deposit-closure",
  "verify:skill-external-fetch-gate",
  "verify:semantic-single-source",
  "verify:cursor-tier1",
  "verify:openclaw-tier1",
  "verify:go-freeze",
  "verify:bridge-drift",
  "verify:forward-coverage",
  // #633: reuse changelog-check Unreleased language on the framework-source conjunct.
  "verify:changelog-unreleased",
  // #3145: test/source boundary + approved-scope provenance + consumer gate composition
  "verify:test-boundary",
  "verify:class-checks",
  "verify:scope-provenance",
  // #3893: fail-closed on merge-chokepoint gate scoping for the composition
  // this repo owns; consumer deposits stay warn-only until `deft update`.
  { task: "verify:consumer-check-contract", args: ["--framework-source"] },
  { task: "verify:evaluator-surface", args: ["--base-ref", "origin/master"] },
  "verify:observable-scope",
  "verify:intent-constraint",
  "verify:presentation-ceiling",
  "verify:durable-effect-acquisition",
  { task: "verify:presentation-coverage", args: ["--json"] },
  // #3362: dead-surface detector (warn-only this release; no --enforce)
  "verify:telemetry-coverage",
  "verify:vbrief-conformance",
  "verify:destructive-gh-verbs",
  "verify:scm-boundary",
  "verify:xbrief-drift",
  "verify:no-task-runtime",
  "verify:pack-drift",
  // Public surface for Taskfile verify-wip-cap-framework-self-check (#1124 / #2791)
  { task: "verify:wip-cap", args: ["--allow-over-cap"] },
  "verify:agents-md-budget",
  // Public surfaces for internal eval-relocation framework shims (#2791)
  { task: "verify:eval-health-relocation", args: ["--base-ref", "origin/master"] },
  { task: "verify:eval-triggers-relocation", args: ["--base-ref", "origin/master"] },
  "vbrief:validate",
  "codebase:validate-structure",
  "verify:codebase-map-fresh",
  "verify:spec-prd-fresh",
  // #4095: committed RULE-MAP byte-identical to renderer (framework-only).
  "docs:rule-map:check",
  // #4099: committed capability index byte-identical to overlay+registries.
  "docs:capability-map:check",
  "verify-strategy-output",
  // --- Suite last: vitest + coverage via ts:check-lane (#3188) ---
  "ts:check-lane",
];

export const CONSUMER_CHECK_GATES: readonly CheckGateSpec[] = [
  // Product-first: stated AC before hygiene (#3284)
  PRODUCT_FIRST_AC_GATE,
  // Cheap lifecycle / policy second (no suite co-list today; keep fail-fast order)
  "verify:branch",
  "verify:cache-fresh",
  "verify:wip-cap",
  ORPHAN_ACTIVE_MERGE_GATE,
  "verify:completed-write-guard",
  "doctor",
  "toolchain:check-consumer",
  // #3145 enforcement trio (test placement, scope provenance, gate composition)
  "verify:test-boundary",
  "verify:class-checks",
  "verify:scope-provenance",
  "verify:consumer-check-contract",
  "verify:evaluator-surface",
  "verify:observable-scope",
  "verify:intent-constraint",
  "verify:presentation-ceiling",
  "verify:durable-effect-acquisition",
  { task: "verify:presentation-coverage", args: ["--json"] },
  "vbrief:validate",
  "verify-strategy-output",
  // Declared project test command last (#4386). Skip when undeclared.
  // PRODUCT_FIRST_AC_GATE stays first and is not replaced.
  "verify:consumer-test-lane",
];

export function gatesForCheckTarget(target: string): readonly CheckGateSpec[] {
  if (target === "check:framework-source") {
    return FRAMEWORK_CHECK_GATES;
  }
  if (target === "check:consumer") {
    return CONSUMER_CHECK_GATES;
  }
  return [];
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
  {
    file: "packages/core/src/check/orchestrator.test.ts",
    kind: "describe.skip",
    dynamicTitle: false,
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
export function inventoryCitedSkipsInSource(source: string, file: string): CitedSkipSite[] {
  const sites: CitedSkipSite[] = [];
  const re = new RegExp(SKIP_CALL_RE.source, SKIP_CALL_RE.flags);
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
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
    match = re.exec(source);
  }
  // yoloSterile alias form: `const itX = cond ? it.skip : it` (dynamic title; not a call).
  const aliasRe = /\byoloSterile\s*\?\s*it\.skip\b/g;
  let alias: RegExpExecArray | null = aliasRe.exec(source);
  while (alias !== null) {
    sites.push({
      file: file.replaceAll("\\", "/"),
      kind: "it.skip",
      title: null,
      dynamicTitle: true,
      issue: null,
      line: lineNumberAt(source, alias.index),
    });
    alias = aliasRe.exec(source);
  }
  return sites;
}

export function inventoryCitedSkipsInTree(projectRoot: string): CitedSkipSite[] {
  const files = walkTestFiles(projectRoot);
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

function matchesBaselineEntry(
  site: CitedSkipSite,
  baseline: (typeof CITED_SKIP_BASELINE)[number],
): boolean {
  return (
    baseline.file === site.file &&
    baseline.kind === site.kind &&
    baseline.dynamicTitle === site.dynamicTitle
  );
}

/** True when a fresh baseline slot matches; each baseline entry admits one site (#6071). */
function claimBaselineSite(site: CitedSkipSite, claimed: Set<number>): boolean {
  for (let i = 0; i < CITED_SKIP_BASELINE.length; i++) {
    if (claimed.has(i)) continue;
    const baseline = CITED_SKIP_BASELINE[i];
    if (baseline === undefined) continue;
    if (!matchesBaselineEntry(site, baseline)) continue;
    claimed.add(i);
    return true;
  }
  return false;
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
  const claimedBaseline = new Set<number>();

  for (const site of inventory) {
    if (claimBaselineSite(site, claimedBaseline)) {
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
