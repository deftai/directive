import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ACTION_FN_NAMES: Readonly<Record<string, string>> = {
  accept: "accept",
  reject: "reject",
  defer: "defer",
  "needs-ac": "needs_ac",
};

export const TERMINAL_DECISIONS: ReadonlySet<string> = new Set([
  "accept",
  "reject",
  "mark-duplicate",
]);

export const IN_PROGRESS_DECISIONS: ReadonlySet<string> = new Set(["defer", "needs-ac"]);

const REPO_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const CACHE_SOURCE = "github-issue";

export class CacheEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheEmptyError";
  }
}

export interface CacheGetResult {
  readonly entryDir: string;
}

export interface CacheModule {
  cacheGet(
    source: string,
    key: string,
    options: { cacheRoot: string; allowStale: boolean },
  ): CacheGetResult;
  CacheNotFoundError: new (message?: string) => Error;
  CacheValidationError: new (message?: string) => Error;
  CacheError: new (message?: string) => Error;
}

export interface TriageActionsModule {
  accept(issueNumber: number, repo: string, ...args: unknown[]): void;
  reject(issueNumber: number, repo: string, ...args: unknown[]): void;
  defer(issueNumber: number, repo: string, ...args: unknown[]): void;
  needs_ac(issueNumber: number, repo: string, ...args: unknown[]): void;
}

export interface AuditEntry {
  readonly issue_number?: number;
  readonly timestamp?: string;
  readonly decision?: string;
  readonly repo?: string;
}

export interface CandidatesLogModule {
  readAll(options: { repo: string }): AuditEntry[];
}

export interface IssuePayload {
  readonly number?: number;
  readonly labels?: ReadonlyArray<{ name?: string }>;
  readonly author?: { login?: string };
  readonly createdAt?: string;
}

export interface BulkActionOptions {
  readonly label?: string | null;
  readonly author?: string | null;
  readonly ageDays?: number | null;
  readonly cluster?: string | null;
  readonly reason?: string | null;
  readonly reAction?: boolean;
  readonly cacheRoot?: string | null;
  readonly actionsModule?: TriageActionsModule;
  readonly cacheModule?: CacheModule;
  readonly candidatesLogModule?: CandidatesLogModule;
  readonly issuesProvider?: (repo: string) => IssuePayload[];
  readonly now?: Date;
  readonly out?: { write: (text: string) => void };
}

const SIGNATURE_TYPEERROR_TOKENS = [
  "unexpected keyword argument",
  "got multiple values for",
  "missing 1 required positional argument",
  "takes 2 positional arguments",
  "takes 3 positional arguments",
];

export function parseRepo(repo: string): [string, string] {
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error(`repo must be a non-empty 'owner/name' string (got ${JSON.stringify(repo)})`);
  }
  const m = REPO_RE.exec(repo.trim());
  if (m === null) {
    throw new Error(
      `invalid repo ${JSON.stringify(repo)}: expected 'owner/name' ` +
        "(alphanumerics, '.', '_', '-' only)",
    );
  }
  if (m[1] === undefined || m[2] === undefined) {
    throw new Error(`invalid repo ${JSON.stringify(repo)}`);
  }
  return [m[1], m[2]];
}

function cacheRootPath(cacheRoot: string | null | undefined): string {
  return cacheRoot !== null && cacheRoot !== undefined ? cacheRoot : ".deft-cache";
}

export function iterCacheKeys(repo: string, cacheRoot?: string | null): string[] {
  const [owner, name] = parseRepo(repo);
  const base = join(cacheRootPath(cacheRoot), CACHE_SOURCE, owner, name);
  if (!existsSync(base)) {
    return [];
  }
  const keys: string[] = [];
  const entries = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    keys.push(`${owner}/${name}/${entry}`);
  }
  return keys;
}

export function listCachedCandidates(
  repo: string,
  options: {
    cacheRoot?: string | null;
    cacheModule: CacheModule;
    out?: { write: (text: string) => void };
  },
): IssuePayload[] {
  const sink = options.out ?? { write: (t: string) => process.stderr.write(t) };
  const root = cacheRootPath(options.cacheRoot);
  const keys = iterCacheKeys(repo, root);
  const candidates: IssuePayload[] = [];

  for (const key of keys) {
    try {
      const result = options.cacheModule.cacheGet(CACHE_SOURCE, key, {
        cacheRoot: root,
        allowStale: true,
      });
      const rawPath = join(result.entryDir, "raw.json");
      let rawText: string;
      try {
        rawText = readFileSync(rawPath, { encoding: "utf8" });
      } catch (exc: unknown) {
        sink.write(
          `[triage:bulk] WARN: skipping unreadable raw.json for ${key}: ` +
            `${exc instanceof Error ? exc.constructor.name : typeof exc}: ${String(exc)}\n`,
        );
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawText) as unknown;
      } catch (exc: unknown) {
        sink.write(`[triage:bulk] WARN: skipping malformed raw.json for ${key}: ${String(exc)}\n`);
        continue;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        sink.write(
          `[triage:bulk] WARN: skipping non-object raw.json for ${key} ` +
            `(got ${Array.isArray(payload) ? "list" : typeof payload})\n`,
        );
        continue;
      }
      candidates.push(payload as IssuePayload);
    } catch (exc: unknown) {
      const NotFound = options.cacheModule.CacheNotFoundError;
      const Validation = options.cacheModule.CacheValidationError;
      const CacheError = options.cacheModule.CacheError;
      if (exc instanceof NotFound) {
        sink.write(`[triage:bulk] WARN: cache miss for ${key}: ${String(exc)}\n`);
      } else if (exc instanceof Validation) {
        sink.write(`[triage:bulk] WARN: invalid meta.json for ${key}: ${String(exc)}\n`);
      } else if (exc instanceof CacheError) {
        sink.write(`[triage:bulk] WARN: cache error for ${key}: ${String(exc)}\n`);
      } else {
        throw exc;
      }
    }
  }
  return candidates;
}

export function filterIssues(
  issues: Iterable<IssuePayload>,
  options: {
    label?: string | null;
    author?: string | null;
    ageDays?: number | null;
    cluster?: string | null;
    now?: Date;
  },
): IssuePayload[] {
  const now = options.now ?? new Date();
  const cutoff =
    options.ageDays !== null && options.ageDays !== undefined
      ? new Date(now.getTime() - options.ageDays * 24 * 60 * 60 * 1000)
      : null;

  const matched: IssuePayload[] = [];
  for (const issue of issues) {
    const labels = (issue.labels ?? [])
      .map((entry) => (typeof entry === "object" && entry !== null ? entry.name : undefined))
      .filter((n): n is string => typeof n === "string");

    if (options.label !== null && options.label !== undefined && !labels.includes(options.label)) {
      continue;
    }

    if (options.author !== null && options.author !== undefined) {
      const actor = issue.author;
      const login = typeof actor === "object" && actor !== null ? actor.login : undefined;
      if (login !== options.author) {
        continue;
      }
    }

    if (cutoff !== null) {
      const createdRaw = issue.createdAt;
      if (!createdRaw) {
        continue;
      }
      const createdAt = new Date(String(createdRaw).replace("Z", "+00:00"));
      if (Number.isNaN(createdAt.getTime()) || createdAt > cutoff) {
        continue;
      }
    }

    if (options.cluster !== null && options.cluster !== undefined) {
      const clusterLabel = `cluster:${options.cluster}`;
      if (!labels.some((name) => name === clusterLabel || name === options.cluster)) {
        continue;
      }
    }

    matched.push(issue);
  }
  return matched;
}

function buildSkipSet(reAction: boolean): ReadonlySet<string> {
  if (reAction) {
    return TERMINAL_DECISIONS;
  }
  return new Set([...TERMINAL_DECISIONS, ...IN_PROGRESS_DECISIONS]);
}

function latestDecisionByIssue(
  repo: string,
  candidatesLogModule: CandidatesLogModule,
): Map<number, AuditEntry> {
  const latest = new Map<number, AuditEntry>();
  for (const entry of candidatesLogModule.readAll({ repo })) {
    const n = entry.issue_number;
    if (typeof n !== "number" || !Number.isInteger(n)) {
      continue;
    }
    const ts = String(entry.timestamp ?? "");
    const prior = latest.get(n);
    if (prior === undefined || ts > String(prior.timestamp ?? "")) {
      latest.set(n, entry);
    }
  }
  return latest;
}

export function excludeLogged(
  candidates: Iterable<IssuePayload>,
  options: {
    repo: string;
    reAction: boolean;
    candidatesLogModule: CandidatesLogModule;
    out?: { write: (text: string) => void };
  },
): IssuePayload[] {
  const skipSet = buildSkipSet(options.reAction);
  const latest = latestDecisionByIssue(options.repo, options.candidatesLogModule);
  const kept: IssuePayload[] = [];
  let skipped = 0;

  for (const issue of candidates) {
    let n: number;
    try {
      n = Number(issue.number);
      if (!Number.isInteger(n)) {
        throw new TypeError("not int");
      }
    } catch {
      kept.push(issue);
      continue;
    }
    const prior = latest.get(n);
    if (prior === undefined) {
      kept.push(issue);
      continue;
    }
    if (skipSet.has(String(prior.decision ?? ""))) {
      skipped += 1;
      continue;
    }
    kept.push(issue);
  }

  if (skipped > 0) {
    let msg = `[triage:bulk] skipped ${skipped} candidate(s) with prior audit-log records`;
    if (!options.reAction) {
      msg += " (pass --re-action to override defer/needs-ac records)";
    }
    const sink = options.out ?? { write: (t: string) => process.stderr.write(t) };
    sink.write(`${msg}\n`);
  }
  return kept;
}

function isSignatureMismatch(exc: unknown): boolean {
  if (!(exc instanceof TypeError)) {
    return false;
  }
  const msg = String(exc.message);
  return SIGNATURE_TYPEERROR_TOKENS.some((token) => msg.includes(token));
}

function invokeAction(
  fn: (...args: unknown[]) => void,
  issueNumber: number,
  repo: string,
  actionKey: string,
  reason: string | null | undefined,
): void {
  const kwargs: Record<string, unknown> = {};
  if (actionKey === "reject" && reason !== null && reason !== undefined) {
    kwargs.reason = reason;
  }
  try {
    if (Object.keys(kwargs).length > 0) {
      fn(issueNumber, repo, kwargs);
    } else {
      fn(issueNumber, repo);
    }
  } catch (exc: unknown) {
    if (!isSignatureMismatch(exc)) {
      throw exc;
    }
    if (actionKey === "reject" && reason !== null && reason !== undefined) {
      fn(issueNumber, repo, reason);
    } else {
      fn(issueNumber, repo);
    }
  }
}

function resolveAction(
  actionsModule: TriageActionsModule,
  actionKey: string,
): (...args: unknown[]) => void {
  const fnName = ACTION_FN_NAMES[actionKey];
  if (fnName === undefined) {
    throw new Error(`Unknown bulk action: ${JSON.stringify(actionKey)}`);
  }
  const fn = (actionsModule as unknown as Record<string, unknown>)[fnName];
  if (typeof fn !== "function") {
    throw new Error(`triage_actions.${fnName} not found (Story 3 contract violated)`);
  }
  return fn as (...args: unknown[]) => void;
}

/** Execute bulk action over the filtered candidate set. */
export function bulkAction(
  actionKey: string,
  repo: string,
  options: BulkActionOptions = {},
): number {
  if (!(actionKey in ACTION_FN_NAMES)) {
    throw new Error(`Unknown bulk action: ${JSON.stringify(actionKey)}`);
  }

  const sink = options.out ?? { write: (t: string) => process.stdout.write(t) };
  let candidates: IssuePayload[];
  if (options.issuesProvider !== undefined) {
    candidates = options.issuesProvider(repo);
  } else if (options.cacheModule !== undefined) {
    candidates = listCachedCandidates(repo, {
      cacheRoot: options.cacheRoot,
      cacheModule: options.cacheModule,
      out: sink,
    });
  } else {
    throw new Error("cache module not available -- cannot read the unified content cache");
  }

  if (candidates.length === 0) {
    throw new CacheEmptyError(
      `triage_bulk: cache is empty for ${repo}; run \`task triage:bootstrap\` first.`,
    );
  }

  let matched = filterIssues(candidates, {
    label: options.label,
    author: options.author,
    ageDays: options.ageDays,
    cluster: options.cluster,
    now: options.now,
  });

  if (options.candidatesLogModule !== undefined) {
    matched = excludeLogged(matched, {
      repo,
      reAction: options.reAction ?? false,
      candidatesLogModule: options.candidatesLogModule,
      out: sink,
    });
  }

  if (matched.length === 0) {
    sink.write(`[triage:bulk-${actionKey}] zero matches for given filters\n`);
    return 0;
  }

  if (options.actionsModule === undefined) {
    throw new Error("triage_actions module not available");
  }
  const fn = resolveAction(options.actionsModule, actionKey);

  let actioned = 0;
  for (const issue of matched) {
    let issueNumber: number;
    try {
      issueNumber = Number(issue.number);
      if (!Number.isInteger(issueNumber)) {
        throw new TypeError("not int");
      }
    } catch {
      sink.write(
        `[triage:bulk-${actionKey}] skipping malformed issue entry: ${JSON.stringify(issue)}\n`,
      );
      continue;
    }
    invokeAction(fn, issueNumber, repo, actionKey, options.reason);
    actioned += 1;
    sink.write(`[triage:bulk-${actionKey}] #${issueNumber} actioned\n`);
  }

  sink.write(`[triage:bulk-${actionKey}] total: ${actioned}\n`);
  return actioned;
}

export function createFilesystemCacheModule(): CacheModule {
  class CacheNotFoundError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "CacheNotFoundError";
    }
  }
  class CacheValidationError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "CacheValidationError";
    }
  }
  class CacheError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "CacheError";
    }
  }

  return {
    cacheGet(source: string, key: string, options: { cacheRoot: string; allowStale: boolean }) {
      const parts = key.split("/");
      if (parts.length !== 3) {
        throw new CacheError(`invalid cache key ${key}`);
      }
      const [o, r, n] = parts;
      if (o === undefined || r === undefined || n === undefined) {
        throw new CacheError(`invalid cache key ${key}`);
      }
      const entryDir = join(options.cacheRoot, source, o, r, n);
      const metaPath = join(entryDir, "meta.json");
      if (!existsSync(metaPath)) {
        throw new CacheNotFoundError(`no meta.json at ${metaPath}`);
      }
      try {
        JSON.parse(readFileSync(metaPath, { encoding: "utf8" }));
      } catch (exc: unknown) {
        throw new CacheValidationError(String(exc));
      }
      return { entryDir };
    },
    CacheNotFoundError,
    CacheValidationError,
    CacheError,
  };
}

export function createFilesystemCandidatesLogModule(
  logPath = "vbrief/.eval/candidates.jsonl",
): CandidatesLogModule {
  return {
    readAll(options: { repo: string }) {
      if (!existsSync(logPath)) {
        return [];
      }
      const entries: AuditEntry[] = [];
      for (const line of readFileSync(logPath, { encoding: "utf8" }).split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          const entry = JSON.parse(line) as AuditEntry;
          if (entry.repo !== options.repo) {
            continue;
          }
          entries.push(entry);
        } catch {
          // skip malformed lines
        }
      }
      return entries;
    },
  };
}

export function createPythonActionsModule(scriptsDir: string): TriageActionsModule {
  const runAction = (cmd: string, issueNumber: number, repo: string, extra: string[] = []) => {
    const result = spawnSync(
      "uv",
      [
        "run",
        "python",
        join(scriptsDir, "triage_actions.py"),
        cmd,
        String(issueNumber),
        "--repo",
        repo,
        ...extra,
      ],
      { encoding: "utf8", cwd: dirname(scriptsDir), stdio: ["ignore", "pipe", "pipe"] },
    );
    if ((result.status ?? 2) !== 0) {
      throw new Error(
        `triage_actions ${cmd} failed: ${typeof result.stderr === "string" ? result.stderr : ""}`,
      );
    }
  };
  return {
    accept(n, repo) {
      runAction("accept", n, repo);
    },
    reject(n, repo, ...args: unknown[]) {
      let reason: string | undefined;
      if (typeof args[0] === "object" && args[0] !== null && "reason" in (args[0] as object)) {
        reason = String((args[0] as { reason: unknown }).reason);
      } else if (typeof args[0] === "string") {
        reason = args[0];
      }
      const extra = reason !== undefined && reason.length > 0 ? ["--reason", reason] : [];
      runAction("reject", n, repo, extra);
    },
    defer(n, repo) {
      runAction("defer", n, repo, ["--reason", "bulk defer"]);
    },
    needs_ac(n, repo) {
      runAction("needs-ac", n, repo);
    },
  };
}

export interface DefaultBulkDepsOptions {
  readonly cacheRoot?: string;
  readonly candidatesLogPath?: string;
  readonly scriptsDir?: string;
  readonly deftRoot?: string;
}

export function bulkActionWithDefaults(
  actionKey: string,
  repo: string,
  options: BulkActionOptions & DefaultBulkDepsOptions = {},
): number {
  const deftRoot = options.deftRoot ?? process.cwd();
  const scriptsDir = options.scriptsDir ?? join(deftRoot, "scripts");
  return bulkAction(actionKey, repo, {
    ...options,
    cacheRoot: options.cacheRoot ?? join(deftRoot, ".deft-cache"),
    cacheModule: options.cacheModule ?? createFilesystemCacheModule(),
    candidatesLogModule:
      options.candidatesLogModule ?? createFilesystemCandidatesLogModule(options.candidatesLogPath),
    actionsModule: options.actionsModule ?? createPythonActionsModule(scriptsDir),
  });
}
