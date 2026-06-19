import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pyRepr } from "../scm/py-format.js";

export const DEFAULT_LOG_PATH = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "vbrief",
  ".eval",
  "candidates.jsonl",
);

const VALID_DECISIONS = new Set<string>([
  "accept",
  "reject",
  "defer",
  "needs-ac",
  "mark-duplicate",
  "reset",
  "resume-eligible",
]);

const PRIOR_REQUIRED_DECISIONS = new Set<string>(["reset", "resume-eligible"]);

const REQUIRED_FIELDS = [
  "decision_id",
  "timestamp",
  "repo",
  "issue_number",
  "decision",
  "actor",
] as const;

const OPTIONAL_FIELDS = ["reason", "resume_on", "linked_to", "prior_decision_id"] as const;

const ALLOWED_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

let threadLocked = false;

export class CandidatesLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidatesLogError";
  }
}

function validateEntry(entry: unknown): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new CandidatesLogError(`entry must be a dict, got ${typeof entry}`);
  }
  const obj = entry as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter((f) => !(f in obj));
  if (missing.length > 0) {
    throw new CandidatesLogError(`entry missing required field(s): ${pyRepr(missing)}`);
  }

  const extras = [...Object.keys(obj)].filter((k) => !ALLOWED_FIELDS.has(k)).sort();
  if (extras.length > 0) {
    throw new CandidatesLogError(`entry has unknown field(s): ${pyRepr(extras)}`);
  }

  const decisionId = obj.decision_id;
  if (typeof decisionId !== "string" || !UUID_PATTERN.test(decisionId)) {
    throw new CandidatesLogError(
      `decision_id must be a UUID string, got ${JSON.stringify(decisionId)}`,
    );
  }

  const timestamp = obj.timestamp;
  if (typeof timestamp !== "string" || !ISO8601_PATTERN.test(timestamp)) {
    throw new CandidatesLogError(
      `timestamp must be ISO-8601 UTC with Z suffix (e.g. 2026-05-03T16:32:54Z), got ${JSON.stringify(timestamp)}`,
    );
  }

  const repo = obj.repo;
  if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
    throw new CandidatesLogError(`repo must match 'owner/name', got ${JSON.stringify(repo)}`);
  }

  const issueNumber = obj.issue_number;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new CandidatesLogError(
      `issue_number must be a positive int, got ${JSON.stringify(issueNumber)}`,
    );
  }

  const decision = obj.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
    throw new CandidatesLogError(
      `decision must be one of ${JSON.stringify([...VALID_DECISIONS].sort())}, got ${JSON.stringify(decision)}`,
    );
  }

  const actor = obj.actor;
  if (typeof actor !== "string" || actor.length === 0) {
    throw new CandidatesLogError(`actor must be a non-empty string, got ${JSON.stringify(actor)}`);
  }

  if ("reason" in obj && typeof obj.reason !== "string") {
    throw new CandidatesLogError(`reason must be a string, got ${typeof obj.reason}`);
  }

  if ("resume_on" in obj) {
    const resumeOn = obj.resume_on;
    if (typeof resumeOn !== "string" || resumeOn.length === 0) {
      throw new CandidatesLogError(
        `resume_on must be a non-empty string, got ${JSON.stringify(resumeOn)}`,
      );
    }
  }

  if (decision === "mark-duplicate") {
    if (!("linked_to" in obj)) {
      throw new CandidatesLogError("decision 'mark-duplicate' requires 'linked_to'");
    }
    const linkedTo = obj.linked_to;
    if (typeof linkedTo !== "number" || !Number.isInteger(linkedTo) || linkedTo < 1) {
      throw new CandidatesLogError(
        `linked_to must be a positive int, got ${JSON.stringify(linkedTo)}`,
      );
    }
  } else if ("linked_to" in obj) {
    throw new CandidatesLogError("'linked_to' is only valid for decision='mark-duplicate'");
  }

  if (PRIOR_REQUIRED_DECISIONS.has(decision)) {
    if (!("prior_decision_id" in obj)) {
      throw new CandidatesLogError(
        `decision ${JSON.stringify(decision)} requires 'prior_decision_id'`,
      );
    }
    const pid = obj.prior_decision_id;
    if (typeof pid !== "string" || !UUID_PATTERN.test(pid)) {
      throw new CandidatesLogError(
        `prior_decision_id must be a UUID string, got ${JSON.stringify(pid)}`,
      );
    }
  } else if ("prior_decision_id" in obj) {
    throw new CandidatesLogError(
      `'prior_decision_id' is only valid for decision in ${JSON.stringify([...PRIOR_REQUIRED_DECISIONS].sort())}`,
    );
  }
}

function resolvePath(path: string | null | undefined): string {
  return path !== undefined && path !== null ? resolve(path) : DEFAULT_LOG_PATH;
}

function acquireAppendLock(logPath: string): () => void {
  while (threadLocked) {
    // spin-wait for in-process serialization
  }
  threadLocked = true;

  const lockPath = join(dirname(logPath), `${logPath.split(/[/\\]/).pop()}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 30_000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      if (Date.now() > deadline) {
        threadLocked = false;
        throw new CandidatesLogError("timed out acquiring candidates log lock");
      }
      const spinEnd = Date.now() + 20;
      while (Date.now() < spinEnd) {
        // brief spin
      }
    }
  }
  writeSync(fd, Buffer.from("\0"));

  return () => {
    try {
      if (fd !== null) {
        closeSync(fd);
      }
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
    threadLocked = false;
  };
}

export function validateCandidatesEntry(entry: unknown): void {
  validateEntry(entry);
}

export function append(
  entry: Record<string, unknown>,
  options: { path?: string | null } = {},
): string {
  validateEntry(entry);
  const logPath = resolvePath(options.path);
  mkdirSync(dirname(logPath), { recursive: true });
  const line = JSON.stringify(entry, Object.keys(entry).sort());
  const release = acquireAppendLock(logPath);
  try {
    const fd = openSync(logPath, "a");
    try {
      writeSync(fd, Buffer.from(`${line}\n`, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    release();
  }
  return String(entry.decision_id);
}

export function readAll(
  repo: string | null = null,
  options: { path?: string | null; warn?: (msg: string) => void } = {},
): Record<string, unknown>[] {
  const logPath = resolvePath(options.path);
  if (!existsSync(logPath)) {
    return [];
  }
  const warn = options.warn ?? (() => {});
  const out: Record<string, unknown>[] = [];
  const lines = readFileSync(logPath, "utf8").split("\n");
  for (let lineno = 0; lineno < lines.length; lineno += 1) {
    const stripped = lines[lineno]?.trim() ?? "";
    if (stripped.length === 0) {
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(stripped);
    } catch (exc) {
      warn(`candidates.jsonl: skipping malformed JSON on line ${lineno + 1}: ${String(exc)}`);
      continue;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      warn(`candidates.jsonl: skipping non-object entry on line ${lineno + 1} (got ${typeof obj})`);
      continue;
    }
    const record = obj as Record<string, unknown>;
    if (repo !== null && record.repo !== repo) {
      continue;
    }
    out.push(record);
  }
  return out;
}

export function findByIssue(
  issueNumber: number,
  repo: string,
  options: { path?: string | null } = {},
): Record<string, unknown>[] {
  return readAll(repo, options).filter((e) => e.issue_number === issueNumber);
}

export function latestDecision(
  issueNumber: number,
  repo: string,
  options: { path?: string | null } = {},
): Record<string, unknown> | null {
  const rows = findByIssue(issueNumber, repo, options);
  if (rows.length === 0) {
    return null;
  }
  rows.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return rows[rows.length - 1] ?? null;
}

export function newDecisionId(): string {
  return randomUUID();
}
