#!/usr/bin/env node
/**
 * plan-sequence CLI (#2402 / #6205): set | current | clear | advance | insert
 *
 * Every verb derives the cursor from completed briefs before it reads or
 * writes (#6205). `insert`, `set` on an existing plan file and `clear` need a
 * single-use `plan-sequence-approval` grant only when
 * `plan.policy.requireBoundPrePrPush` is true (planSequenceApprovalRequired;
 * rulings 6906744687 and 6908156182).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuthorizedPlanEntry,
  advancePlanSequence,
  type ClearPlanSequenceResult,
  claimPlanSequenceApproval,
  clearPlanSequence,
  collectTerminalLifecycleOrigins,
  createPlanSequence,
  type DerivedPlanCursor,
  derivePlanBatch,
  derivePlanCursor,
  insertApprovedPlanEntry,
  inspectMissingSequenceKind,
  isPlanTargetKind,
  materializeDerivedCursor,
  missingSequenceKindPayload,
  type PlanSequence,
  type PlanSequenceApprovalAction,
  type PlanSequenceEntry,
  type PlanSequenceKind,
  type PlanTargetKind,
  parsePlanSequence,
  planBatchError,
  planSequenceApprovalRequired,
  planSequencePath,
  readPlanSequence,
  resolvePlanSequenceApprovalRepo,
  type WritePlanSequenceResult,
  writePlanSequence,
} from "@deftai/directive-core/plan-sequence";

type Action = "set" | "current" | "clear" | "advance" | "insert";

const ACTIONS: readonly Action[] = ["set", "current", "clear", "advance", "insert"];

interface Parsed {
  projectRoot: string;
  action: Action | null;
  file: string | null;
  jsonInline: string | null;
  emitJson: boolean;
  expectedGeneration: number | undefined;
  /** insert: entry kind / id / issue / title / position (#6205). */
  kind: string | null;
  id: string | null;
  issue: number | null;
  title: string | null;
  position: number | null;
  /** Repository for the approval binding; defaults to the origin remote. */
  repo: string | null;
  error?: string;
}

const USAGE =
  "usage: plan-sequence <set|current|clear|advance|insert> [--file path] [--project-root path] " +
  "[--expected-generation n] [--kind k --id id [--issue n] [--title t] [--position n] [--repo owner/name]]";

function parseNonNegativeInt(raw: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/** Split `--flag value` / `--flag=value`; returns the value and how many argv slots it used. */
function flagValue(
  argv: readonly string[],
  i: number,
  name: string,
): { value: string | undefined; used: number } | null {
  const arg = argv[i];
  if (arg === name) return { value: argv[i + 1], used: 2 };
  if (arg?.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), used: 1 };
  return null;
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    projectRoot: ".",
    action: null,
    file: null,
    jsonInline: null,
    emitJson: false,
    expectedGeneration: undefined,
    kind: null,
    id: null,
    issue: null,
    title: null,
    position: null,
    repo: null,
  };
  const positionals: string[] = [];
  const valued: Record<string, (value: string) => string | undefined> = {
    "--project-root": (v) => {
      parsed.projectRoot = v;
      return undefined;
    },
    "--file": (v) => {
      parsed.file = v;
      return undefined;
    },
    "--from-json": (v) => {
      parsed.jsonInline = v;
      return undefined;
    },
    "--expected-generation": (v) => {
      parsed.expectedGeneration = parseNonNegativeInt(v);
      return parsed.expectedGeneration === undefined
        ? "--expected-generation requires a non-negative integer"
        : undefined;
    },
    "--kind": (v) => {
      parsed.kind = v;
      return undefined;
    },
    "--id": (v) => {
      parsed.id = v;
      return undefined;
    },
    "--title": (v) => {
      parsed.title = v;
      return undefined;
    },
    "--repo": (v) => {
      parsed.repo = v;
      return undefined;
    },
    "--issue": (v) => {
      const n = parseNonNegativeInt(v.replace(/^#/, ""));
      parsed.issue = n !== undefined && n > 0 ? n : null;
      return parsed.issue === null ? "--issue requires a positive integer" : undefined;
    },
    "--position": (v) => {
      parsed.position = parseNonNegativeInt(v) ?? null;
      return parsed.position === null ? "--position requires a non-negative integer" : undefined;
    },
  };
  const missingValue: Record<string, string> = {
    "--project-root": "--project-root requires a value",
    "--file": "--file requires a path",
    "--from-json": "--from-json requires a JSON string",
    "--expected-generation": "--expected-generation requires a non-negative integer",
  };
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--") {
      i += 1;
      continue;
    }
    if (arg === "--json") {
      parsed.emitJson = true;
      i += 1;
      continue;
    }
    let handled = false;
    for (const [name, apply] of Object.entries(valued)) {
      const hit = flagValue(argv, i, name);
      if (hit === null) continue;
      if (hit.value === undefined) {
        return { ...parsed, error: missingValue[name] ?? `${name} requires a value` };
      }
      const error = apply(hit.value);
      if (error !== undefined) return { ...parsed, error };
      i += hit.used;
      handled = true;
      break;
    }
    if (handled) continue;
    if (arg.startsWith("-")) {
      return { ...parsed, error: `unknown flag: ${arg}` };
    }
    positionals.push(arg);
    i += 1;
  }
  const action = positionals[0];
  if (action !== undefined && (ACTIONS as readonly string[]).includes(action)) {
    parsed.action = action as Action;
  } else if (action !== undefined) {
    return { ...parsed, error: `unknown action: ${action} (${ACTIONS.join("|")})` };
  } else {
    parsed.error = USAGE;
  }
  return parsed;
}

function requireExpectedGeneration(parsed: Parsed): number | { error: string } {
  if (parsed.expectedGeneration === undefined) {
    return {
      error: `${parsed.action ?? "plan-sequence"} requires --expected-generation <n>`,
    };
  }
  return parsed.expectedGeneration;
}

function loadSetPayload(parsed: Parsed, root: string): PlanSequence {
  const text = parsed.file ? readFileSync(resolve(root, parsed.file), "utf8") : parsed.jsonInline;
  if (text === null || text === undefined) {
    throw new Error("plan-sequence set requires --file <path> or --from-json <json>");
  }
  const payload: unknown = JSON.parse(text);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("plan-sequence set: --file/--from-json must contain a JSON object");
  }
  const raw = payload as Record<string, unknown>;
  if (typeof raw.current_index === "number" || raw.exhausted === true) {
    // #4433: a full plan payload gets the same batch-label check as create.
    const batchError = Array.isArray(raw.entries)
      ? planBatchError(
          raw.entries.filter(
            (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
          ),
          raw.batching_allowed === true,
        )
      : null;
    if (batchError !== null) {
      throw new Error(batchError);
    }
    return parsePlanSequence(raw);
  }
  return createPlanSequence({
    sequence_id: String(raw.sequence_id),
    sequence_kind: raw.sequence_kind as PlanSequenceKind,
    entries: raw.entries as PlanSequenceEntry[],
    authorized_by: String(raw.authorized_by ?? ""),
    batching_allowed: raw.batching_allowed === true,
    continuation_past_final: raw.continuation_past_final === true,
  });
}

function fail(message: string, code = 1): number {
  process.stderr.write(`${message}\n`);
  return code;
}

/**
 * Run `write` directly, or under a spent single-use approval when this action
 * needs one. Returns the write result or a refusal message.
 */
function approvedWrite<T extends WritePlanSequenceResult | ClearPlanSequenceResult>(input: {
  readonly root: string;
  readonly parsed: Parsed;
  readonly needsApproval: boolean;
  readonly sequenceId: string;
  readonly generation: number;
  readonly action: PlanSequenceApprovalAction;
  readonly write: (grantId: string | null) => T;
}):
  | { ok: true; result: Extract<T, { ok: true }>; grantId: string | null }
  | { ok: false; message: string } {
  if (!input.needsApproval) {
    const result = input.write(null);
    return result.ok
      ? { ok: true, result: result as Extract<T, { ok: true }>, grantId: null }
      : { ok: false, message: result.message };
  }
  const repo = resolvePlanSequenceApprovalRepo(input.parsed.repo, input.root);
  if (!repo.ok) {
    return { ok: false, message: `plan-sequence ${input.action.kind} refused: ${repo.reason}` };
  }
  let result: T | null = null;
  const claimed = claimPlanSequenceApproval({
    projectRoot: input.root,
    binding: {
      repo: repo.repo,
      sequenceId: input.sequenceId,
      generation: input.generation,
      action: input.action,
    },
    write: (grantId) => {
      result = input.write(grantId);
      return result.ok ? { ok: true } : { ok: false, reason: result.message };
    },
  });
  if (!claimed.ok || result === null) {
    return { ok: false, message: claimed.ok ? "plan-sequence: write did not run" : claimed.reason };
  }
  return { ok: true, result: result as Extract<T, { ok: true }>, grantId: claimed.grantId };
}

/**
 * Replace / clear guard: an approval is needed only when a plan file exists
 * and the bound gate is on. Only then must the existing plan be readable, so
 * the store's damaged-plan recovery stays reachable with the gate off.
 */
function replaceOrClearGuard(
  root: string,
  action: "replace" | "clear",
): { needsApproval: false } | { needsApproval: true; sequenceId: string } | { error: string } {
  if (!existsSync(planSequencePath(root)) || !planSequenceApprovalRequired(action, root)) {
    return { needsApproval: false };
  }
  try {
    const existing = readPlanSequence(root);
    return existing === null
      ? { needsApproval: false }
      : { needsApproval: true, sequenceId: existing.sequence_id };
  } catch (err) {
    return {
      error: `plan-sequence: the existing plan cannot be read (${err instanceof Error ? err.message : String(err)}); approval cannot be bound to it`,
    };
  }
}

function runSet(parsed: Parsed, root: string, expected: number): number {
  const seq = loadSetPayload(parsed, root);
  const guard = replaceOrClearGuard(root, "replace");
  if ("error" in guard) return fail(guard.error);
  const written = approvedWrite({
    root,
    parsed,
    needsApproval: guard.needsApproval,
    sequenceId: guard.needsApproval ? guard.sequenceId : "",
    generation: expected,
    action: { kind: "replace" },
    write: () => writePlanSequence(root, seq, expected),
  });
  if (!written.ok) return fail(written.message);
  const result = written.result;
  if (parsed.emitJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, path: result.path, sequence: result.sequence, approval_grant: written.grantId }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `OK plan-sequence set ${result.sequence.sequence_id} (${result.sequence.entries.length} entries, index=${String(result.sequence.current_index)} generation=${String(result.sequence.generation)})\n`,
    );
  }
  return 0;
}

function runClear(parsed: Parsed, root: string, expected: number): number {
  const guard = replaceOrClearGuard(root, "clear");
  if ("error" in guard) return fail(guard.error);
  const written = approvedWrite({
    root,
    parsed,
    needsApproval: guard.needsApproval,
    sequenceId: guard.needsApproval ? guard.sequenceId : "",
    generation: expected,
    action: { kind: "clear" },
    write: () => clearPlanSequence(root, expected),
  });
  if (!written.ok) return fail(written.message);
  process.stdout.write(
    written.result.removed ? "OK plan-sequence cleared\n" : "OK plan-sequence already absent\n",
  );
  return 0;
}

/** Read the plan and derive its cursor; null when there is no plan file. */
function readDerived(
  root: string,
): { seq: PlanSequence; cursor: DerivedPlanCursor; authorized: AuthorizedPlanEntry[] } | null {
  const seq = readPlanSequence(root);
  if (seq === null) return null;
  const terminals = collectTerminalLifecycleOrigins(root);
  const cursor = derivePlanCursor(seq, terminals);
  // #4433: the set `verify:plan-sequence` admits (the current batch when batching).
  return { seq, cursor, authorized: derivePlanBatch(seq, cursor, terminals) };
}

function runCurrent(parsed: Parsed, root: string): number {
  const missingKind = inspectMissingSequenceKind(root);
  if (missingKind !== null) {
    if (parsed.emitJson) {
      process.stdout.write(`${JSON.stringify(missingSequenceKindPayload(missingKind), null, 2)}\n`);
    } else {
      process.stderr.write(`${missingKind.message}\n`);
    }
    return 1;
  }
  const read = readDerived(root);
  if (read === null) {
    return fail("No active ordered-plan sequence (.deft/plan-sequence.json missing).");
  }
  const { seq, cursor, authorized } = read;
  // The derived view: what readers act on (#6205). Stored fields stay visible.
  const view = materializeDerivedCursor(seq, cursor, seq.updated_at);
  const derived = cursor.derivedFinished.map((d) => ({
    index: d.index,
    id: d.entry.id,
    kind: d.entry.kind,
    origin_path: d.originPath,
  }));
  const authorizedRows = authorized.map((a) => ({
    index: a.index,
    id: a.entry.id,
    kind: a.entry.kind,
    ...(a.entry.issue !== undefined ? { issue: a.entry.issue } : {}),
    ...(a.entry.batch !== undefined ? { batch: a.entry.batch } : {}),
  }));
  if (parsed.emitJson) {
    const payload: Record<string, unknown> = {
      ...view,
      stored_current_index: seq.current_index,
      stored_exhausted: seq.exhausted,
      derived_finished: derived,
      authorized: authorizedRows,
    };
    if (cursor.stop !== null) {
      payload.terminal_lifecycle_drift = {
        code: cursor.stop.code,
        message: cursor.stop.message,
        originPath: cursor.stop.originPath,
        folder: cursor.stop.folder,
      };
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (cursor.stop !== null) {
    process.stderr.write(`${cursor.stop.message}\n`);
  } else {
    process.stdout.write(
      `sequence_id=${seq.sequence_id} kind=${seq.sequence_kind} index=${String(cursor.index)} exhausted=${String(cursor.exhausted)} generation=${String(seq.generation)} source_revision=${seq.source_revision}\n`,
    );
    for (const d of derived) {
      process.stdout.write(
        `derived: ${d.kind}:${d.id} finished by ${d.origin_path} (stored index=${String(seq.current_index)})\n`,
      );
    }
    if (cursor.entry !== null) {
      const issue = cursor.entry.issue !== undefined ? ` (#${cursor.entry.issue})` : "";
      process.stdout.write(`current: ${cursor.entry.kind}:${cursor.entry.id}${issue}\n`);
      if (authorized.length > 1) {
        const ids = authorizedRows.map((a) => `${a.kind}:${a.id}`).join(", ");
        process.stdout.write(`authorized batch "${cursor.entry.batch ?? ""}": ${ids}\n`);
      }
    } else {
      process.stdout.write("current: (exhausted — fresh approval required)\n");
    }
  }
  return cursor.stop !== null ? 1 : 0;
}

function runAdvance(parsed: Parsed, root: string, expected: number): number {
  const read = readDerived(root);
  if (read === null) return fail("No active ordered-plan sequence to advance.");
  // Derive first: advance acts on the effective entry `current` shows (#6205).
  const base = materializeDerivedCursor(read.seq, read.cursor);
  const passed = read.cursor.entry;
  const next = advancePlanSequence(base);
  const result = writePlanSequence(root, next, expected);
  if (!result.ok) return fail(result.message);
  if (parsed.emitJson) {
    process.stdout.write(`${JSON.stringify(result.sequence, null, 2)}\n`);
    return 0;
  }
  const from = passed === null ? "" : ` past ${passed.kind}:${passed.id}`;
  if (result.sequence.exhausted) {
    process.stdout.write(
      `OK advanced${from}; sequence exhausted. Fresh operator approval required before another unit. generation=${String(result.sequence.generation)}\n`,
    );
  } else {
    const cur = result.sequence.entries[result.sequence.current_index];
    process.stdout.write(
      `OK advanced${from} to index=${result.sequence.current_index} (${cur?.kind}:${cur?.id}) generation=${String(result.sequence.generation)}\n`,
    );
  }
  return 0;
}

function runInsert(parsed: Parsed, root: string, expected: number): number {
  if (parsed.kind === null || !isPlanTargetKind(parsed.kind)) {
    return fail(
      "plan-sequence insert requires --kind <pr|issue|story|task|phase|checklist|review>",
      2,
    );
  }
  const id = parsed.id?.trim() ?? "";
  if (id.length === 0) return fail("plan-sequence insert requires --id <entry-id>", 2);
  const read = readDerived(root);
  if (read === null) {
    return fail("No active ordered-plan sequence to insert into; set one with plan-sequence:set.");
  }
  const { seq, cursor } = read;
  const kind: PlanTargetKind = parsed.kind;
  const entry: PlanSequenceEntry = {
    id,
    kind,
    ...(parsed.title !== null ? { title: parsed.title } : {}),
    ...(parsed.issue !== null ? { issue: parsed.issue } : {}),
  };
  const position = parsed.position ?? cursor.index;
  const now = new Date().toISOString();
  // Validate the shape before spending a grant.
  const dryRun = insertApprovedPlanEntry({
    sequence: seq,
    cursor,
    entry,
    position,
    approval: null,
    now,
  });
  if (!dryRun.ok) return fail(dryRun.reason);
  const written = approvedWrite({
    root,
    parsed,
    needsApproval: planSequenceApprovalRequired("insert", root),
    sequenceId: seq.sequence_id,
    generation: expected,
    action: {
      kind: "insert",
      entryKind: kind,
      entryId: id,
      issue: parsed.issue,
      title: parsed.title,
      position,
    },
    write: (grantId) => {
      const inserted = insertApprovedPlanEntry({
        sequence: seq,
        cursor,
        entry,
        position,
        approval: grantId === null ? null : { entry_id: id, grant_id: grantId, approved_at: now },
        now,
      });
      if (!inserted.ok) {
        return {
          ok: false,
          code: "parse-error",
          current_generation: seq.generation,
          source_revision: seq.source_revision,
          message: inserted.reason,
        } as const;
      }
      return writePlanSequence(root, inserted.sequence, expected);
    },
  });
  if (!written.ok) return fail(written.message);
  const result = written.result;
  if (parsed.emitJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, position, approval_grant: written.grantId, sequence: result.sequence }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `OK plan-sequence insert ${kind}:${id} at index=${String(position)} (approval grant ${written.grantId ?? "-"}) generation=${String(result.sequence.generation)}\n`,
    );
  }
  return 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  if (parsed.error || parsed.action === null) {
    return fail(parsed.error ?? "usage error", 2);
  }
  const root = resolve(parsed.projectRoot);
  try {
    if (parsed.action === "current") {
      return runCurrent(parsed, root);
    }
    const expected = requireExpectedGeneration(parsed);
    if (typeof expected !== "number") {
      return fail(expected.error, 2);
    }
    switch (parsed.action) {
      case "set":
        return runSet(parsed, root, expected);
      case "clear":
        return runClear(parsed, root, expected);
      case "insert":
        return runInsert(parsed, root, expected);
      default:
        return runAdvance(parsed, root, expected);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
