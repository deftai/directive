#!/usr/bin/env node
/**
 * triage:queue / triage:show CLI (#1128 / #2890).
 *
 * Subcommands:
 *   queue  — ranked queue (default when first token is not show/audit)
 *   show   — per-issue detail; --format=operator for Phase 3 brief backbone
 *
 * audit remains routed here by Taskfile; not reimplemented in this story.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTriageCacheHydrated } from "@deftai/directive-core/dist/cache/empty-populate.js";
import { findByIssue } from "@deftai/directive-core/dist/triage/actions/candidates-log.js";
import { resolveTriageCachePath } from "@deftai/directive-core/dist/triage/cache-path.js";
import {
  activeReferencedIssueNumbers,
  buildQueue,
  collectOrphanIssueNumbers,
  DEFAULT_QUEUE_LIMIT,
  formatAuthorFilterLine,
  type LiveOpenIssuesReader,
  loadCachedIssueDetail,
  loadCachedIssues,
  loadSliceRecords,
  partitionByAuthorFilter,
  type ResolveAuthenticatedLogin,
  readAuditEntries,
  reconcileLiveOpenState,
  renderOperatorBrief,
  renderQueue,
  renderShow,
  resolveAuthorFilter,
  resolveRankingLabels,
  resolveRepo,
} from "@deftai/directive-core/dist/triage/queue/index.js";
import { resolveScopeIgnores } from "@deftai/directive-core/dist/triage/scope-drift/index.js";

export type ShowFormat = "default" | "operator";

interface CommonArgs {
  projectRoot: string;
  repo: string | null;
  cacheRoot: string | null;
  auditLog: string | null;
  error?: string;
}

interface QueueArgs extends CommonArgs {
  cmd: "queue";
  limit: number;
  includeBlocked: boolean;
  reconcile: boolean;
  slicesLog: string | null;
  /** Raw --author value (LOGIN, @me, or comma allow-list); null = no filter (#3129). */
  author: string | null;
}

interface ShowArgs extends CommonArgs {
  cmd: "show";
  number: number | null;
  format: ShowFormat;
}

function baseArgs(): CommonArgs {
  return {
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? ".",
    repo: process.env.DEFT_TRIAGE_REPO ?? null,
    cacheRoot: null,
    auditLog: null,
  };
}

function parseCommonFlag(
  arg: string | undefined,
  argv: string[],
  i: number,
  parsed: CommonArgs,
): { consumed: number; error?: string } | null {
  if (arg === "--project-root") {
    const value = argv[i + 1];
    if (value === undefined) {
      return { consumed: 0, error: "argument --project-root: expected one argument" };
    }
    parsed.projectRoot = value;
    return { consumed: 1 };
  }
  if (arg?.startsWith("--project-root=")) {
    parsed.projectRoot = arg.slice("--project-root=".length);
    return { consumed: 0 };
  }
  if (arg === "--repo") {
    const value = argv[i + 1];
    if (value === undefined) {
      return { consumed: 0, error: "argument --repo: expected one argument" };
    }
    parsed.repo = value;
    return { consumed: 1 };
  }
  if (arg?.startsWith("--repo=")) {
    parsed.repo = arg.slice("--repo=".length);
    return { consumed: 0 };
  }
  if (arg === "--cache-root") {
    const value = argv[i + 1];
    if (value === undefined) {
      return { consumed: 0, error: "argument --cache-root: expected one argument" };
    }
    parsed.cacheRoot = value;
    return { consumed: 1 };
  }
  if (arg?.startsWith("--cache-root=")) {
    parsed.cacheRoot = arg.slice("--cache-root=".length);
    return { consumed: 0 };
  }
  if (arg === "--audit-log") {
    const value = argv[i + 1];
    if (value === undefined) {
      return { consumed: 0, error: "argument --audit-log: expected one argument" };
    }
    parsed.auditLog = value;
    return { consumed: 1 };
  }
  if (arg?.startsWith("--audit-log=")) {
    parsed.auditLog = arg.slice("--audit-log=".length);
    return { consumed: 0 };
  }
  return null;
}

/** Parse triage-queue CLI args (queue subcommand — default). */
export function parseArgs(argv: string[]): QueueArgs {
  const common = baseArgs();
  const parsed: QueueArgs = {
    ...common,
    cmd: "queue",
    limit: DEFAULT_QUEUE_LIMIT,
    includeBlocked: false,
    reconcile: true,
    slicesLog: null,
    author: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "queue") {
      continue;
    }
    if (arg === "--include-blocked") {
      parsed.includeBlocked = true;
      continue;
    }
    if (arg === "--no-reconcile") {
      parsed.reconcile = false;
      continue;
    }
    if (arg === "--author-mine") {
      // #1318 Layer 1 optional alias for --author @me
      parsed.author = "@me";
      continue;
    }
    if (arg === "--author") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --author: expected one argument" };
      }
      parsed.author = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--author=")) {
      parsed.author = arg.slice("--author=".length);
      continue;
    }
    const commonHit = parseCommonFlag(arg, argv, i, parsed);
    if (commonHit !== null) {
      if (commonHit.error !== undefined) {
        return { ...parsed, error: commonHit.error };
      }
      i += commonHit.consumed;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --limit: expected one argument" };
      }
      const parsedLimit = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedLimit)) {
        return { ...parsed, error: `argument --limit: invalid int value: '${value}'` };
      }
      parsed.limit = parsedLimit;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--limit=")) {
      const value = arg.slice("--limit=".length);
      const parsedLimit = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedLimit)) {
        return { ...parsed, error: `argument --limit: invalid int value: '${value}'` };
      }
      parsed.limit = parsedLimit;
      continue;
    }
    if (arg === "--slices-log") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --slices-log: expected one argument" };
      }
      parsed.slicesLog = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--slices-log=")) {
      parsed.slicesLog = arg.slice("--slices-log=".length);
      continue;
    }
    if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Parse show subcommand args. */
export function parseShowArgs(argv: string[]): ShowArgs {
  const common = baseArgs();
  const parsed: ShowArgs = {
    ...common,
    cmd: "show",
    number: null,
    format: "default",
  };

  // Skip leading "show" token if present
  let start = 0;
  if (argv[0] === "show") {
    start = 1;
  }

  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    const commonHit = parseCommonFlag(arg, argv, i, parsed);
    if (commonHit !== null) {
      if (commonHit.error !== undefined) {
        return { ...parsed, error: commonHit.error };
      }
      i += commonHit.consumed;
      continue;
    }
    if (arg === "--format") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --format: expected one argument" };
      }
      if (value !== "default" && value !== "operator" && value !== "plain" && value !== "text") {
        return {
          ...parsed,
          error: `argument --format: invalid choice: '${value}' (choose from default, operator)`,
        };
      }
      parsed.format = value === "operator" ? "operator" : "default";
      i += 1;
      continue;
    }
    if (arg?.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "default" && value !== "operator" && value !== "plain" && value !== "text") {
        return {
          ...parsed,
          error: `argument --format: invalid choice: '${value}' (choose from default, operator)`,
        };
      }
      parsed.format = value === "operator" ? "operator" : "default";
      continue;
    }
    if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
    // positional issue number — strict positive int (reject "42abc" / "42.5")
    if (!/^[1-9]\d*$/u.test(arg ?? "")) {
      return { ...parsed, error: `argument number: invalid int value: '${arg}'` };
    }
    parsed.number = Number(arg);
  }
  if (parsed.number === null && parsed.error === undefined) {
    return { ...parsed, error: "triage:show: issue number is required (e.g. triage:show -- 42)" };
  }
  return parsed;
}

/** Optional injection seams for `run` (tests supply stubs). */
export interface RunOptions {
  readonly liveOpenReader?: LiveOpenIssuesReader;
  /** Override `@me` resolution for hermetic tests (#3129). */
  readonly resolveAuthenticatedLogin?: ResolveAuthenticatedLogin;
}

function runQueue(args: QueueArgs, options: RunOptions = {}): number {
  if (args.error !== undefined) {
    process.stderr.write(`triage_queue: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const repo = resolveRepo(args.repo, projectRoot);
  if (repo === null) {
    process.stderr.write("triage:queue: --repo OWNER/NAME (or $DEFT_TRIAGE_REPO) is required.\n");
    return 2;
  }

  let authorFilterLine: string | null = null;
  let authorAllow: ReturnType<typeof resolveAuthorFilter>["filter"] | undefined;
  if (args.author !== null && args.author.length > 0) {
    const resolved = resolveAuthorFilter(
      args.author,
      options.resolveAuthenticatedLogin ?? undefined,
    );
    if (resolved.error !== undefined) {
      process.stderr.write(`triage:queue: ${resolved.error}\n`);
      return 2;
    }
    authorAllow = resolved.filter;
  }

  ensureTriageCacheHydrated(projectRoot, { repo });

  const cachedForQueue = loadCachedIssues(repo, { projectRoot });
  let issuesForQueue = args.reconcile
    ? reconcileLiveOpenState(cachedForQueue, repo, options.liveOpenReader)
    : cachedForQueue;

  if (authorAllow !== undefined) {
    const partition = partitionByAuthorFilter(
      issuesForQueue,
      (row) => row.author ?? null,
      authorAllow,
    );
    issuesForQueue = [...partition.matched];
    authorFilterLine = formatAuthorFilterLine(authorAllow, {
      unknownCount: partition.unknownCount,
    });
  }

  const issuesWithClosed = loadCachedIssues(repo, { projectRoot, includeClosed: true });
  const issuesByNumber = new Map(issuesWithClosed.map((row) => [row.number, row] as const));
  const auditEntries = readAuditEntries(repo, {
    auditLogPath: args.auditLog ?? resolveTriageCachePath(projectRoot, "candidates.jsonl"),
  });
  const rankingLabels = resolveRankingLabels(projectRoot);
  const activeRefs = activeReferencedIssueNumbers(projectRoot);
  const sliceRecords = loadSliceRecords({
    slicesLogPath: args.slicesLog ?? resolveTriageCachePath(projectRoot, "slices.jsonl"),
  });
  const orphanNumbers = collectOrphanIssueNumbers(sliceRecords, issuesByNumber);
  const limit = args.limit === 0 ? null : Math.max(0, args.limit);

  const scopeIgnores = resolveScopeIgnores(projectRoot);
  const items = buildQueue(issuesForQueue, auditEntries, {
    repo,
    queue: {
      rankingLabels,
      activeReferenced: activeRefs,
      orphanIssueNumbers: orphanNumbers,
      includeBlocked: args.includeBlocked,
      limit,
      scopeIgnores,
    },
  });

  process.stdout.write(
    `${renderQueue({
      items,
      repo,
      limit,
      rankingLabels,
      authorFilterLine,
    })}\n`,
  );
  return 0;
}

function runShow(args: ShowArgs): number {
  if (args.error !== undefined) {
    process.stderr.write(`triage:show: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const repo = resolveRepo(args.repo, projectRoot);
  if (repo === null) {
    process.stderr.write("triage:show: --repo OWNER/NAME (or $DEFT_TRIAGE_REPO) is required.\n");
    return 2;
  }
  const number = args.number;
  if (number === null) {
    process.stderr.write("triage:show: issue number is required\n");
    return 2;
  }

  const cacheRoot =
    args.cacheRoot !== null && args.cacheRoot.length > 0 ? resolve(args.cacheRoot) : null;
  ensureTriageCacheHydrated(projectRoot, {
    repo,
    ...(cacheRoot !== null ? { cacheRoot } : {}),
  });

  const issue = loadCachedIssueDetail(repo, number, {
    projectRoot,
    cacheRoot,
  });
  const logPath = args.auditLog ?? resolveTriageCachePath(projectRoot, "candidates.jsonl");
  const history = findByIssue(number, repo, logPath)
    .slice()
    .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  const latest = history.length > 0 ? (history[history.length - 1] ?? null) : null;
  const activeRefs = activeReferencedIssueNumbers(projectRoot);
  const inActive = activeRefs.has(number);

  if (args.format === "operator") {
    process.stdout.write(
      `${renderOperatorBrief({
        issue,
        repo,
        number,
        latestDecision: latest,
        inActiveXbrief: inActive,
      })}\n`,
    );
  } else {
    process.stdout.write(
      `${renderShow({
        issue,
        repo,
        number,
        latestDecision: latest,
        history,
        inActiveXbrief: inActive,
      })}\n`,
    );
  }
  return issue !== null ? 0 : 1;
}

/** Run triage:queue or triage:show and return process exit code. */
export function run(argv: string[], options: RunOptions = {}): number {
  const first = argv[0];
  if (first === "show") {
    return runShow(parseShowArgs(argv));
  }
  // Other subcommands (e.g. audit) keep prior queue-module routing until
  // separately ported; only `show` is specialized here (#2890).
  return runQueue(parseArgs(argv), options);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
