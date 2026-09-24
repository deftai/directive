/**
 * Explicit bind of selected clauses onto an approved file_scope path (#4986).
 *
 * Promote leave-null for pathless clauses is intentional. Before stamp, the
 * human/bind selector names which clauses must be proven by a test and which
 * approved file_scope member they bind to. Empty file_scope is a silent no-op.
 * Paths are never lifted from issue or comment text (#3835).
 */

import { dirname } from "node:path";
import {
  type AcceptanceClause,
  isBindableMatchAnyFilePointer,
  readAcceptanceClauses,
  readDeclaredArtifactScope,
} from "../verify-ac/clauses.js";
import { atomicWriteBrief, readBriefForMutation } from "./brief-io.js";
import { resolveProjectRoot } from "./project-context.js";

export const BIND_CLAUSE_ACTION = "bind-clause" as const;
export const BIND_CLAUSE_VERB = "scope:bind-clause" as const;

export interface BindClauseOnBriefOptions {
  readonly projectRoot?: string;
  /** Repo-relative path taken only from approved declared file_scope. */
  readonly path: string;
  /** Clause ids selected as must-be-proven-by-a-test. */
  readonly clauseIds: readonly number[];
}

export interface BindClauseOnBriefResult {
  readonly ok: boolean;
  readonly message: string;
  readonly boundIds: readonly number[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function normalizePointer(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function applyPathToClause(
  clause: AcceptanceClause,
  pointer: string,
): { readonly clause: AcceptanceClause; readonly changed: boolean } {
  let changed = clause.artifact_path !== pointer;
  const readings = clause.readings;
  if (readings === undefined || readings.length === 0) {
    return {
      changed,
      clause: changed ? { ...clause, artifact_path: pointer } : clause,
    };
  }
  const chosen = clause.chosen_reading ?? 0;
  const nextReadings = readings.map((reading, index) => {
    if (index !== chosen) {
      return reading;
    }
    if (reading.artifact_path === pointer) {
      return reading;
    }
    changed = true;
    return { ...reading, artifact_path: pointer };
  });
  return {
    changed,
    clause: {
      ...clause,
      artifact_path: pointer,
      readings: nextReadings,
      chosen_reading: chosen,
    },
  };
}

/**
 * In-memory explicit bind. Empty declared scope returns ok/unchanged.
 * Unknown clause ids and out-of-scope paths refuse.
 */
export function bindSelectedClausesToDeclaredPath(
  plan: Record<string, unknown>,
  options: {
    readonly path: string;
    readonly clauseIds: readonly number[];
    readonly projectRoot: string;
  },
): BindClauseOnBriefResult {
  const declared = readDeclaredArtifactScope(plan);
  if (declared.length === 0) {
    return {
      ok: true,
      boundIds: [],
      message: `${BIND_CLAUSE_VERB}: empty file_scope — no-op (#4986)`,
    };
  }
  const wanted = [...new Set(options.clauseIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (wanted.length === 0) {
    return {
      ok: false,
      boundIds: [],
      message: `${BIND_CLAUSE_VERB} requires at least one --clause id (#4986)`,
    };
  }
  const pointer = normalizePointer(options.path);
  if (pointer.length === 0) {
    return {
      ok: false,
      boundIds: [],
      message: `${BIND_CLAUSE_VERB} requires a non-blank --path under file_scope (#4986)`,
    };
  }
  if (!isBindableMatchAnyFilePointer(pointer, declared, options.projectRoot)) {
    return {
      ok: false,
      boundIds: [],
      message:
        `${BIND_CLAUSE_VERB} refused: ${pointer} is not a non-glob matchAny file ` +
        `under plan.metadata.swarm.file_scope (#4986 / #3835)`,
    };
  }
  const clauses = readAcceptanceClauses(plan.acceptance);
  const byId = new Map<number, AcceptanceClause>();
  for (const clause of clauses) {
    byId.set(clause.id, clause);
  }
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      boundIds: [],
      message: `${BIND_CLAUSE_VERB} refused: unknown clause id(s): ${missing.join(", ")}`,
    };
  }
  const bound = new Map<number, AcceptanceClause>();
  const boundIds: number[] = [];
  for (const id of wanted) {
    const current = byId.get(id);
    if (current === undefined) {
      continue;
    }
    const next = applyPathToClause(current, pointer);
    if (next.changed) {
      boundIds.push(id);
    }
    bound.set(id, next.clause);
  }
  if (boundIds.length === 0) {
    return {
      ok: true,
      boundIds: [],
      message: `${BIND_CLAUSE_VERB}: unchanged (already bound to ${pointer})`,
    };
  }
  const acceptance = asRecord(plan.acceptance);
  if (acceptance === null || !Array.isArray(acceptance.clauses)) {
    return {
      ok: false,
      boundIds: [],
      message: `${BIND_CLAUSE_VERB} refused: plan.acceptance.clauses missing`,
    };
  }
  acceptance.clauses = acceptance.clauses.map((entry) => {
    const row = asRecord(entry);
    if (row === null) {
      return entry;
    }
    const id = typeof row.id === "number" ? row.id : Number(row.id);
    const replacement = Number.isInteger(id) ? bound.get(id) : undefined;
    if (replacement === undefined) {
      return entry;
    }
    const stamped: Record<string, unknown> = {
      ...row,
      artifact_path: replacement.artifact_path,
    };
    if (replacement.readings !== undefined) {
      stamped.readings = replacement.readings.map((reading) => ({
        text: reading.text,
        artifact_path: reading.artifact_path,
      }));
      stamped.chosen_reading = replacement.chosen_reading ?? 0;
    }
    return stamped;
  });
  plan.acceptance = acceptance;
  return {
    ok: true,
    boundIds,
    message: `${BIND_CLAUSE_VERB} bound clause(s) ${boundIds.join(",")} to ${pointer} (#4986)`,
  };
}

export function bindClauseOnBrief(
  filePath: string,
  options: BindClauseOnBriefOptions,
): BindClauseOnBriefResult {
  const read = readBriefForMutation(filePath);
  if (!read.ok) {
    return { ok: false, message: read.message, boundIds: [] };
  }
  const data = read.data;
  const plan = data.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, message: `vBRIEF at ${filePath} lacks a plan object`, boundIds: [] };
  }
  const planObj = plan as Record<string, unknown>;
  const projectRoot =
    resolveProjectRoot(options.projectRoot, filePath) ?? dirname(dirname(dirname(filePath)));
  const bound = bindSelectedClausesToDeclaredPath(planObj, {
    path: options.path,
    clauseIds: options.clauseIds,
    projectRoot,
  });
  if (!bound.ok) {
    return bound;
  }
  if (bound.boundIds.length === 0) {
    return bound;
  }
  const vbriefRoot = dirname(dirname(filePath));
  const write = atomicWriteBrief(filePath, data, vbriefRoot, { projectRoot });
  if (!write.ok) {
    return { ok: false, message: write.message, boundIds: [] };
  }
  return bound;
}
