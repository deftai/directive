import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const RESUME_ELIGIBLE_DECISION = "resume-eligible";
export const EVALUATOR_ACTOR = "agent:resume-evaluator";
export const CACHE_DIR_NAME = ".deft-cache";
export const CACHE_SOURCE_GITHUB_ISSUE = "github-issue";
export const PENDING_LIFECYCLE_DIR = "pending";

export class ResumeGrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeGrammarError";
  }
}

export interface Atomic {
  readonly kind: string;
  readonly value: number | string;
  readonly raw: string;
  readonly sliceId: string;
}

export interface Expression {
  readonly op: "ATOM" | "AND" | "OR";
  readonly left: Atomic;
  readonly right: Atomic | null;
  readonly raw: string;
}

export interface ResumeContext {
  readonly today: string;
  readonly closedRefs: ReadonlySet<number>;
  readonly mergedRefs: ReadonlySet<number>;
  readonly pendingCount: number;
  readonly slices: readonly Record<string, unknown>[];
}

function isDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function parseIsoDate(text: string): string | null {
  if (text.length !== 10) return null;
  if (text.charCodeAt(4) !== 45 || text.charCodeAt(7) !== 45) return null;
  const y = text.slice(0, 4);
  const m = text.slice(5, 7);
  const d = text.slice(8, 10);
  if (!isDigits(y) || !isDigits(m) || !isDigits(d)) return null;
  return text;
}

function isHex(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

function parseUuidSegment(text: string, length: number): boolean {
  if (text.length !== length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (!isHex(text.charCodeAt(i))) return false;
  }
  return true;
}

function parseSliceWaveReady(text: string): Atomic | null {
  const prefix = "slice-wave-ready:";
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === ":") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  if (parts.length !== 2) return null;
  const sliceId = parts[0] ?? "";
  const waveText = parts[1] ?? "";
  const uuidParts = sliceId.split("-");
  if (
    uuidParts.length !== 5 ||
    !parseUuidSegment(uuidParts[0] ?? "", 8) ||
    !parseUuidSegment(uuidParts[1] ?? "", 4) ||
    !parseUuidSegment(uuidParts[2] ?? "", 4) ||
    !parseUuidSegment(uuidParts[3] ?? "", 4) ||
    !parseUuidSegment(uuidParts[4] ?? "", 12)
  ) {
    return null;
  }
  if (!isDigits(waveText)) return null;
  const wave = Number.parseInt(waveText, 10);
  if (wave < 1) {
    throw new ResumeGrammarError(`slice-wave-ready wave must be a positive int, got ${wave}`);
  }
  return {
    kind: "slice-wave-ready",
    value: wave,
    raw: text,
    sliceId: sliceId.toLowerCase(),
  };
}

function parseAtomic(raw: string): Atomic {
  const text = raw.trim();
  if (text.length === 0) {
    throw new ResumeGrammarError("empty atomic condition");
  }
  const refClosedPrefix = "ref:closed:#";
  if (text.startsWith(refClosedPrefix)) {
    const num = text.slice(refClosedPrefix.length);
    if (!isDigits(num)) {
      throw new ResumeGrammarError(
        `unrecognised atomic condition ${JSON.stringify(text)}; expected one of: ref:closed:#N, ref:merged:#N, date:>=YYYY-MM-DD, pending-count:>=N, pending-count:<=N, slice-wave-ready:<slice_id>:<wave>`,
      );
    }
    return { kind: "ref-closed", value: Number.parseInt(num, 10), raw: text, sliceId: "" };
  }
  const refMergedPrefix = "ref:merged:#";
  if (text.startsWith(refMergedPrefix)) {
    const num = text.slice(refMergedPrefix.length);
    if (!isDigits(num)) {
      throw new ResumeGrammarError(
        `unrecognised atomic condition ${JSON.stringify(text)}; expected one of: ref:closed:#N, ref:merged:#N, date:>=YYYY-MM-DD, pending-count:>=N, pending-count:<=N, slice-wave-ready:<slice_id>:<wave>`,
      );
    }
    return { kind: "ref-merged", value: Number.parseInt(num, 10), raw: text, sliceId: "" };
  }
  const datePrefix = "date:>=";
  if (text.startsWith(datePrefix)) {
    const dateText = text.slice(datePrefix.length);
    const parsed = parseIsoDate(dateText);
    if (parsed === null) {
      throw new ResumeGrammarError(`invalid date in ${JSON.stringify(text)}: invalid isoformat`);
    }
    return { kind: "date-ge", value: parsed, raw: text, sliceId: "" };
  }
  const pendingGePrefix = "pending-count:>=";
  if (text.startsWith(pendingGePrefix)) {
    const num = text.slice(pendingGePrefix.length);
    if (!isDigits(num)) {
      throw new ResumeGrammarError(
        `unrecognised atomic condition ${JSON.stringify(text)}; expected one of: ref:closed:#N, ref:merged:#N, date:>=YYYY-MM-DD, pending-count:>=N, pending-count:<=N, slice-wave-ready:<slice_id>:<wave>`,
      );
    }
    return { kind: "pending-count-ge", value: Number.parseInt(num, 10), raw: text, sliceId: "" };
  }
  const pendingLePrefix = "pending-count:<=";
  if (text.startsWith(pendingLePrefix)) {
    const num = text.slice(pendingLePrefix.length);
    if (!isDigits(num)) {
      throw new ResumeGrammarError(
        `unrecognised atomic condition ${JSON.stringify(text)}; expected one of: ref:closed:#N, ref:merged:#N, date:>=YYYY-MM-DD, pending-count:>=N, pending-count:<=N, slice-wave-ready:<slice_id>:<wave>`,
      );
    }
    return { kind: "pending-count-le", value: Number.parseInt(num, 10), raw: text, sliceId: "" };
  }
  const slice = parseSliceWaveReady(text);
  if (slice !== null) {
    return slice;
  }
  throw new ResumeGrammarError(
    `unrecognised atomic condition ${JSON.stringify(text)}; expected one of: ref:closed:#N, ref:merged:#N, date:>=YYYY-MM-DD, pending-count:>=N, pending-count:<=N, slice-wave-ready:<slice_id>:<wave>`,
  );
}

function splitComposition(text: string): string[] | null {
  const andToken = " AND ";
  const orToken = " OR ";
  const andIdx = text.indexOf(andToken);
  const orIdx = text.indexOf(orToken);
  if (andIdx < 0 && orIdx < 0) {
    return null;
  }
  if (andIdx >= 0 && orIdx >= 0) {
    return null;
  }
  const token = andIdx >= 0 ? andToken : orToken;
  const idx = andIdx >= 0 ? andIdx : orIdx;
  const left = text.slice(0, idx);
  const right = text.slice(idx + token.length);
  if (
    left.includes(andToken) ||
    left.includes(orToken) ||
    right.includes(andToken) ||
    right.includes(orToken)
  ) {
    return null;
  }
  const op = token.trim();
  return [left, op, right];
}

export function parse(expr: string): Expression {
  if (typeof expr !== "string") {
    throw new ResumeGrammarError(`resume_on must be a string, got ${typeof expr}`);
  }
  const text = expr.trim();
  if (text.length === 0) {
    throw new ResumeGrammarError("resume_on must be a non-empty string");
  }
  const parts = splitComposition(text);
  if (parts === null) {
    const atom = parseAtomic(text);
    return { op: "ATOM", left: atom, right: null, raw: text };
  }
  const [leftRaw, op, rightRaw] = parts;
  if (op !== "AND" && op !== "OR") {
    throw new ResumeGrammarError(
      `unknown composition operator ${JSON.stringify(op)}; expected AND or OR`,
    );
  }
  const left = parseAtomic(leftRaw ?? "");
  const right = parseAtomic(rightRaw ?? "");
  return { op, left, right, raw: text };
}

function sliceWaveReady(ctx: ResumeContext, sliceId: string, wave: number): boolean {
  const sidNorm = sliceId.toLowerCase();
  let record: Record<string, unknown> | null = null;
  for (const entry of ctx.slices) {
    const candidate = entry.slice_id;
    if (typeof candidate === "string" && candidate.toLowerCase() === sidNorm) {
      record = entry;
      break;
    }
  }
  if (record === null) return false;
  const children = record.children;
  if (!Array.isArray(children)) return false;
  const earlier: number[] = [];
  for (const child of children) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
    const cwave = (child as Record<string, unknown>).wave;
    const cn = (child as Record<string, unknown>).n;
    if (typeof cwave !== "number" || typeof cn !== "number") continue;
    if (cwave < wave) earlier.push(cn);
  }
  if (earlier.length === 0) return false;
  return earlier.every((n) => ctx.closedRefs.has(n));
}

function evalAtomic(atom: Atomic, ctx: ResumeContext): boolean {
  if (atom.kind === "ref-closed") {
    return ctx.closedRefs.has(atom.value as number);
  }
  if (atom.kind === "ref-merged") {
    return ctx.mergedRefs.has(atom.value as number);
  }
  if (atom.kind === "date-ge") {
    return ctx.today >= (atom.value as string);
  }
  if (atom.kind === "pending-count-ge") {
    return ctx.pendingCount >= (atom.value as number);
  }
  if (atom.kind === "pending-count-le") {
    return ctx.pendingCount <= (atom.value as number);
  }
  if (atom.kind === "slice-wave-ready") {
    return sliceWaveReady(ctx, atom.sliceId, atom.value as number);
  }
  throw new ResumeGrammarError(
    `evaluator missing branch for atomic kind ${JSON.stringify(atom.kind)}`,
  );
}

export function evaluate(expr: Expression, ctx: ResumeContext): boolean {
  if (expr.op === "ATOM") {
    return evalAtomic(expr.left, ctx);
  }
  if (expr.op === "AND") {
    if (expr.right === null) {
      throw new ResumeGrammarError("AND expression missing right-hand atom");
    }
    return evalAtomic(expr.left, ctx) && evalAtomic(expr.right, ctx);
  }
  if (expr.op === "OR") {
    if (expr.right === null) {
      throw new ResumeGrammarError("OR expression missing right-hand atom");
    }
    return evalAtomic(expr.left, ctx) || evalAtomic(expr.right, ctx);
  }
  throw new ResumeGrammarError(`unknown composition op ${JSON.stringify(expr.op)}`);
}

function countPending(projectRoot: string): number {
  const folder = join(resolve(projectRoot), "vbrief", PENDING_LIFECYCLE_DIR);
  try {
    if (!statSync(folder).isDirectory()) return 0;
  } catch {
    return 0;
  }
  let count = 0;
  try {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name);
      try {
        if (statSync(full).isFile() && name.endsWith(".vbrief.json")) {
          count += 1;
        }
      } catch {}
    }
  } catch {
    return 0;
  }
  return count;
}

function* iterCachedPayloads(
  projectRoot: string,
  cacheRoot?: string,
  repo?: string | null,
): Generator<[string, number, Record<string, unknown>]> {
  const base = join(
    cacheRoot ?? join(resolve(projectRoot), CACHE_DIR_NAME),
    CACHE_SOURCE_GITHUB_ISSUE,
  );
  try {
    if (!statSync(base).isDirectory()) return;
  } catch {
    return;
  }
  let targetOwner: string | null = null;
  let targetName: string | null = null;
  if (repo?.includes("/")) {
    const slash = repo.indexOf("/");
    targetOwner = repo.slice(0, slash);
    targetName = repo.slice(slash + 1);
  }
  let ownerDirs: string[];
  try {
    ownerDirs = readdirSync(base);
  } catch {
    return;
  }
  for (const owner of ownerDirs) {
    const ownerDir = join(base, owner);
    try {
      if (!statSync(ownerDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (targetOwner !== null && owner !== targetOwner) continue;
    let repoDirs: string[];
    try {
      repoDirs = readdirSync(ownerDir);
    } catch {
      continue;
    }
    for (const repoName of repoDirs) {
      const repoDir = join(ownerDir, repoName);
      try {
        if (!statSync(repoDir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (targetName !== null && repoName !== targetName) continue;
      let issueDirs: string[];
      try {
        issueDirs = readdirSync(repoDir);
      } catch {
        continue;
      }
      for (const issueName of issueDirs) {
        if (!isDigits(issueName)) continue;
        const rawPath = join(repoDir, issueName, "raw.json");
        try {
          if (!existsSync(rawPath)) continue;
          const payload = JSON.parse(readFileSync(rawPath, { encoding: "utf8" })) as unknown;
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
          yield [
            `${owner}/${repoName}`,
            Number.parseInt(issueName, 10),
            payload as Record<string, unknown>,
          ];
        } catch {}
      }
    }
  }
}

export function buildContext(
  projectRoot: string,
  options: {
    cacheRoot?: string;
    today?: string;
    repo?: string | null;
    slices?: readonly Record<string, unknown>[];
  } = {},
): ResumeContext {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const closed = new Set<number>();
  const merged = new Set<number>();
  for (const [_slug, n, payload] of iterCachedPayloads(
    projectRoot,
    options.cacheRoot,
    options.repo,
  )) {
    const state = payload.state;
    if (typeof state === "string" && state.toLowerCase() === "closed") {
      closed.add(n);
    }
    if (payload.merged === true || payload.mergedAt) {
      merged.add(n);
    }
  }
  return {
    today,
    closedRefs: closed,
    mergedRefs: merged,
    pendingCount: countPending(projectRoot),
    slices: options.slices ?? [],
  };
}

export interface AuditLogModule {
  readAll: (options?: {
    repo?: string | null;
    path?: string;
  }) => readonly Record<string, unknown>[];
  append: (entry: Record<string, unknown>, options?: { path?: string }) => void;
  newDecisionId?: () => string;
}

const SUPERSEDING = new Set([
  "accept",
  "reject",
  "mark-duplicate",
  "reset",
  RESUME_ELIGIBLE_DECISION,
]);

function openDeferEntries(entries: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const byIssue = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries) {
    const repo = entry.repo;
    const number = entry.issue_number;
    if (typeof repo !== "string" || typeof number !== "number") continue;
    const key = `${repo}\0${number}`;
    const rows = byIssue.get(key) ?? [];
    rows.push(entry);
    byIssue.set(key, rows);
  }
  const openDefers: Record<string, unknown>[] = [];
  for (const rows of byIssue.values()) {
    rows.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
    let targetDefer: Record<string, unknown> | null = null;
    let superseded = false;
    for (const row of rows) {
      const decision = row.decision;
      if (decision === "defer") {
        targetDefer = row;
        superseded = false;
      } else if (
        typeof decision === "string" &&
        SUPERSEDING.has(decision) &&
        targetDefer !== null
      ) {
        superseded = true;
        targetDefer = null;
      }
    }
    if (targetDefer === null || superseded) continue;
    if (!targetDefer.resume_on) continue;
    openDefers.push(targetDefer);
  }
  return openDefers;
}

export function evaluateResumeEligibility(
  projectRoot: string,
  options: {
    cacheRoot?: string;
    auditLogPath?: string;
    today?: string;
    repo?: string | null;
    logModule?: AuditLogModule | null;
    newId?: () => string;
    nowIso?: () => string;
    slices?: readonly Record<string, unknown>[];
  } = {},
): Record<string, unknown>[] {
  const log = options.logModule ?? null;
  if (log === null) return [];
  const newDecisionId = options.newId ?? log.newDecisionId ?? (() => randomUUID());
  const timestampFn = options.nowIso ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));

  const entries = [...log.readAll({ repo: options.repo ?? null, path: options.auditLogPath })];
  const openDefers = openDeferEntries(entries);
  if (openDefers.length === 0) return [];

  const ctx = buildContext(projectRoot, {
    cacheRoot: options.cacheRoot,
    today: options.today,
    repo: options.repo,
    slices: options.slices,
  });

  const appended: Record<string, unknown>[] = [];
  for (const deferEntry of openDefers) {
    const expressionText = deferEntry.resume_on;
    if (typeof expressionText !== "string") continue;
    let ast: Expression;
    try {
      ast = parse(expressionText);
    } catch {
      continue;
    }
    if (!evaluate(ast, ctx)) continue;
    const newEntry: Record<string, unknown> = {
      decision_id: String(newDecisionId()),
      timestamp: timestampFn(),
      repo: String(deferEntry.repo),
      issue_number: Number(deferEntry.issue_number),
      decision: RESUME_ELIGIBLE_DECISION,
      actor: EVALUATOR_ACTOR,
      prior_decision_id: String(deferEntry.decision_id),
      reason: `resume_on fired: ${expressionText}`,
    };
    try {
      if (options.auditLogPath) {
        log.append(newEntry, { path: options.auditLogPath });
      } else {
        log.append(newEntry);
      }
    } catch {
      continue;
    }
    appended.push(newEntry);
  }
  return appended;
}
