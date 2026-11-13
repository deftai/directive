/**
 * Small-change lane under the rapid ceremony dial (#6204).
 *
 * One fail-closed evaluator next to the ceremony dial policy. A thin brief
 * (see `intake/thin-brief.ts`) stays in the lane only while:
 *   - the ceremony dial depth is `rapid`;
 *   - the bound holds: `maxProductionFiles` / `maxChangedLines` from
 *     `plan.policy.ceremonyDial.smallChangeLane`, each field falling back to
 *     the shipped default (SMALL_CHANGE_LANE_DEFAULT_*) when unset. An invalid
 *     policy value or an unreadable PROJECT-DEFINITION refuses;
 *   - the measured cumulative product diff against the lane-admit base holds
 *     the bound;
 *   - the public-surface determination is `none`. `unknown` refuses.
 *
 * The measurement is git, never the provisional dial estimators
 * (`estimateProvisionalCeremonyInputs`, task-size hints). Those are not proof.
 *
 * The gates that can refuse (xbrief:preflight, verify:ac, scope:complete) call
 * `evaluateSmallChangeLaneGate`, so the bound is rechecked at each one.
 *
 * Lane exit: once the bound is crossed, every retry on that scope refuses until
 * the brief is converted to the full shape (`escalateThinBriefToFullShape`).
 * That conversion is scope-local. It is not the #3319 dial-depth raise
 * (`escalateCeremonyDial`), which does not clear this refusal.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import type * as TS from "typescript";
import { atomicWriteBrief } from "../scope/brief-io.js";
import { isTestOrFixturePath } from "../scope-provenance/base-fence.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { isRecognizedTestBasename } from "../test-boundary/evaluate.js";
import type { JsonObject } from "../vbrief-build/types.js";
import { type CeremonyDepth, resolveCeremonyDial } from "./ceremony-dial.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/** Policy field for the lane bound, nested under the ceremony dial policy. */
export const FIELD_SMALL_CHANGE_LANE = "plan.policy.ceremonyDial.smallChangeLane";

/** Plan metadata key that records lane membership and the lane-admit base. */
export const SMALL_CHANGE_LANE_MARKER_KEY = "x-directive/smallChangeLane";

/** Schema id of the lane marker. */
export const SMALL_CHANGE_LANE_SCHEMA = "deft.small-change-lane.v1";

/** The one remediation for every lane refusal: lane exit to the full brief shape. */
export const SMALL_CHANGE_LANE_REMEDIATION =
  "Remediation (lane exit, #6204): escalate-to-full-shape. Convert this scope in place " +
  "with escalateThinBriefToFullShape (packages/core/src/intake/thin-brief.ts), or by hand: " +
  "keep plan.id, the issue reference, metadata.swarm.file_scope and plan.acceptance; add " +
  "plan.narratives and plan.items; set " +
  `plan.metadata["${SMALL_CHANGE_LANE_MARKER_KEY}"].state to "escalated". ` +
  "Raising the ceremony dial (escalateCeremonyDial, #3319) does not clear this refusal.";

/** Default production-file cap when the policy field is unset (operator choice, #6204). */
export const SMALL_CHANGE_LANE_DEFAULT_MAX_PRODUCTION_FILES = 5;

/** Default changed-line cap (added + deleted, tests included) when the policy field is unset. */
export const SMALL_CHANGE_LANE_DEFAULT_MAX_CHANGED_LINES = 500;

/** Lane bound. Policy overrides each field; unset fields use the shipped defaults. */
export interface SmallChangeLaneBound {
  readonly maxProductionFiles: number;
  readonly maxChangedLines: number;
}

export type PublicSurfaceDetermination = "none" | "changed" | "unknown";

/** Measured cumulative product diff against a named base. */
export interface SmallChangeLaneMeasurement {
  /** The comparison base (lane-admit base, or the delivered commit's parent). */
  readonly base: string;
  readonly source: "worktree" | "delivered";
  readonly productionFiles: readonly string[];
  readonly changedLines: number;
  readonly publicSurface: PublicSurfaceDetermination;
  readonly publicSurfaceReason: string;
}

export type SmallChangeLaneMeasureResult =
  | { readonly ok: true; readonly measurement: SmallChangeLaneMeasurement }
  | { readonly ok: false; readonly reason: string };

export type SmallChangeLaneVerdictKind =
  | "admitted"
  | "not-rapid"
  | "unconfigured"
  | "unmeasured"
  | "public-surface-unknown"
  | "public-surface-changed"
  | "bound-crossed";

export interface SmallChangeLaneVerdict {
  readonly ok: boolean;
  readonly kind: SmallChangeLaneVerdictKind;
  readonly reason: string;
  readonly measurement: SmallChangeLaneMeasurement | null;
}

export interface EvaluateSmallChangeLaneInput {
  readonly depth: CeremonyDepth;
  readonly bound: SmallChangeLaneBound | null;
  /** Why the bound is null (unset or invalid policy). */
  readonly boundError?: string | null;
  readonly measure: SmallChangeLaneMeasureResult;
}

function verdict(
  kind: SmallChangeLaneVerdictKind,
  reason: string,
  measurement: SmallChangeLaneMeasurement | null,
): SmallChangeLaneVerdict {
  return { ok: kind === "admitted", kind, reason, measurement };
}

/**
 * Pure fail-closed evaluator. Admits only at depth `rapid`, with a valid
 * bound (null means invalid policy), a successful measurement, public surface `none`, and counts at or
 * under the bound. Every other input refuses.
 */
export function evaluateSmallChangeLane(
  input: EvaluateSmallChangeLaneInput,
): SmallChangeLaneVerdict {
  if (input.depth !== "rapid") {
    return verdict(
      "not-rapid",
      `ceremony dial depth is ${input.depth}; the small-change lane admits only at rapid`,
      null,
    );
  }
  if (input.bound === null) {
    const why = input.boundError ?? `${FIELD_SMALL_CHANGE_LANE} is invalid`;
    return verdict("unconfigured", why, null);
  }
  if (!input.measure.ok) {
    return verdict(
      "unmeasured",
      `product diff could not be measured: ${input.measure.reason}`,
      null,
    );
  }
  const m = input.measure.measurement;
  if (m.publicSurface === "unknown") {
    return verdict(
      "public-surface-unknown",
      `public surface could not be determined: ${m.publicSurfaceReason}`,
      m,
    );
  }
  if (m.publicSurface === "changed") {
    return verdict("public-surface-changed", `public surface changed: ${m.publicSurfaceReason}`, m);
  }
  const files = m.productionFiles.length;
  if (files > input.bound.maxProductionFiles || m.changedLines > input.bound.maxChangedLines) {
    return verdict(
      "bound-crossed",
      `bound crossed against ${m.base} (${m.source}): ${files} production file(s) ` +
        `(max ${input.bound.maxProductionFiles}), ${m.changedLines} changed line(s) ` +
        `(max ${input.bound.maxChangedLines})`,
      m,
    );
  }
  return verdict(
    "admitted",
    `within bound against ${m.base} (${m.source}): ${files} production file(s), ` +
      `${m.changedLines} changed line(s), public surface none`,
    m,
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The shipped default bound, used for any field the policy leaves unset. */
export const DEFAULT_SMALL_CHANGE_LANE_BOUND: SmallChangeLaneBound = {
  maxProductionFiles: SMALL_CHANGE_LANE_DEFAULT_MAX_PRODUCTION_FILES,
  maxChangedLines: SMALL_CHANGE_LANE_DEFAULT_MAX_CHANGED_LINES,
};

/**
 * Validate a `plan.policy.ceremonyDial.smallChangeLane` payload. Each field is
 * optional; a present field must be a non-negative integer.
 */
export function validateSmallChangeLaneBound(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_SMALL_CHANGE_LANE} must be an object`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["maxProductionFiles", "maxChangedLines"] as const) {
    if (rec[key] !== undefined && !isNonNegativeInteger(rec[key])) {
      errors.push(`${FIELD_SMALL_CHANGE_LANE}.${key} must be a non-negative integer`);
    }
  }
  return errors;
}

export interface ReadSmallChangeLaneBoundResult {
  readonly bound: SmallChangeLaneBound | null;
  readonly error: string | null;
}

/**
 * Read the bound from a `plan.policy.ceremonyDial` block. Unset fields use the
 * shipped defaults; an invalid value refuses (bound null).
 */
export function readSmallChangeLaneBound(
  ceremonyDialBlock: unknown,
): ReadSmallChangeLaneBoundResult {
  const block =
    ceremonyDialBlock !== null &&
    typeof ceremonyDialBlock === "object" &&
    !Array.isArray(ceremonyDialBlock)
      ? (ceremonyDialBlock as Record<string, unknown>)
      : {};
  const raw = block.smallChangeLane;
  if (raw === undefined || raw === null) {
    return { bound: { ...DEFAULT_SMALL_CHANGE_LANE_BOUND }, error: null };
  }
  const errors = validateSmallChangeLaneBound(raw);
  if (errors.length > 0) {
    return { bound: null, error: errors.join("; ") };
  }
  const rec = raw as Partial<SmallChangeLaneBound>;
  return {
    bound: {
      maxProductionFiles:
        rec.maxProductionFiles ?? DEFAULT_SMALL_CHANGE_LANE_BOUND.maxProductionFiles,
      maxChangedLines: rec.maxChangedLines ?? DEFAULT_SMALL_CHANGE_LANE_BOUND.maxChangedLines,
    },
    error: null,
  };
}

/** Read the bound from the project's PROJECT-DEFINITION policy. */
export function readSmallChangeLaneBoundFromProject(
  projectRoot: string,
): ReadSmallChangeLaneBoundResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { bound: null, error: err ?? "PROJECT-DEFINITION could not be loaded" };
  }
  const policy = readPlanPolicy(data.plan);
  const block =
    policy !== null && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).ceremonyDial
      : undefined;
  return readSmallChangeLaneBound(block);
}

// ---------------------------------------------------------------------------
// Measurement (git)
// ---------------------------------------------------------------------------

export interface GitResult {
  readonly status: number;
  readonly stdout: string;
}

export type SmallChangeLaneGitRunner = (args: readonly string[], cwd: string) => GitResult;

export const defaultSmallChangeLaneGitRunner: SmallChangeLaneGitRunner = (args, cwd) => {
  const r = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    windowsHide: true,
  });
  return { status: r.status ?? 1, stdout: typeof r.stdout === "string" ? r.stdout : "" };
};

/** Lifecycle paths are not product diff (briefs, changelog, framework state). */
export function isLaneLifecyclePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return (
    p === "CHANGELOG.md" ||
    p.startsWith("xbrief/") ||
    p.startsWith("vbrief/") ||
    p.startsWith(".deft/") ||
    p.startsWith(".planning/")
  );
}

/** Test and fixture paths are product diff but not production files or public surface. */
export function isLaneTestPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return isTestOrFixturePath(p) || isRecognizedTestBasename(p);
}

/** Basenames that are public surface by themselves (manifests, entry points, task runners). */
const PUBLIC_SURFACE_BASENAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "cargo.toml",
  "go.mod",
  "taskfile.yml",
  "taskfile.yaml",
  "makefile",
  "justfile",
  "__init__.py",
  "mod.rs",
  "lib.rs",
]);

const BARREL_BASENAME = /^index\.[cm]?[jt]sx?$/i;
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const DOC_EXT = new Set([".md", ".mdx", ".txt", ".rst"]);
const EXPORT_LINE = /^[+-]\s*(export\b|module\.exports\b|exports\.)/;

/** Public-surface class of one production path, before reading its diff. */
export function classifyPublicSurfacePath(relPath: string): "surface" | "code" | "doc" | "unknown" {
  const p = relPath.replace(/\\/g, "/");
  const base = basename(p).toLowerCase();
  if (PUBLIC_SURFACE_BASENAMES.has(base) || BARREL_BASENAME.test(base)) return "surface";
  if (p.startsWith("tasks/") && (base.endsWith(".yml") || base.endsWith(".yaml"))) {
    return "surface";
  }
  const ext = extname(base);
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext)) return "doc";
  return "unknown";
}

interface DiffFileStat {
  readonly path: string;
  /** null when git reports a binary file. */
  readonly lines: number | null;
}

function parseNumstatZ(stdout: string): DiffFileStat[] {
  const out: DiffFileStat[] = [];
  for (const record of stdout.split("\0")) {
    if (record.trim().length === 0) continue;
    const parts = record.replace(/^\n+/, "").split("\t");
    if (parts.length < 3) continue;
    const [added, deleted, ...rest] = parts;
    const path = rest.join("\t");
    if (added === "-" || deleted === "-") {
      out.push({ path, lines: null });
      continue;
    }
    out.push({ path, lines: Number(added) + Number(deleted) });
  }
  return out;
}

/** One code file's changed lines, with base / head line numbers and contents. */
interface CodeFileChange {
  readonly lines: string[];
  /** Base-side (old) line numbers removed or changed. */
  readonly removed: number[];
  /** Head-side (new) line numbers added or changed. */
  readonly added: number[];
  baseText: string | null;
  headText: string | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function lineRange(start: number, count: number): number[] {
  const out: number[] = [];
  for (let n = start; n < start + count; n += 1) out.push(n);
  return out;
}

/** Map each file in a `-U0` diff to its changed lines and hunk line numbers. */
function parseUnifiedDiff(stdout: string): Map<string, CodeFileChange> {
  const byFile = new Map<string, CodeFileChange>();
  let current: CodeFileChange | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = { lines: [], removed: [], added: [], baseText: null, headText: null };
      if (match?.[1] !== undefined) byFile.set(match[1], current);
      continue;
    }
    if (current === null || line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      current.removed.push(...lineRange(Number(hunk[1]), Number(hunk[2] ?? "1")));
      current.added.push(...lineRange(Number(hunk[3]), Number(hunk[4] ?? "1")));
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) current.lines.push(line);
  }
  return byFile;
}

const requireParser = createRequire(import.meta.url);
let cachedTs: typeof TS | null | undefined;

/** Engine-relative TypeScript parser, or null when it cannot load. */
function loadTypeScript(): typeof TS | null {
  if (cachedTs !== undefined) return cachedTs;
  try {
    const mod = requireParser("typescript") as typeof TS | { default?: typeof TS };
    const ts = "createSourceFile" in mod ? mod : mod.default;
    cachedTs = ts !== undefined && typeof ts.createSourceFile === "function" ? ts : null;
  } catch {
    cachedTs = null;
  }
  return cachedTs;
}

function scriptKindFor(ts: typeof TS, path: string): TS.ScriptKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isExportSurfaceStatement(ts: typeof TS, stmt: TS.Statement): boolean {
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return true;
  if (
    ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return true;
  }
  if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
    const left = stmt.expression.left.getText();
    return left.startsWith("module.exports") || left.startsWith("exports.");
  }
  return false;
}

function functionBlockBody(ts: typeof TS, node: TS.Node): TS.Block | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return node.body !== undefined && ts.isBlock(node.body) ? node.body : null;
  }
  return null;
}

/**
 * 1-based lines inside top-level export statements (export lists, exported
 * declarations, CommonJS export assignments), minus the inner lines of
 * function bodies. A changed line in this set changes public surface.
 */
function exportSurfaceLines(ts: typeof TS, text: string, path: string): Set<number> {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, path));
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = new Set<number>();
  for (const stmt of sf.statements) {
    if (!isExportSurfaceStatement(ts, stmt)) continue;
    const excluded = new Set<number>();
    const visit = (node: TS.Node): void => {
      const body = functionBlockBody(ts, node);
      if (body !== null) {
        const open = lineOf(body.getStart(sf));
        const close = lineOf(body.getEnd());
        for (let n = open + 1; n < close; n += 1) excluded.add(n);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(stmt);
    const last = lineOf(stmt.getEnd());
    for (let n = lineOf(stmt.getStart(sf)); n <= last; n += 1) {
      if (!excluded.has(n)) out.add(n);
    }
  }
  return out;
}

function countFileLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

interface PublicSurfaceResult {
  readonly determination: PublicSurfaceDetermination;
  readonly reason: string;
}

function determinePublicSurface(
  productionFiles: readonly string[],
  changesByFile: ReadonlyMap<string, CodeFileChange>,
): PublicSurfaceResult {
  for (const path of productionFiles) {
    if (classifyPublicSurfacePath(path) === "surface") {
      return { determination: "changed", reason: `${path} is a manifest, entry or task file` };
    }
  }
  for (const path of productionFiles) {
    const kind = classifyPublicSurfacePath(path);
    if (kind === "unknown") {
      return {
        determination: "unknown",
        reason: `${path} has no supported public-surface rule`,
      };
    }
    if (kind !== "code") continue;
    const change = changesByFile.get(path);
    if (change === undefined) {
      return { determination: "unknown", reason: `${path} diff lines could not be read` };
    }
    if (change.lines.some((line) => EXPORT_LINE.test(line))) {
      return { determination: "changed", reason: `${path} adds or removes an export` };
    }
    const sides: Array<[readonly number[], string | null, string]> = [
      [change.removed, change.baseText, "base"],
      [change.added, change.headText, "head"],
    ];
    for (const [lineNos, text, side] of sides) {
      if (lineNos.length === 0) continue;
      const ts = loadTypeScript();
      if (ts === null) {
        return { determination: "unknown", reason: "the TypeScript parser could not be loaded" };
      }
      if (text === null) {
        return { determination: "unknown", reason: `${path} ${side} contents could not be read` };
      }
      const surface = exportSurfaceLines(ts, text, path);
      const hit = lineNos.find((n) => surface.has(n));
      if (hit !== undefined) {
        return {
          determination: "changed",
          reason: `${path} changes an export statement (${side} line ${hit})`,
        };
      }
    }
  }
  return { determination: "none", reason: "no manifest, entry, task or export change" };
}

export interface MeasureSmallChangeLaneOptions {
  readonly projectRoot: string;
  /** Lane-admit base for the worktree measure. */
  readonly admitBase: string;
  /**
   * Delivered commit (merge or squash commit). When set, measure that commit
   * against its first parent instead of the worktree against the admit base.
   */
  readonly deliveredCommit?: string | null;
  readonly runGit?: SmallChangeLaneGitRunner;
}

/**
 * Measure the cumulative product diff. Worktree mode diffs the working tree
 * (committed, staged, unstaged and untracked) against the lane-admit base.
 * Delivered mode diffs the delivered commit against its first parent.
 * Any git failure or binary file fails the measurement.
 */
export function measureSmallChangeLaneDiff(
  options: MeasureSmallChangeLaneOptions,
): SmallChangeLaneMeasureResult {
  const run = options.runGit ?? defaultSmallChangeLaneGitRunner;
  // Run from the repository top level so every path is repo-root relative.
  const top = run(["rev-parse", "--show-toplevel"], options.projectRoot);
  if (top.status !== 0 || top.stdout.trim().length === 0) {
    return { ok: false, reason: `${options.projectRoot} is not inside a git work tree` };
  }
  const cwd = top.stdout.trim();
  const delivered = options.deliveredCommit?.trim() ?? "";
  const source: "worktree" | "delivered" = delivered.length > 0 ? "delivered" : "worktree";
  const range = source === "delivered" ? [`${delivered}^1`, delivered] : [options.admitBase.trim()];
  if (range.some((ref) => ref.length === 0)) {
    return { ok: false, reason: "no comparison base" };
  }
  const resolved = run(["rev-parse", "--verify", "--quiet", `${range[0]}^{commit}`], cwd);
  if (resolved.status !== 0 || resolved.stdout.trim().length === 0) {
    return { ok: false, reason: `comparison base ${range[0]} does not resolve to a commit` };
  }
  const base = resolved.stdout.trim();

  const numstat = run(["diff", "--numstat", "-z", "--no-renames", ...range], cwd);
  if (numstat.status !== 0) {
    return { ok: false, reason: `git diff --numstat failed against ${range[0]}` };
  }
  const stats = parseNumstatZ(numstat.stdout);

  const untrackedText = new Map<string, string>();
  if (source === "worktree") {
    const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
    if (untracked.status !== 0) {
      return { ok: false, reason: "git ls-files --others failed" };
    }
    for (const path of untracked.stdout.split("\0")) {
      if (path.length === 0) continue;
      let text: string;
      try {
        text = readFileSync(join(cwd, path), "utf8");
      } catch {
        return { ok: false, reason: `untracked file ${path} could not be read` };
      }
      if (text.includes("\0")) {
        stats.push({ path, lines: null });
        continue;
      }
      untrackedText.set(path, text);
      stats.push({ path, lines: countFileLines(text) });
    }
  }

  const product = stats.filter((s) => !isLaneLifecyclePath(s.path));
  const binary = product.find((s) => s.lines === null);
  if (binary !== undefined) {
    return { ok: false, reason: `${binary.path} is binary; line count is unknown` };
  }
  const changedLines = product.reduce((sum, s) => sum + (s.lines ?? 0), 0);
  const productionFiles = [
    ...new Set(product.filter((s) => !isLaneTestPath(s.path)).map((s) => s.path)),
  ].sort();

  const trackedCode = productionFiles.filter(
    (p) => classifyPublicSurfacePath(p) === "code" && !untrackedText.has(p),
  );
  const changesByFile = new Map<string, CodeFileChange>();
  if (trackedCode.length > 0) {
    const diff = run(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "-U0",
        "--no-color",
        "--no-renames",
        ...range,
        "--",
        ...trackedCode,
      ],
      cwd,
    );
    if (diff.status !== 0) {
      return { ok: false, reason: "git diff -U0 failed for production code files" };
    }
    for (const [path, change] of parseUnifiedDiff(diff.stdout)) {
      if (change.removed.length > 0) {
        const shown = run(["show", `${range[0]}:${path}`], cwd);
        change.baseText = shown.status === 0 ? shown.stdout : null;
      }
      if (change.added.length > 0) {
        if (source === "delivered") {
          const shown = run(["show", `${delivered}:${path}`], cwd);
          change.headText = shown.status === 0 ? shown.stdout : null;
        } else {
          const abs = join(cwd, path);
          change.headText = existsSync(abs) ? readFileSync(abs, "utf8") : null;
        }
      }
      changesByFile.set(path, change);
    }
  }
  for (const [path, text] of untrackedText) {
    const lines = text.split("\n");
    changesByFile.set(path, {
      lines: lines.map((line) => `+${line}`),
      removed: [],
      added: lineRange(1, lines.length),
      baseText: null,
      headText: text,
    });
  }

  const surface = determinePublicSurface(productionFiles, changesByFile);
  return {
    ok: true,
    measurement: {
      base,
      source,
      productionFiles,
      changedLines,
      publicSurface: surface.determination,
      publicSurfaceReason: surface.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Lane marker + gate
// ---------------------------------------------------------------------------

/**
 * admitted → in the lane, bound rechecked at each gate.
 * crossed → the bound was crossed after admit; refused until lane exit,
 *   even if the diff later shrinks.
 * escalated → converted to the full shape; the existing gates govern.
 */
export type SmallChangeLaneState = "admitted" | "crossed" | "escalated";

const SMALL_CHANGE_LANE_STATES: readonly string[] = ["admitted", "crossed", "escalated"];

export interface SmallChangeLaneMarker {
  readonly state: SmallChangeLaneState;
  readonly admitBase: string;
  /** Why the bound was crossed (state `crossed`). */
  readonly crossedReason?: string;
}

export type ReadSmallChangeLaneMarkerResult =
  | { readonly present: false }
  | { readonly present: true; readonly ok: true; readonly marker: SmallChangeLaneMarker }
  | { readonly present: true; readonly ok: false; readonly reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Build the marker the thin-brief emitter writes. */
export function buildSmallChangeLaneMarker(
  admitBase: string,
  state: SmallChangeLaneState = "admitted",
): Record<string, unknown> {
  return { schema: SMALL_CHANGE_LANE_SCHEMA, state, admitBase };
}

/** Read lane membership from `plan.metadata`. */
export function readSmallChangeLaneMarker(plan: unknown): ReadSmallChangeLaneMarkerResult {
  const meta = asRecord(asRecord(plan)?.metadata);
  if (meta === null || !Object.hasOwn(meta, SMALL_CHANGE_LANE_MARKER_KEY)) {
    return { present: false };
  }
  const rec = asRecord(meta[SMALL_CHANGE_LANE_MARKER_KEY]);
  if (rec === null || rec.schema !== SMALL_CHANGE_LANE_SCHEMA) {
    return {
      present: true,
      ok: false,
      reason: `lane marker schema is not ${SMALL_CHANGE_LANE_SCHEMA}`,
    };
  }
  if (typeof rec.state !== "string" || !SMALL_CHANGE_LANE_STATES.includes(rec.state)) {
    return {
      present: true,
      ok: false,
      reason: 'lane marker state must be "admitted", "crossed" or "escalated"',
    };
  }
  const admitBase = typeof rec.admitBase === "string" ? rec.admitBase.trim() : "";
  if (admitBase.length === 0) {
    return { present: true, ok: false, reason: "lane marker has no admitBase" };
  }
  const state = rec.state as SmallChangeLaneState;
  const crossedReason = typeof rec.crossedReason === "string" ? rec.crossedReason : undefined;
  return {
    present: true,
    ok: true,
    marker:
      crossedReason !== undefined ? { state, admitBase, crossedReason } : { state, admitBase },
  };
}

/**
 * Persist a crossing on the brief file so later retries refuse even if the
 * diff shrinks back under the bound. Returns false when the write fails.
 */
export function recordSmallChangeLaneCrossing(
  briefPath: string,
  reason: string,
  projectRoot?: string,
): boolean {
  try {
    const data = JSON.parse(readFileSync(briefPath, "utf8")) as unknown;
    const root = asRecord(data);
    const meta = asRecord(asRecord(root?.plan)?.metadata);
    const marker = asRecord(meta?.[SMALL_CHANGE_LANE_MARKER_KEY]);
    if (root === null || meta === null || marker === null) return false;
    meta[SMALL_CHANGE_LANE_MARKER_KEY] = { ...marker, state: "crossed", crossedReason: reason };
    // Contained temp-then-rename write: a failed save never truncates the brief.
    const written = atomicWriteBrief(briefPath, root as JsonObject, dirname(dirname(briefPath)), {
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    });
    return written.ok;
  } catch {
    return false;
  }
}

/** Full brief representation: at least one narrative with text and at least one plan item. */
export function isFullBriefShape(plan: unknown): boolean {
  const rec = asRecord(plan);
  if (rec === null) return false;
  const narratives = asRecord(rec.narratives);
  const hasNarrative =
    narratives !== null &&
    Object.values(narratives).some((v) => typeof v === "string" && v.trim().length > 0);
  const hasItems = Array.isArray(rec.items) && rec.items.length > 0;
  return hasNarrative && hasItems;
}

export type SmallChangeLaneGateName =
  | "scope:promote"
  | "scope:activate"
  | "xbrief:preflight"
  | "verify:ac"
  | "scope:complete";

/** Test and caller overrides. Production gates pass only `deliveredCommit`. */
export interface SmallChangeLaneGateOverrides {
  readonly depth?: CeremonyDepth;
  readonly bound?: SmallChangeLaneBound | null;
  readonly deliveredCommit?: string | null;
  readonly runGit?: SmallChangeLaneGitRunner;
}

export interface SmallChangeLaneGateOptions extends SmallChangeLaneGateOverrides {
  readonly projectRoot: string;
  readonly gate: SmallChangeLaneGateName;
  /** Brief file; when set, a crossing is recorded on it (state `crossed`). */
  readonly briefPath?: string | null;
}

/** Verdicts that mean the change outgrew the lane after admit. */
const CROSSING_KINDS: ReadonlySet<SmallChangeLaneVerdictKind> = new Set([
  "bound-crossed",
  "public-surface-changed",
]);

export interface SmallChangeLaneGateResult {
  /** False when the brief is not in the lane (no marker); the gate is a no-op. */
  readonly applies: boolean;
  readonly ok: boolean;
  readonly message: string;
  readonly verdict: SmallChangeLaneVerdict | null;
}

function refuse(
  gate: SmallChangeLaneGateName,
  reason: string,
  laneVerdict: SmallChangeLaneVerdict | null,
): SmallChangeLaneGateResult {
  return {
    applies: true,
    ok: false,
    message: `[deft small-change-lane] ${gate} refused (#6204): ${reason}\n  ${SMALL_CHANGE_LANE_REMEDIATION}`,
    verdict: laneVerdict,
  };
}

/**
 * Recheck the lane at a gate that can refuse. No marker → not in the lane, no-op.
 * Admitted marker → measure and evaluate; any refusal names the lane exit.
 * Escalated marker → the scope left the lane; it passes here only once the
 * brief has the full shape, and the existing gates then decide.
 */
export function evaluateSmallChangeLaneGate(
  plan: unknown,
  options: SmallChangeLaneGateOptions,
): SmallChangeLaneGateResult {
  const read = readSmallChangeLaneMarker(plan);
  if (!read.present) {
    return { applies: false, ok: true, message: "", verdict: null };
  }
  if (!read.ok) {
    return refuse(options.gate, read.reason, null);
  }
  if (read.marker.state === "escalated") {
    if (isFullBriefShape(plan)) {
      return {
        applies: true,
        ok: true,
        message: "[deft small-change-lane] scope left the lane; full brief shape applies (#6204)",
        verdict: null,
      };
    }
    return refuse(
      options.gate,
      "lane exit is incomplete: the brief is marked escalated but lacks narratives or items",
      null,
    );
  }
  if (read.marker.state === "crossed") {
    const why = read.marker.crossedReason ?? "bound crossed";
    return refuse(
      options.gate,
      `the bound was crossed after admit (${why}); the scope stays refused until lane exit`,
      null,
    );
  }
  const depth = options.depth ?? resolveCeremonyDial(options.projectRoot).depth;
  const boundRead =
    options.bound !== undefined
      ? {
          bound: options.bound,
          error: options.bound === null ? `${FIELD_SMALL_CHANGE_LANE} is invalid` : null,
        }
      : readSmallChangeLaneBoundFromProject(options.projectRoot);
  const measure = measureSmallChangeLaneDiff({
    projectRoot: options.projectRoot,
    admitBase: read.marker.admitBase,
    deliveredCommit: options.deliveredCommit,
    runGit: options.runGit,
  });
  const laneVerdict = evaluateSmallChangeLane({
    depth,
    bound: boundRead.bound,
    boundError: boundRead.error,
    measure,
  });
  if (!laneVerdict.ok) {
    if (CROSSING_KINDS.has(laneVerdict.kind) && options.briefPath) {
      const recorded = recordSmallChangeLaneCrossing(
        options.briefPath,
        laneVerdict.reason,
        options.projectRoot,
      );
      const note = recorded
        ? "recorded on the brief as crossed"
        : "could not record the crossing on the brief";
      return refuse(options.gate, `${laneVerdict.reason}; ${note}`, laneVerdict);
    }
    return refuse(options.gate, laneVerdict.reason, laneVerdict);
  }
  return {
    applies: true,
    ok: true,
    message: `[deft small-change-lane] ${options.gate}: ${laneVerdict.reason} (#6204)`,
    verdict: laneVerdict,
  };
}
