#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeReferencedIssueNumbers,
  buildQueue,
  collectOrphanIssueNumbers,
  DEFAULT_QUEUE_LIMIT,
  loadCachedIssues,
  loadSliceRecords,
  readAuditEntries,
  renderQueue,
  resolveRankingLabels,
  resolveRepo,
} from "@deftai/directive-core/dist/triage/queue/index.js";

interface ParsedArgs {
  projectRoot: string;
  repo: string | null;
  limit: number;
  includeBlocked: boolean;
  cacheRoot: string | null;
  auditLog: string | null;
  slicesLog: string | null;
  error?: string;
}

/** Parse triage-queue CLI args for the queue subcommand. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? ".",
    repo: process.env.DEFT_TRIAGE_REPO ?? null,
    limit: DEFAULT_QUEUE_LIMIT,
    includeBlocked: false,
    cacheRoot: null,
    auditLog: null,
    slicesLog: null,
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
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
      continue;
    }
    if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
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
    if (arg === "--cache-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --cache-root: expected one argument" };
      }
      parsed.cacheRoot = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--cache-root=")) {
      parsed.cacheRoot = arg.slice("--cache-root=".length);
      continue;
    }
    if (arg === "--audit-log") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --audit-log: expected one argument" };
      }
      parsed.auditLog = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--audit-log=")) {
      parsed.auditLog = arg.slice("--audit-log=".length);
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

function resolveFrameworkRoot(): string {
  const fromEnv = process.env.DEFT_ROOT?.trim() ?? "";
  if (fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Run triage:queue and return process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
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

  const issuesForQueue = loadCachedIssues(repo, { projectRoot });
  const issuesWithClosed = loadCachedIssues(repo, { projectRoot, includeClosed: true });
  const issuesByNumber = new Map(issuesWithClosed.map((row) => [row.number, row] as const));
  const auditEntries = readAuditEntries(repo, {
    frameworkRoot: resolveFrameworkRoot(),
    auditLogPath: args.auditLog,
  });
  const rankingLabels = resolveRankingLabels(projectRoot);
  const activeRefs = activeReferencedIssueNumbers(projectRoot);
  const sliceRecords = loadSliceRecords({
    frameworkRoot: resolveFrameworkRoot(),
    slicesLogPath: args.slicesLog,
  });
  const orphanNumbers = collectOrphanIssueNumbers(sliceRecords, issuesByNumber);
  const limit = args.limit === 0 ? null : Math.max(0, args.limit);

  const items = buildQueue(issuesForQueue, auditEntries, {
    repo,
    queue: {
      rankingLabels,
      activeReferenced: activeRefs,
      orphanIssueNumbers: orphanNumbers,
      includeBlocked: args.includeBlocked,
      limit,
    },
  });

  process.stdout.write(
    `${renderQueue({
      items,
      repo,
      limit,
      rankingLabels,
    })}\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
