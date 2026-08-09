#!/usr/bin/env node
/**
 * CLI for task swarm:pre-dispatch (#3228).
 *
 * Exit codes:
 *   0 — allow (begin succeeded / complete-cancel succeeded)
 *   1 — gate deny (e.g. DENY_DUPLICATE_ACTIVE) or complete with no active attempt
 *   2 — config / usage error
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CONFIG_ERROR } from "./constants.js";
import {
  COMPLETE_STATUSES,
  type CompleteStatus,
  formatPreDispatchReport,
  PRE_DISPATCH_ACTIONS,
  type PreDispatchAction,
  swarmPreDispatch,
} from "./pre-dispatch.js";

export interface ParsedPreDispatchArgv {
  projectRoot: string;
  scopeId: string | null;
  targetId: string | null;
  workflowId: string | null;
  action: PreDispatchAction | null;
  sourceRevision: string | null;
  attemptId: string | null;
  status: CompleteStatus | null;
  workerId: string | null;
  externalRunId: string | null;
  json: boolean;
  help: boolean;
}

export function parsePreDispatchArgv(argv: string[]): ParsedPreDispatchArgv {
  const out: ParsedPreDispatchArgv = {
    projectRoot: ".",
    scopeId: null,
    targetId: null,
    workflowId: null,
    action: null,
    sourceRevision: null,
    attemptId: null,
    status: null,
    workerId: null,
    externalRunId: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--project-root" && argv[i + 1] !== undefined) {
      out.projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if ((arg === "--scope-id" || arg === "--scope") && argv[i + 1] !== undefined) {
      out.scopeId = argv[i + 1] ?? null;
      i += 1;
    } else if ((arg === "--target-id" || arg === "--target") && argv[i + 1] !== undefined) {
      out.targetId = argv[i + 1] ?? null;
      i += 1;
    } else if ((arg === "--workflow-id" || arg === "--workflow") && argv[i + 1] !== undefined) {
      out.workflowId = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--action" && argv[i + 1] !== undefined) {
      out.action = (argv[i + 1] ?? null) as PreDispatchAction | null;
      i += 1;
    } else if ((arg === "--source-revision" || arg === "--revision") && argv[i + 1] !== undefined) {
      out.sourceRevision = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--attempt-id" && argv[i + 1] !== undefined) {
      out.attemptId = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--status" && argv[i + 1] !== undefined) {
      out.status = (argv[i + 1] ?? null) as CompleteStatus | null;
      i += 1;
    } else if (arg === "--worker-id" && argv[i + 1] !== undefined) {
      out.workerId = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--external-run-id" && argv[i + 1] !== undefined) {
      out.externalRunId = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return out;
}

const USAGE = `Usage: task swarm:pre-dispatch -- --scope-id <id> --target-id <worktree|branch> [options]

Pre-dispatch gate for implement leaves (#3228 / #3143 DENY_DUPLICATE_ACTIVE).
Before spawning a peer implement leaf: run with default --action begin.
  exit 0  allow (attempt begun)
  exit 1  active deny / gate block (do not spawn)
  exit 2  config / usage error

Takeover: --action cancel, then pre-dispatch begin again (not concurrent dual active).
Terminal: --action complete [--status succeeded|failed|cancelled|blocked]

Options:
  --scope-id, --scope <id>         Unit scope (story/issue or xBRIEF plan id)
  --target-id, --target <id>       Unit target (worktree path or branch)
  --workflow-id, --workflow <id>   Default: drive-to:merge-ready
  --action begin|complete|cancel   Default: begin
  --source-revision <sha>          Default: git rev-parse HEAD
  --attempt-id <id>                For complete/cancel
  --status <status>                For complete: ${COMPLETE_STATUSES.join("|")}
  --worker-id <id>                 Optional worker stamp on begin
  --external-run-id <id>           Optional external run id
  --project-root <path>            Project root (ledger under .deft/delivery-attempts/)
  --json                           Machine-readable result on stdout
  -h, --help                       Show this help
`;

export function preDispatchMain(argv: string[] = process.argv.slice(2)): number {
  const parsed = parsePreDispatchArgv(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return EXIT_CONFIG_ERROR;
  }

  if (
    parsed.action !== null &&
    !(PRE_DISPATCH_ACTIONS as readonly string[]).includes(parsed.action)
  ) {
    process.stderr.write(`Error: --action must be one of: ${PRE_DISPATCH_ACTIONS.join(", ")}.\n`);
    return EXIT_CONFIG_ERROR;
  }
  if (parsed.status !== null && !(COMPLETE_STATUSES as readonly string[]).includes(parsed.status)) {
    process.stderr.write(`Error: --status must be one of: ${COMPLETE_STATUSES.join(", ")}.\n`);
    return EXIT_CONFIG_ERROR;
  }

  const result = swarmPreDispatch({
    projectRoot: resolve(parsed.projectRoot),
    scopeId: parsed.scopeId ?? "",
    targetId: parsed.targetId ?? "",
    workflowId: parsed.workflowId ?? undefined,
    action: parsed.action ?? undefined,
    sourceRevision: parsed.sourceRevision ?? undefined,
    attemptId: parsed.attemptId ?? undefined,
    status: parsed.status ?? undefined,
    workerId: parsed.workerId,
    externalRunId: parsed.externalRunId,
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatPreDispatchReport(result)}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(preDispatchMain());
}
