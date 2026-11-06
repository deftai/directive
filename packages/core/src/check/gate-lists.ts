/** Gate execution order mirrors Taskfile.yml check targets (#1713 dogfood). */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_AC_GATE_ID } from "../product-first-done-gate/types.js";

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

/** In-process cited-skip scanner gate id (#6071). */
export const SKIP_CITATION_GATE_ID = "verify:skip-citation";

/**
 * Pinned baseline allowlist for legacy uncited skip sites (#6071 Recut-2).
 * Paths are repo-relative with forward slashes. Aliases use dynamic-title reason.
 */
export const SKIP_CITATION_BASELINE: readonly {
  readonly path: string;
  readonly kind: "it.skip" | "test.skip" | "describe.skip" | "alias";
  readonly reason: string;
}[] = [
  {
    path: "packages/core/src/release-e2e/legacy-bridge-leg.test.ts",
    kind: "describe.skip",
    reason: "legacy AC10.10 archaeology describe.skip baseline",
  },
  {
    path: "packages/core/src/release-e2e/legacy-bridge-leg.test.ts",
    kind: "it.skip",
    reason: "legacy AC10.10 archaeology it.skip baseline",
  },
  {
    path: "packages/core/src/content-contracts/skills/agents_md_session_start.test.ts",
    kind: "alias",
    reason: "yoloSterile dynamic-title it.skip alias baseline",
  },
  {
    path: "packages/core/src/content-contracts/standards/branch_gate.test.ts",
    kind: "alias",
    reason: "yoloSterile dynamic-title it.skip alias baseline",
  },
];

/** Token-boundary skip match; excludes skipIf helpers (#6071). */
const SKIP_CALL_RE =
  /(?<![A-Za-z0-9_])(it|test|describe)\.skip(?!If)(?![A-Za-z0-9_])/g;
const SKIP_COMMENT_RE = /\/\/\s*skip:\s*deftai\/directive#(\d+)/i;
const SKIP_REASON_HASH_RE = /#(\d+)/;
const TITLE_RE = /(?:it|test|describe)\.skip\s*\(\s*(["'`])([^"'`]+)\1/;

export interface SkipInventoryEntry {
  readonly path: string;
  readonly line: number;
  readonly kind: "it.skip" | "test.skip" | "describe.skip" | "alias";
  readonly title: string | null;
  readonly issue: number | null;
  readonly baseline: boolean;
  readonly raw: string;
}

export interface SkipCitationScanResult {
  readonly ok: boolean;
  readonly inventory: readonly SkipInventoryEntry[];
  readonly failures: readonly string[];
  readonly message: string;
}

function normalizeRel(path: string): string {
  return path.replaceAll("\\", "/");
}

function isBaselineSite(path: string, kind: SkipInventoryEntry["kind"]): boolean {
  const rel = normalizeRel(path);
  return SKIP_CITATION_BASELINE.some((b) => b.path === rel && b.kind === kind);
}

function extractIssueNear(line: string, prevLine: string | undefined): number | null {
  const comment = SKIP_COMMENT_RE.exec(line) ?? (prevLine ? SKIP_COMMENT_RE.exec(prevLine) : null);
  if (comment?.[1]) return Number.parseInt(comment[1], 10);
  const reason = SKIP_REASON_HASH_RE.exec(line);
  if (reason?.[1]) return Number.parseInt(reason[1], 10);
  return null;
}

function extractTitle(line: string): string | null {
  const m = TITLE_RE.exec(line);
  return m?.[2] ?? null;
}

/**
 * Inventory it.skip/test.skip/describe.skip with token boundary excluding skipIf (#6071).
 * Static / offline: no network. Live probes belong to diff-added callers.
 */
export function inventoryTestSkips(
  files: readonly { readonly path: string; readonly content: string }[],
): readonly SkipInventoryEntry[] {
  const out: SkipInventoryEntry[] = [];
  for (const file of files) {
    const rel = normalizeRel(file.path);
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      SKIP_CALL_RE.lastIndex = 0;
      const match = SKIP_CALL_RE.exec(line);
      if (match === null) continue;
      const callee = match[1] ?? "it";
      const kind = `${callee}.skip` as SkipInventoryEntry["kind"];
      const isAlias = /\?\s*(?:it|test)\.skip\s*:/.test(line) || /=\s*(?:it|test)\.skip\b/.test(line);
      const entryKind: SkipInventoryEntry["kind"] = isAlias ? "alias" : kind;
      out.push({
        path: rel,
        line: i + 1,
        kind: entryKind,
        title: extractTitle(line),
        issue: extractIssueNear(line, lines[i - 1]),
        baseline: isBaselineSite(rel, entryKind) || isBaselineSite(rel, kind),
        raw: line.trim(),
      });
    }
  }
  return out;
}

export function evaluateSkipCitationInventory(
  inventory: readonly SkipInventoryEntry[],
  options: {
    readonly changedPaths?: ReadonlySet<string>;
    readonly hotfixAdmitted?: boolean;
    readonly hotfixShape?: "A" | "B" | null;
  } = {},
): SkipCitationScanResult {
  const failures: string[] = [];
  const changed = options.changedPaths;
  const diffMode = changed !== undefined;
  for (const entry of inventory) {
    if (entry.baseline) continue;
    const inDiff = !diffMode || changed.has(entry.path);
    if (entry.kind === "describe.skip") {
      failures.push(
        `new describe.skip refused at ${entry.path}:${entry.line} (v1 per-test only; baseline excepted) (#6071)`,
      );
      continue;
    }
    if (entry.issue === null) {
      if (inDiff) {
        failures.push(
          `uncited ${entry.kind} at ${entry.path}:${entry.line} — require // skip: deftai/directive#N or reason #N (#6071)`,
        );
      }
      continue;
    }
    // Diff-only: authorize added/changed cited skips under admitted A/B.
    if (diffMode && inDiff && options.hotfixAdmitted !== true) {
      failures.push(
        `added/changed skip at ${entry.path}:${entry.line} requires admitted hotfix A/B (#6071)`,
      );
    } else if (
      diffMode &&
      inDiff &&
      options.hotfixShape === "B" &&
      options.hotfixAdmitted === true &&
      !entry.path.includes(".test.")
    ) {
      failures.push(
        `shape (B) skip touch-set refuses non-test path ${entry.path}:${entry.line} (#6071)`,
      );
    }
  }
  const lines = inventory.map(
    (e) =>
      `${e.path}:${e.line} ${e.kind} title=${JSON.stringify(e.title)} issue=${e.issue ?? "none"} baseline=${e.baseline}`,
  );
  const message =
    failures.length === 0
      ? `skip-citation: ok (${inventory.length} inventoried)\n${lines.join("\n")}`
      : `skip-citation: FAIL\n${failures.join("\n")}\n--- inventory ---\n${lines.join("\n")}`;
  return { ok: failures.length === 0, inventory, failures, message };
}

/** Walk common test roots under projectRoot for skip inventory (#6071). */
export function scanProjectTestSkips(projectRoot: string): SkipCitationScanResult {
  const files: { path: string; content: string }[] = [];
  const roots = [
    join(projectRoot, "packages", "core", "src"),
    join(projectRoot, "packages", "runtime", "src"),
  ];
  const visit = (dir: string, relBase: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = normalizeRel(join(relBase, name));
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "dist" || name === ".git") continue;
        visit(abs, rel);
        continue;
      }
      if (!name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) continue;
      try {
        files.push({ path: rel, content: readFileSync(abs, "utf8") });
      } catch {
        /* skip unreadable */
      }
    }
  };
  for (const root of roots) {
    const rel = normalizeRel(root.slice(projectRoot.length).replace(/^[/\\]/, ""));
    visit(root, rel);
  }
  const inventory = inventoryTestSkips(files);
  return evaluateSkipCitationInventory(inventory);
}
