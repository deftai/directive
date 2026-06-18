import { type PathLike, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AllocationFields,
  type ParsedAllocation,
  parseAllocationSection,
  SOLO_KIND,
  SWARM_COHORT_KIND,
  VALID_DISPATCH_KINDS,
} from "./allocation.js";

export const ACTIVE_FOLDER = "active";
export const ELIGIBLE_STATUS = "running";

/** Result of story-start Gate 0 evaluation; mirrors the Python `(exit_code, message)` tuple. */
export interface EvaluateResult {
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
  readonly dispatchKind: string | null;
}

export interface EvaluateOptions {
  readonly gitStatus?: string | null;
  readonly allocationContext?: string | null;
  readonly allowDirty?: boolean;
  readonly parsed?: ParsedAllocation;
}

function checkVbrief(vbriefPath: PathLike): { ok: true } | { ok: false; reason: string } {
  let path: string;
  try {
    path = resolve(String(vbriefPath));
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `could not interpret vBRIEF path '${String(vbriefPath)}': ${String(err)}`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ok: false, reason: `target vBRIEF not found at ${path}` };
    }
    return {
      ok: false,
      reason: `could not read target vBRIEF at ${path}: ${String(e.message ?? err)}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    const e = err as SyntaxError & { lineNumber?: number };
    const line = typeof e.lineNumber === "number" ? e.lineNumber : "?";
    return {
      ok: false,
      reason: `target vBRIEF at ${path} is not valid JSON: ${e.message} (line ${line})`,
    };
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: `target vBRIEF at ${path} top-level value is not a JSON object` };
  }

  const folder = path.split(/[/\\]/).slice(-2, -1)[0] ?? "";
  if (folder !== ACTIVE_FOLDER) {
    return {
      ok: false,
      reason:
        `target vBRIEF is in ${folder}/ -- only vbrief/active/ is eligible ` +
        `for a story start (activate it via \`task scope:activate -- ${path}\`)`,
    };
  }

  const plan = (payload as Record<string, unknown>).plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return { ok: false, reason: `target vBRIEF at ${path} lacks a \`plan\` object -- malformed` };
  }

  const status = (plan as Record<string, unknown>).status;
  if (typeof status !== "string" || status.length === 0) {
    return { ok: false, reason: `target vBRIEF at ${path} lacks \`plan.status\` -- malformed` };
  }

  if (status !== ELIGIBLE_STATUS) {
    return {
      ok: false,
      reason:
        `target vBRIEF plan.status is '${status}' -- only '${ELIGIBLE_STATUS}' ` +
        "is eligible for a story start",
    };
  }

  return { ok: true };
}

function readyMessage(treeNote: string, suffix: string): string {
  return `OK: ready to start -- ${treeNote}, vBRIEF active+running, ${suffix}`;
}

function classifyAllocation(fields: AllocationFields, treeNote: string): EvaluateResult {
  const dispatchKind = fields.dispatch_kind ?? null;
  if (!("dispatch_kind" in fields) || dispatchKind === null) {
    return {
      exitCode: 2,
      dispatchKind: null,
      message:
        "config error: `## Allocation context` section is present but has no " +
        "`dispatch_kind` field -- cannot classify the dispatch (Story A schema " +
        "requires dispatch_kind: solo | swarm-cohort).",
    };
  }
  if (!VALID_DISPATCH_KINDS.has(dispatchKind)) {
    return {
      exitCode: 2,
      dispatchKind,
      message:
        `config error: unrecognised dispatch_kind '${dispatchKind}' -- ` +
        `expected one of ${[...VALID_DISPATCH_KINDS].sort().join(", ")}.`,
    };
  }

  if (dispatchKind === SOLO_KIND) {
    return {
      exitCode: 0,
      dispatchKind,
      message: readyMessage(treeNote, "dispatch_kind: solo."),
    };
  }

  const incomplete = (["allocation_plan_id", "batching_rationale"] as const).filter(
    (name) => fields[name] === null || fields[name] === undefined,
  );
  if (incomplete.length > 0) {
    return {
      exitCode: 1,
      dispatchKind,
      message:
        "not ready: swarm-cohort dispatch has an incomplete consent token -- " +
        `null or missing ${incomplete.join(", ")}. A swarm-cohort start gate ` +
        "requires a non-null allocation_plan_id AND batching_rationale (#1371 carve-out).",
    };
  }

  return {
    exitCode: 0,
    dispatchKind,
    message: readyMessage(
      treeNote,
      "swarm-cohort consent token satisfied (allocation_plan_id + batching_rationale present).",
    ),
  };
}

/**
 * Pure evaluator — returns exit code + human message. Faithful to
 * `scripts/preflight_story_start.evaluate`.
 */
export function evaluate(vbriefPath: PathLike, options: EvaluateOptions = {}): EvaluateResult {
  const gitStatus = options.gitStatus ?? null;
  const allowDirty = options.allowDirty ?? false;

  if (gitStatus === null) {
    return {
      exitCode: 2,
      dispatchKind: null,
      message:
        "config error: could not determine working-tree state -- is this a " +
        "git work tree and is git on PATH? (Gate 0 fails closed.)",
    };
  }

  const dirty = gitStatus.trim().length > 0;
  if (dirty && !allowDirty) {
    return {
      exitCode: 1,
      dispatchKind: null,
      message:
        "not ready: working tree is dirty. Commit, stash, or include the " +
        "existing work (re-run with --allow-dirty after operator approval) " +
        "before starting the story.",
    };
  }

  const treeNote = dirty ? "dirty tree allowed (--allow-dirty)" : "tree clean";

  const vbriefCheck = checkVbrief(vbriefPath);
  if (!vbriefCheck.ok) {
    return {
      exitCode: 1,
      dispatchKind: null,
      message: `not ready: ${vbriefCheck.reason}.`,
    };
  }

  const [found, fields] =
    options.parsed ?? parseAllocationSection(options.allocationContext ?? null);

  if (!found) {
    return {
      exitCode: 0,
      dispatchKind: null,
      message: readyMessage(
        treeNote,
        "no `## Allocation context` section (solo path, #1371 carve-out).",
      ),
    };
  }

  return classifyAllocation(fields, treeNote);
}

export { parseAllocationSection, SOLO_KIND, SWARM_COHORT_KIND };
