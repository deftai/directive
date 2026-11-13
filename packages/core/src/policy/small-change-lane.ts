/**
 * Small-change lane under the rapid ceremony dial (#6204).
 *
 * One fail-closed evaluator next to the ceremony dial policy. A thin brief
 * (see `intake/thin-brief.ts`) stays in the lane only while:
 *   - the ceremony dial depth is `rapid`;
 *   - the operator configured the bound at `plan.policy.ceremonyDial.smallChangeLane`
 *     (`maxProductionFiles`, `maxChangedLines`). There is no code default: an
 *     unset bound refuses;
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
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { isTestOrFixturePath } from "../scope-provenance/base-fence.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { isRecognizedTestBasename } from "../test-boundary/evaluate.js";
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

/** Operator-set bound. Both values are policy values; there is no code default. */
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
 * Pure fail-closed evaluator. Admits only at depth `rapid`, with a configured
 * bound, a successful measurement, public surface `none`, and counts at or
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
    const why = input.boundError ?? `${FIELD_SMALL_CHANGE_LANE} is not set`;
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

/** Validate a `plan.policy.ceremonyDial.smallChangeLane` payload. */
export function validateSmallChangeLaneBound(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_SMALL_CHANGE_LANE} must be an object`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if (!isNonNegativeInteger(rec.maxProductionFiles)) {
    errors.push(`${FIELD_SMALL_CHANGE_LANE}.maxProductionFiles must be a non-negative integer`);
  }
  if (!isNonNegativeInteger(rec.maxChangedLines)) {
    errors.push(`${FIELD_SMALL_CHANGE_LANE}.maxChangedLines must be a non-negative integer`);
  }
  return errors;
}

export interface ReadSmallChangeLaneBoundResult {
  readonly bound: SmallChangeLaneBound | null;
  readonly error: string | null;
}

/** Read the bound from a `plan.policy.ceremonyDial` block. Unset or invalid → null. */
export function readSmallChangeLaneBound(
  ceremonyDialBlock: unknown,
): ReadSmallChangeLaneBoundResult {
  if (
    ceremonyDialBlock === null ||
    typeof ceremonyDialBlock !== "object" ||
    Array.isArray(ceremonyDialBlock)
  ) {
    return { bound: null, error: `${FIELD_SMALL_CHANGE_LANE} is not set` };
  }
  const raw = (ceremonyDialBlock as Record<string, unknown>).smallChangeLane;
  if (raw === undefined || raw === null) {
    return { bound: null, error: `${FIELD_SMALL_CHANGE_LANE} is not set` };
  }
  const errors = validateSmallChangeLaneBound(raw);
  if (errors.length > 0) {
    return { bound: null, error: errors.join("; ") };
  }
  const rec = raw as SmallChangeLaneBound;
  return {
    bound: { maxProductionFiles: rec.maxProductionFiles, maxChangedLines: rec.maxChangedLines },
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

/** Map each file in a `-U0` diff to its added/removed lines. */
function parseUnifiedDiffLines(stdout: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = [];
      if (match?.[1] !== undefined) byFile.set(match[1], current);
      continue;
    }
    if (current === null || line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) current.push(line);
  }
  return byFile;
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
  changedLinesByFile: ReadonlyMap<string, readonly string[]>,
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
    const lines = changedLinesByFile.get(path);
    if (lines === undefined) {
      return { determination: "unknown", reason: `${path} diff lines could not be read` };
    }
    if (lines.some((line) => EXPORT_LINE.test(line))) {
      return { determination: "changed", reason: `${path} adds or removes an export` };
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
  const changedLinesByFile = new Map<string, readonly string[]>();
  if (trackedCode.length > 0) {
    const diff = run(
      ["diff", "-U0", "--no-color", "--no-renames", ...range, "--", ...trackedCode],
      cwd,
    );
    if (diff.status !== 0) {
      return { ok: false, reason: "git diff -U0 failed for production code files" };
    }
    for (const [path, lines] of parseUnifiedDiffLines(diff.stdout)) {
      changedLinesByFile.set(path, lines);
    }
  }
  for (const [path, text] of untrackedText) {
    changedLinesByFile.set(
      path,
      text.split("\n").map((line) => `+${line}`),
    );
  }

  const surface = determinePublicSurface(productionFiles, changedLinesByFile);
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

export type SmallChangeLaneState = "admitted" | "escalated";

export interface SmallChangeLaneMarker {
  readonly state: SmallChangeLaneState;
  readonly admitBase: string;
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
  if (rec.state !== "admitted" && rec.state !== "escalated") {
    return {
      present: true,
      ok: false,
      reason: 'lane marker state must be "admitted" or "escalated"',
    };
  }
  const admitBase = typeof rec.admitBase === "string" ? rec.admitBase.trim() : "";
  if (admitBase.length === 0) {
    return { present: true, ok: false, reason: "lane marker has no admitBase" };
  }
  return { present: true, ok: true, marker: { state: rec.state, admitBase } };
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

export type SmallChangeLaneGateName = "xbrief:preflight" | "verify:ac" | "scope:complete";

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
}

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
  const depth = options.depth ?? resolveCeremonyDial(options.projectRoot).depth;
  const boundRead =
    options.bound !== undefined
      ? {
          bound: options.bound,
          error: options.bound === null ? `${FIELD_SMALL_CHANGE_LANE} is not set` : null,
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
    return refuse(options.gate, laneVerdict.reason, laneVerdict);
  }
  return {
    applies: true,
    ok: true,
    message: `[deft small-change-lane] ${options.gate}: ${laneVerdict.reason} (#6204)`,
    verdict: laneVerdict,
  };
}
