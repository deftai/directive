import type { CompletedProcess } from "../scm/call.js";
import { call as scmCall } from "../scm/call.js";
import { pyRepr } from "../scm/py-format.js";
import {
  DEFAULT_ACTOR,
  DEFAULT_EXPECTED_CLOSE_SIGNAL,
  DEFAULT_ROLE,
  WAVE_FLAG_RE,
} from "./constants.js";
import { IssueValidationError, SliceRecordError } from "./errors.js";
import { pythonJsonPretty } from "./json.js";
import { appendLock, withAppendLock } from "./lock.js";
import {
  formatMissingRepoError,
  formatMissingRootError,
  resolveRootAndRepo,
} from "./project-context.js";
import { newSliceId, nowIso, readAll, slicesPath, writeSliceUnlocked } from "./record.js";

export type ScmCaller = (
  source: string,
  verb: string,
  args: readonly string[] | null,
  options?: { check?: boolean; captureOutput?: boolean; text?: boolean; timeout?: number },
) => CompletedProcess;

export interface RecordExistingArgs {
  readonly umbrella: number;
  readonly children: string;
  readonly actor: string;
  readonly expectedCloseSignal: string;
  readonly slicedAt: string | null;
  readonly notes: string | null;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly skipValidation: boolean;
  readonly repo: string | null;
  readonly projectRoot: string | null;
}

export interface ListArgs {
  readonly projectRoot: string | null;
  readonly asJson: boolean;
}

export interface ExistingDeps {
  readonly scm?: ScmCaller;
  readonly nowIso?: () => string;
  readonly newSliceId?: () => string;
  readonly findDuplicateFn?: typeof findDuplicate;
  readonly withLock?: typeof withAppendLock;
}

export function parseChildrenCsv(value: string): number[] {
  if (value.length === 0) {
    throw new Error("expected at least one child issue number");
  }
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of value.split(",")) {
    const token = part.trim();
    if (token.length === 0) {
      continue;
    }
    const n = Number.parseInt(token, 10);
    if (Number.isNaN(n)) {
      throw new Error(`invalid child issue number '${token}' (must be a positive int)`);
    }
    if (n < 1) {
      throw new Error(`invalid child issue number ${n} (must be a positive int)`);
    }
    if (seen.has(n)) {
      throw new Error(`duplicate child issue number ${n}`);
    }
    seen.add(n);
    out.push(n);
  }
  if (out.length === 0) {
    throw new Error("expected at least one child issue number");
  }
  return out;
}

export function consumeWaveFlags(rawArgs: string[]): {
  waveMap: Map<number, number[]>;
  remaining: string[];
} {
  const waveMap = new Map<number, number[]>();
  const remaining: string[] = [];
  let i = 0;
  while (i < rawArgs.length) {
    const token = rawArgs[i] ?? "";
    const match = WAVE_FLAG_RE.exec(token);
    if (!match) {
      remaining.push(token);
      i += 1;
      continue;
    }
    const waveN = Number.parseInt(match[1] ?? "0", 10);
    if (waveN < 1) {
      throw new Error(`invalid wave number in '${token}' (must be >= 1)`);
    }
    let value: string | undefined;
    if (match[2] !== undefined) {
      value = match[2];
      i += 1;
    } else if (i + 1 < rawArgs.length) {
      value = rawArgs[i + 1];
      i += 2;
    } else {
      throw new Error(`missing value for '${token}'`);
    }
    const children = parseChildrenCsv(value ?? "");
    const bucket = waveMap.get(waveN) ?? [];
    for (const n of children) {
      if (!bucket.includes(n)) {
        bucket.push(n);
      }
    }
    waveMap.set(waveN, bucket);
  }

  const placement = new Map<number, number>();
  for (const [waveN, members] of waveMap) {
    for (const n of members) {
      const prior = placement.get(n);
      if (prior !== undefined && prior !== waveN) {
        throw new Error(
          `child ${n} appears in both --wave-${prior} and --wave-${waveN}; each child belongs to one wave`,
        );
      }
      placement.set(n, waveN);
    }
  }
  return { waveMap, remaining };
}

export function repoSlugToUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/issues/${n}`;
}

export function buildChildren(
  children: number[],
  waveMap: Map<number, number[]>,
  repo: string,
): Record<string, unknown>[] {
  const waveFor = new Map<number, number>();
  for (const [waveN, members] of waveMap) {
    for (const n of members) {
      waveFor.set(n, waveN);
    }
  }
  return children.map((n) => ({
    n,
    url: repoSlugToUrl(repo, n),
    wave: waveFor.get(n) ?? 1,
    role: DEFAULT_ROLE,
  }));
}

export function childrenSet(record: Record<string, unknown>): Set<number> {
  const children = record.children;
  if (!Array.isArray(children)) {
    return new Set();
  }
  const out = new Set<number>();
  for (const child of children) {
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      const n = (child as Record<string, unknown>).n;
      if (typeof n === "number" && Number.isInteger(n)) {
        out.add(n);
      }
    }
  }
  return out;
}

export function findDuplicate(
  umbrella: number,
  childrenNumbers: number[],
  slicesLogPath: string,
): Record<string, unknown> | null {
  const target = new Set(childrenNumbers);
  for (const record of readAll({ path: slicesLogPath })) {
    if (record.umbrella !== umbrella) {
      continue;
    }
    const childSet = childrenSet(record);
    if (childSet.size === target.size && [...target].every((n) => childSet.has(n))) {
      return record;
    }
  }
  return null;
}

export function validateIssueExists(n: number, repo: string, deps: ExistingDeps = {}): void {
  const scm = deps.scm ?? scmCall;
  let proc: CompletedProcess;
  try {
    proc = scm(
      "github-issue",
      "issue",
      ["view", String(n), "--repo", repo, "--json", "number,url"],
      {
        check: false,
        captureOutput: true,
        text: true,
        timeout: 30,
      },
    );
  } catch {
    throw new IssueValidationError(`timed out validating issue #${n} in ${repo}`);
  }
  if (proc.returncode !== 0) {
    const stderr = proc.stderr.trim() || "(no stderr)";
    throw new IssueValidationError(`issue #${n} in ${repo} not found / inaccessible: ${stderr}`);
  }
}

export function summariseWaves(waveMap: Map<number, number[]>, totalChildren: number): string {
  if (waveMap.size === 0) {
    return `${totalChildren} in wave 1 (default)`;
  }
  const placedByWave = new Map<number, number>();
  for (const [waveN, members] of waveMap) {
    placedByWave.set(waveN, members.length);
  }
  let placedTotal = 0;
  for (const count of placedByWave.values()) {
    placedTotal += count;
  }
  const unassigned = totalChildren - placedTotal;
  if (unassigned > 0) {
    placedByWave.set(1, (placedByWave.get(1) ?? 0) + unassigned);
  }
  const parts = [...placedByWave.keys()]
    .sort((a, b) => a - b)
    .map((waveN) => `wave-${waveN}=${placedByWave.get(waveN)}`);
  return `${parts.length} wave(s): ${parts.join(", ")}`;
}

function duplicateMessage(umbrella: number, duplicate: Record<string, unknown>): string {
  return (
    `slice:record-existing: umbrella #${umbrella} already has a matching record (slice_id=${String(duplicate.slice_id)}, ` +
    `actor=${String(duplicate.actor)}). Re-run with --force to write a second record.`
  );
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runRecordExisting(
  args: RecordExistingArgs,
  waveMap: Map<number, number[]>,
  deps: ExistingDeps = {},
): CommandResult {
  const resolved = resolveRootAndRepo(args.projectRoot, args.repo, true);
  if (resolved.exitCode !== 0) {
    const message =
      resolved.repo === null && resolved.projectRoot !== "."
        ? formatMissingRepoError()
        : formatMissingRootError();
    return { exitCode: resolved.exitCode, stdout: "", stderr: `${message}\n` };
  }
  const repo = resolved.repo;
  if (repo === null) {
    throw new Error("repo is None despite require_repo=True; this is a bug in resolveRootAndRepo");
  }

  let children: number[];
  try {
    children = parseChildrenCsv(args.children);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 2, stdout: "", stderr: `error: ${msg}\n` };
  }

  const declared = new Set(children);
  for (const [waveN, members] of waveMap) {
    for (const n of members) {
      if (!declared.has(n)) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `error: --wave-${waveN} references child #${n} not present in --children\n`,
        };
      }
    }
  }

  if (declared.has(args.umbrella)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `error: umbrella #${args.umbrella} cannot also appear in --children\n`,
    };
  }

  if (!args.skipValidation) {
    try {
      validateIssueExists(args.umbrella, repo, deps);
      for (const n of children) {
        validateIssueExists(n, repo, deps);
      }
    } catch (err) {
      if (err instanceof IssueValidationError) {
        return { exitCode: 1, stdout: "", stderr: `error: ${err.message}\n` };
      }
      if (err instanceof Error && err.message.includes("not yet supported")) {
        return { exitCode: 1, stdout: "", stderr: `error: ${err.message}\n` };
      }
      throw err;
    }
  }

  const logPath = slicesPath(resolved.projectRoot);
  const findDup = deps.findDuplicateFn ?? findDuplicate;
  const duplicate = findDup(args.umbrella, children, logPath);
  if (duplicate !== null && !args.force) {
    return { exitCode: 0, stdout: "", stderr: `${duplicateMessage(args.umbrella, duplicate)}\n` };
  }

  const childDicts = buildChildren(children, waveMap, repo);
  const clock = deps.nowIso ?? nowIso;

  if (args.dryRun) {
    const proposed: Record<string, unknown> = {
      slice_id: "<dry-run>",
      umbrella: args.umbrella,
      umbrella_url: repoSlugToUrl(repo, args.umbrella),
      sliced_at: args.slicedAt ?? clock(),
      actor: args.actor,
      children: childDicts,
      expected_close_signal: args.expectedCloseSignal,
    };
    if (args.notes !== null) {
      proposed.notes = args.notes;
    }
    const waveSummary = summariseWaves(waveMap, children.length);
    return {
      exitCode: 0,
      stdout: `${pythonJsonPretty(proposed)}\n`,
      stderr:
        `DRY-RUN: would write slices.jsonl entry for umbrella ` +
        `#${args.umbrella} (${children.length} children, ${waveSummary}).\n`,
    };
  }

  const record: Record<string, unknown> = {
    slice_id: (deps.newSliceId ?? newSliceId)(),
    umbrella: args.umbrella,
    umbrella_url: repoSlugToUrl(repo, args.umbrella),
    sliced_at: args.slicedAt ?? clock(),
    actor: args.actor,
    children: childDicts,
    expected_close_signal: args.expectedCloseSignal,
  };
  if (args.notes !== null) {
    record.notes = args.notes;
  }

  try {
    const lock = deps.withLock ?? withAppendLock;
    const outcome = lock(logPath, () => {
      const authoritativeDup = findDup(args.umbrella, children, logPath);
      if (authoritativeDup !== null && !args.force) {
        return { kind: "duplicate" as const, duplicate: authoritativeDup };
      }
      const id = writeSliceUnlocked(record, { path: logPath });
      return { kind: "written" as const, sliceId: id };
    });
    if (outcome.kind === "duplicate") {
      return {
        exitCode: 0,
        stdout: "",
        stderr: `${duplicateMessage(args.umbrella, outcome.duplicate)}\n`,
      };
    }
    const waveSummary = summariseWaves(waveMap, children.length);
    return {
      exitCode: 0,
      stdout:
        `Wrote vbrief/.eval/slices.jsonl entry for umbrella ` +
        `#${args.umbrella} (${children.length} children, ${waveSummary}). ` +
        `slice_id=${outcome.sliceId}\n`,
      stderr: "",
    };
  } catch (err) {
    if (err instanceof SliceRecordError) {
      return { exitCode: 1, stdout: "", stderr: `error: invalid record -- ${err.message}\n` };
    }
    throw err;
  }
}

export function runList(args: ListArgs): CommandResult {
  const resolved = resolveRootAndRepo(args.projectRoot, null, false);
  if (resolved.exitCode !== 0) {
    return { exitCode: 2, stdout: "", stderr: `${formatMissingRootError()}\n` };
  }

  const records = readAll({ path: slicesPath(resolved.projectRoot) });
  if (args.asJson) {
    return { exitCode: 0, stdout: `${pythonJsonPretty(records)}\n`, stderr: "" };
  }

  if (records.length === 0) {
    return {
      exitCode: 0,
      stdout: "slice:list: no records found in vbrief/.eval/slices.jsonl (file absent or empty).\n",
      stderr: "",
    };
  }

  const lines = [`slice:list: ${records.length} record(s) in vbrief/.eval/slices.jsonl`];
  for (const record of records) {
    const umbrella = record.umbrella ?? "?";
    const actor = record.actor ?? "?";
    const slicedAt = record.sliced_at ?? "?";
    const sliceId = record.slice_id ?? "?";
    const children = record.children;
    const childCount = Array.isArray(children) ? children.length : 0;
    const signal = record.expected_close_signal ?? "?";
    const notes = record.notes;
    let line =
      `  - umbrella=#${String(umbrella)} children=${childCount} ` +
      `actor=${String(actor)} sliced_at=${String(slicedAt)} ` +
      `signal=${String(signal)} slice_id=${String(sliceId)}`;
    if (typeof notes === "string" && notes.length > 0) {
      line += ` notes=${pyRepr(notes)}`;
    }
    lines.push(line);
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

export { appendLock, DEFAULT_ACTOR, DEFAULT_EXPECTED_CLOSE_SIGNAL };
