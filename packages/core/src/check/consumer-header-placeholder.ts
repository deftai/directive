/**
 * Check-surface runner for the first-ship AGENTS header placeholder gate (#4544).
 *
 * Product-mutation completion is the durable
 * `.deft/cache/product-mutation-completion.json` marker written on intentional
 * markWrite (survives release). Occupancy last_write_at alone is not enough.
 * Exact unmanaged-header one-liner only; Process-only and custom headers pass.
 * Unreadable/malformed Prefer-A marker fails closed (not Process-only).
 *
 * Residual after #5178: completion-chokepoint coverage stamps the Prefer-A
 * marker, remediates via confirmed-Overview CAS when available, then evaluates
 * so refuse conjuncts are reached without depending on the agent remembering
 * to stamp or invoke check / verify:consumer-header-placeholder by name.
 *
 * Residual after #5253 (Prefer-A Bound lean 6000271029): pin 7c775edf had only
 * two production enforce callers (delivered codeBearing scope:complete;
 * occupancy persistProductMutationMarker=true). Dirty/untracked product paths
 * are additional this-session product-mutation evidence for weak stacks that
 * skip those callers (hookless / Shell-bypass / no-marker exits). Process-only
 * stays legal when neither marker nor dirty product paths exist.
 * Returned failure — no throw.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  compareAndSetConsumerHeaderOneLiner,
  evaluateFirstShipHeaderPlaceholderGate,
  type FirstShipHeaderPlaceholderResult,
  type HeaderOneLinerCasReason,
} from "../platform/agents-consumer-header.js";
import {
  lookupProductMutationCompletion,
  type RecordProductMutationCompletionResult,
  recordProductMutationCompletion,
} from "./product-mutation-completion.js";

export const CONSUMER_HEADER_PLACEHOLDER_GATE_ID = "verify:consumer-header-placeholder";

export const CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID =
  "consumer-header-placeholder-completion-chokepoint";

export const CONSUMER_HEADER_COMPLETION_CHOKEPOINT_REMEDY =
  "confirm Overview then compareAndSetConsumerHeaderOneLiner (setup Phase 3); " +
  "leave custom headers untouched; Process-only exits may keep the placeholder";

export type AgentsMdReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "unreadable"; readonly detail: string };

export interface ConsumerHeaderPlaceholderSeams {
  readonly readAgentsMd?: () => AgentsMdReadResult | string | null;
  /** Test seam: force product-mutation boolean; skips durable-marker lookup. */
  readonly sessionChangedProductFiles?: boolean;
  /**
   * Test seam: force dirty-product evidence for reachability (#4544 residual).
   * When set, skips git porcelain. undefined → probe the worktree.
   */
  readonly dirtyProductEvidence?: boolean;
  /** Test seam: inject `git status --porcelain` (null = probe unknown). */
  readonly gitPorcelain?: string | null;
}

export interface CompletionChokepointSeams {
  /** Override Overview used for CAS remediation (skips PROJECT-DEFINITION read). */
  readonly confirmedOverview?: string | null;
  /** Test seam: skip durable marker stamp (evaluate as already product-complete). */
  readonly skipMarkerStamp?: boolean;
  /** When false, CAS computes but does not write AGENTS.md. Default true. */
  readonly applyRemediationWrite?: boolean;
  readonly recordedAt?: Date;
  readonly readAgentsMd?: () => AgentsMdReadResult | string | null;
}

export type ConsumerHeaderCompletionChokepointResult = {
  readonly ok: boolean;
  readonly evaluation: FirstShipHeaderPlaceholderResult;
  readonly message: string;
  readonly marker:
    | RecordProductMutationCompletionResult
    | { readonly ok: true; readonly skipped: true };
  readonly remediation: {
    readonly attempted: boolean;
    readonly overviewAvailable: boolean;
    readonly casReason?: HeaderOneLinerCasReason;
    readonly wroteAgentsMd: boolean;
  };
};

/** Deposit / Process-only path prefixes — not first-ship product evidence. */
const NON_PRODUCT_PATH_PREFIXES = [
  ".deft/",
  ".deft-scratch/",
  ".deft-cache/",
  "xbrief/",
  "vbrief/",
  ".git/",
  "node_modules/",
  "dist/",
  "coverage/",
  ".planning/",
  "temp/",
  ".cursor/",
  ".claude/",
  ".codex/",
  ".github/",
] as const;

const NON_PRODUCT_BASENAMES = new Set([
  "AGENTS.md",
  "Agents.md",
  "CLAUDE.md",
  "USER.md",
  ".gitignore",
  ".gitattributes",
  ".no-deft-directive",
  ".deft-directive-disable",
  ".deft-run-summary.json",
  // package.json / lockfiles ARE product evidence (#4544 Greptile P1): dependency-
  // only sessions must not Process-only-pass scaffold edit-me.
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
]);

/**
 * Greenfield smoke docs-impact body fixtures live only at the consumer root.
 * Exact root paths stay Process-only so smoke stays Class-1-safe without an
 * Overview seed in greenfield-python-free-smoke.ts; nested paths such as
 * `src/docs-impact-valid.md` remain product evidence (#4544 Greptile P1).
 */
const ROOT_ONLY_NON_PRODUCT_PATHS = new Set(["docs-impact-invalid.md", "docs-impact-valid.md"]);

function toPosixRel(rel: string): string {
  // Git porcelain already uses `/`. On POSIX a literal `\` in a filename is
  // valid; rewriting it to `/` would false-match deposit prefixes (e.g.
  // `xbrief\app.ts` → `xbrief/…`). Only normalize separators on win32.
  const normalized = process.platform === "win32" ? rel.replace(/\\/g, "/") : rel;
  return normalized.replace(/^\.\//, "");
}

/** True when a relative path is deposit / Process-only, not product evidence. */
export function isNonProductMutationPath(relPath: string): boolean {
  const posix = toPosixRel(relPath);
  if (posix.length === 0 || posix === ".") return true;
  if (ROOT_ONLY_NON_PRODUCT_PATHS.has(posix)) return true;
  const base = posix.includes("/") ? posix.slice(posix.lastIndexOf("/") + 1) : posix;
  if (NON_PRODUCT_BASENAMES.has(base)) return true;
  return NON_PRODUCT_PATH_PREFIXES.some(
    (prefix) => posix === prefix.slice(0, -1) || posix.startsWith(prefix),
  );
}

type PorcelainEntry = { readonly xy: string; readonly path: string };

/** Strip git porcelain C-style quoting so path classifiers see real paths. */
function unquotePorcelainPath(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') {
    return path;
  }
  return path.slice(1, -1).replace(/\\([\\"ntr])/g, (_m, c: string) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c === "r") return "\r";
    return c;
  });
}

function parsePorcelainEntries(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const raw of stdout.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.length < 4) continue;
    const xy = raw.slice(0, 2);
    // XY<space>path  or  XY<space>old -> new
    const entry = raw.slice(3);
    if (entry.includes(" -> ")) {
      const renamed = entry.split(" -> ").pop();
      if (renamed !== undefined && renamed.length > 0) {
        entries.push({ xy, path: unquotePorcelainPath(renamed) });
      }
    } else if (entry.length > 0) {
      entries.push({ xy, path: unquotePorcelainPath(entry) });
    }
  }
  return entries;
}

function parsePorcelainPaths(stdout: string): string[] {
  return parsePorcelainEntries(stdout).map((e) => e.path);
}

function readGitPorcelainAtRoot(projectRoot: string): string | null {
  try {
    const result = spawnSync("git", ["status", "--porcelain", "-uall"], {
      cwd: resolve(projectRoot),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return null;
  }
}

export type DirtyProductEvidenceProbe =
  | { readonly kind: "dirty" }
  | { readonly kind: "clean" }
  | { readonly kind: "unknown"; readonly detail: string };

/**
 * Product-mutation evidence beyond Prefer-A marker (#4544 residual).
 * Any dirty/untracked porcelain path outside deposit/Process-only prefixes —
 * catches hookless / Shell-bypass product writes (including tracked edits) that
 * never stamped persistProductMutationMarker. Clean trees stay Process-only.
 * Probe `unknown` (git unavailable) is returned distinctly so callers can
 * choose fail-closed check vs non-stranding occupancy release.
 */
export function probeDirtyProductMutationEvidence(
  projectRoot: string,
  seams: { readonly dirtyProductEvidence?: boolean; readonly gitPorcelain?: string | null } = {},
): DirtyProductEvidenceProbe {
  if (seams.dirtyProductEvidence !== undefined) {
    return seams.dirtyProductEvidence ? { kind: "dirty" } : { kind: "clean" };
  }
  const porcelain =
    seams.gitPorcelain !== undefined ? seams.gitPorcelain : readGitPorcelainAtRoot(projectRoot);
  if (porcelain === null) {
    return {
      kind: "unknown",
      detail: "git status unavailable; cannot classify dirty product evidence",
    };
  }
  for (const rel of parsePorcelainPaths(porcelain)) {
    if (!isNonProductMutationPath(rel)) return { kind: "dirty" };
  }
  return { kind: "clean" };
}

/** True when probe reports dirty; unknown/clean are false (callers must handle unknown). */
export function hasDirtyProductMutationEvidence(
  projectRoot: string,
  seams: { readonly dirtyProductEvidence?: boolean; readonly gitPorcelain?: string | null } = {},
): boolean {
  return probeDirtyProductMutationEvidence(projectRoot, seams).kind === "dirty";
}

function readAgentsMdAtRoot(projectRoot: string): AgentsMdReadResult {
  const path = join(projectRoot, "AGENTS.md");
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "ok", text: readFileSync(path, "utf8") };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "unreadable", detail };
  }
}

function normalizeAgentsMdSeam(value: AgentsMdReadResult | string | null): AgentsMdReadResult {
  if (value === null) return { kind: "missing" };
  if (typeof value === "string") return { kind: "ok", text: value };
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeNarrativeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Selected PROJECT-DEFINITION only — no cross-artifact Overview fallthrough.
 * DEFT_PROJECT_PATH (when set) wins; else xbrief; else vbrief. Empty Overview
 * on the selected file refuses (null); never read a sibling layout (#4544 P1).
 */
function selectedProjectDefinitionPath(projectRoot: string): string | null {
  const root = resolve(projectRoot);
  const override = process.env.DEFT_PROJECT_PATH?.trim();
  if (override) {
    const configured = resolve(projectRoot, override);
    return existsSync(configured) ? configured : null;
  }
  const migrated = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  if (existsSync(migrated)) return migrated;
  const legacy = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
  if (existsSync(legacy)) return legacy;
  return null;
}

function overviewFromProjectDefinitionFile(path: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const root = asRecord(parsed);
    const plan = asRecord(root?.plan);
    const narratives = asRecord(plan?.narratives);
    if (narratives === null) return null;
    for (const [key, value] of Object.entries(narratives)) {
      if (normalizeNarrativeKey(key) !== "overview") continue;
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Confirmed Overview from the selected PROJECT-DEFINITION only (setup Phase 3).
 * Empty / missing Overview on that artifact returns null — refuse path, not a
 * soft pass via another layout's narratives (#4544 residual / Greptile P1).
 */
export function readConfirmedOverviewAtRoot(projectRoot: string): string | null {
  const selected = selectedProjectDefinitionPath(projectRoot);
  if (selected === null) return null;
  return overviewFromProjectDefinitionFile(selected);
}

/** Evaluate the Prefer-A first-ship placeholder gate at a project root. */
export function evaluateConsumerHeaderPlaceholderAtRoot(
  projectRoot: string,
  seams: ConsumerHeaderPlaceholderSeams = {},
): FirstShipHeaderPlaceholderResult {
  const agentsRead = seams.readAgentsMd
    ? normalizeAgentsMdSeam(seams.readAgentsMd())
    : readAgentsMdAtRoot(projectRoot);
  if (agentsRead.kind === "unreadable") {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: null,
      productMutationCompletion: seams.sessionChangedProductFiles === true,
      agentsMdUnreadable: true,
    });
  }

  if (seams.sessionChangedProductFiles !== undefined) {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
      productMutationCompletion: seams.sessionChangedProductFiles,
    });
  }

  const marker = lookupProductMutationCompletion(projectRoot);
  if (marker.kind === "unreadable") {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
      productMutationCompletion: false,
      productMutationMarkerUnreadable: true,
      productMutationMarkerDetail: marker.detail,
    });
  }

  if (marker.kind === "present") {
    return evaluateFirstShipHeaderPlaceholderGate({
      agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
      productMutationCompletion: true,
    });
  }

  // #4544 residual after #5253: dirty/untracked product paths are evidence for
  // stacks that skipped occupancy persistProductMutationMarker / delivered
  // complete. Reuse enforce (stamp + Overview CAS); do not invent a second
  // evaluator. Git probe unknown → Process-only (cannot prove product dirt;
  // Prefer-A marker still fail-closes when present/unreadable).
  const dirtyProbe = probeDirtyProductMutationEvidence(projectRoot, {
    dirtyProductEvidence: seams.dirtyProductEvidence,
    gitPorcelain: seams.gitPorcelain,
  });
  if (dirtyProbe.kind === "dirty") {
    const chokepoint = enforceConsumerHeaderPlaceholderAtCompletionChokepoint(projectRoot, {
      readAgentsMd: seams.readAgentsMd,
    });
    return chokepoint.evaluation;
  }

  return evaluateFirstShipHeaderPlaceholderGate({
    agentsMd: agentsRead.kind === "ok" ? agentsRead.text : null,
    productMutationCompletion: false,
  });
}

function writeAgentsMdAtRoot(
  projectRoot: string,
  text: string,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const root = resolve(projectRoot);
  const target = join(root, "AGENTS.md");
  try {
    containedWrite({
      root,
      target,
      data: text.endsWith("\n") ? text : `${text}\n`,
      mode: "replace",
      mkdir: false,
    });
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail };
  }
}

/**
 * Fail-closed completion chokepoint after Prefer-A #5178 (#4544 residual).
 *
 * Arms the durable Prefer-A marker, remediates exact scaffold edit-me via
 * confirmed-Overview CAS when Overview is available, then evaluates the
 * Prefer-A check-surface gate. Process-only callers must not invoke this —
 * only product-mutation / delivered-completion paths.
 */
export function enforceConsumerHeaderPlaceholderAtCompletionChokepoint(
  projectRoot: string,
  seams: CompletionChokepointSeams = {},
): ConsumerHeaderCompletionChokepointResult {
  const root = resolve(projectRoot);
  let marker: ConsumerHeaderCompletionChokepointResult["marker"];
  if (seams.skipMarkerStamp === true) {
    marker = { ok: true, skipped: true };
  } else {
    const recorded = recordProductMutationCompletion(root, seams.recordedAt ?? new Date());
    if (!recorded.ok) {
      const message =
        `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: Prefer-A product-mutation ` +
        `marker write failed (${recorded.error}); remedy: retry the gated product write`;
      return {
        ok: false,
        evaluation: {
          ok: false,
          reason: "product-mutation-marker-unreadable",
          message,
        },
        message,
        marker: recorded,
        remediation: {
          attempted: false,
          overviewAvailable: false,
          wroteAgentsMd: false,
        },
      };
    }
    marker = recorded;
  }

  const evalSeams: ConsumerHeaderPlaceholderSeams = {
    readAgentsMd: seams.readAgentsMd,
    sessionChangedProductFiles: seams.skipMarkerStamp === true ? true : undefined,
  };
  let evaluation = evaluateConsumerHeaderPlaceholderAtRoot(root, evalSeams);
  if (evaluation.ok) {
    return {
      ok: true,
      evaluation,
      message: evaluation.message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: false,
        wroteAgentsMd: false,
      },
    };
  }

  if (
    evaluation.reason !== "placeholder-with-product-mutation" &&
    evaluation.reason !== "product-mutation-marker-unreadable"
  ) {
    return {
      ok: false,
      evaluation,
      message: evaluation.message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: false,
        wroteAgentsMd: false,
      },
    };
  }

  const overview =
    seams.confirmedOverview !== undefined
      ? seams.confirmedOverview !== null && seams.confirmedOverview.trim().length > 0
        ? seams.confirmedOverview.trim()
        : null
      : readConfirmedOverviewAtRoot(root);

  if (overview === null) {
    const message =
      `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: unmanaged AGENTS.md header ` +
      `still equals scaffold edit-me after product-mutation completion and confirmed ` +
      `Overview is unavailable; remedy: ${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_REMEDY}`;
    return {
      ok: false,
      evaluation: {
        ok: false,
        reason: "placeholder-with-product-mutation",
        message,
      },
      message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: false,
        wroteAgentsMd: false,
      },
    };
  }

  const agentsRead = seams.readAgentsMd
    ? normalizeAgentsMdSeam(seams.readAgentsMd())
    : readAgentsMdAtRoot(root);
  if (agentsRead.kind !== "ok") {
    return {
      ok: false,
      evaluation,
      message: evaluation.message,
      marker,
      remediation: {
        attempted: false,
        overviewAvailable: true,
        wroteAgentsMd: false,
      },
    };
  }

  const cas = compareAndSetConsumerHeaderOneLiner({
    agentsMd: agentsRead.text,
    confirmedOverview: overview,
  });
  let wroteAgentsMd = false;
  if (cas.changed && seams.applyRemediationWrite !== false) {
    // Re-read at write time so a concurrent AGENTS.md edit is not overwritten
    // by CAS computed from the earlier snapshot (#4544 Greptile P1).
    const freshRead = seams.readAgentsMd
      ? normalizeAgentsMdSeam(seams.readAgentsMd())
      : readAgentsMdAtRoot(root);
    if (freshRead.kind !== "ok" || freshRead.text !== agentsRead.text) {
      const detail =
        freshRead.kind === "ok"
          ? "AGENTS.md changed after the CAS snapshot"
          : freshRead.kind === "missing"
            ? "AGENTS.md missing at write time"
            : `AGENTS.md unreadable at write time (${freshRead.detail})`;
      const message =
        `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: Overview CAS computed but ` +
        `${detail}; remedy: retry completion after resolving the concurrent edit`;
      return {
        ok: false,
        evaluation: {
          ok: false,
          reason: "placeholder-with-product-mutation",
          message,
        },
        message,
        marker,
        remediation: {
          attempted: true,
          overviewAvailable: true,
          casReason: cas.reason,
          wroteAgentsMd: false,
        },
      };
    }
    const written = writeAgentsMdAtRoot(root, cas.agentsMd);
    if (!written.ok) {
      const message =
        `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: Overview CAS computed but ` +
        `AGENTS.md write failed (${written.error}); remedy: fix permissions then retry`;
      return {
        ok: false,
        evaluation: {
          ok: false,
          reason: "placeholder-with-product-mutation",
          message,
        },
        message,
        marker,
        remediation: {
          attempted: true,
          overviewAvailable: true,
          casReason: cas.reason,
          wroteAgentsMd: false,
        },
      };
    }
    wroteAgentsMd = true;
  }

  evaluation = evaluateConsumerHeaderPlaceholderAtRoot(root, evalSeams);
  if (!evaluation.ok) {
    const message =
      evaluation.reason === "placeholder-with-product-mutation"
        ? `${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID} FAIL: ${evaluation.message}; ` +
          `CAS reason=${cas.reason}; remedy: ${CONSUMER_HEADER_COMPLETION_CHOKEPOINT_REMEDY}`
        : evaluation.message;
    return {
      ok: false,
      evaluation:
        evaluation.reason === "placeholder-with-product-mutation"
          ? { ...evaluation, message }
          : evaluation,
      message,
      marker,
      remediation: {
        attempted: true,
        overviewAvailable: true,
        casReason: cas.reason,
        wroteAgentsMd,
      },
    };
  }

  return {
    ok: true,
    evaluation,
    message: evaluation.message,
    marker,
    remediation: {
      attempted: true,
      overviewAvailable: true,
      casReason: cas.reason,
      wroteAgentsMd,
    },
  };
}

/**
 * Reachability wrapper: enforce when Prefer-A marker or dirty product evidence
 * shows product mutation; skip (Process-only legal) when neither is present.
 */
export function enforceConsumerHeaderPlaceholderWhenProductEvidence(
  projectRoot: string,
  seams: CompletionChokepointSeams & {
    readonly dirtyProductEvidence?: boolean;
    readonly gitPorcelain?: string | null;
  } = {},
):
  | ConsumerHeaderCompletionChokepointResult
  | { readonly ok: true; readonly skipped: true; readonly reason: "no-product-evidence" } {
  const marker = lookupProductMutationCompletion(projectRoot);
  const dirtyProbe = probeDirtyProductMutationEvidence(projectRoot, {
    dirtyProductEvidence: seams.dirtyProductEvidence,
    gitPorcelain: seams.gitPorcelain,
  });
  // Git unavailable must not strand occupancy:release when no Prefer-A marker
  // proves product mutation (#4544 P1). Unknown ≡ no proven product evidence.
  const dirty = dirtyProbe.kind === "dirty";
  if (marker.kind !== "present" && marker.kind !== "unreadable" && !dirty) {
    return { ok: true, skipped: true, reason: "no-product-evidence" };
  }
  return enforceConsumerHeaderPlaceholderAtCompletionChokepoint(projectRoot, seams);
}
