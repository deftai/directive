import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { maybeRunStalenessTickler } from "../staleness-tickler/run.js";
import { reconcileUmbrellas, renderUmbrellasReport } from "../vbrief-reconcile/umbrellas.js";
import { canonicalLogPath, readAll } from "./audit-log.js";
import { batchPromote } from "./batch-promote.js";
import { TRANSITIONS } from "./constants.js";
import {
  type DeliveryEvidenceInput,
  isNonDeliveryDisposition,
  type NonDeliveryDisposition,
} from "./delivery-evidence.js";
import {
  batchDemote,
  DEFAULT_OLDER_THAN_DAYS,
  demoteOne,
  resolveDemoteFilePath,
  resolveFilePath,
  resolveProjectRootStrict,
} from "./demote.js";
import {
  completedPathForScopeMove,
  findOpenUmbrellaReferences,
  renderOpenUmbrellaWarning,
} from "./open-umbrella-warning.js";
import { resolveProjectRoot } from "./project-context.js";
import { recordWipCapOverride, runTransition, type TransitionOptions } from "./transition.js";
import {
  findByDecisionId,
  isAlreadyUndone,
  REVERSIBLE_ACTIONS,
  undoBatch,
  undoOne,
} from "./undo.js";
import { checkWipCap, formatWipCapRefusal } from "./wip-cap-check.js";

export interface LifecycleArgs {
  action: string;
  file: string;
  projectRoot?: string;
  force?: boolean;
  batch?: boolean;
  batchFiles?: string[];
  /** Explicit non-delivery disposition for code-bearing complete (#3041). */
  nonDeliveryDisposition?: NonDeliveryDisposition;
  /** Optional delivery evidence flags for complete (#3041). */
  deliveryEvidence?: DeliveryEvidenceInput;
}

export interface DemoteArgs {
  file?: string;
  batch?: boolean;
  olderThanDays?: number;
  reason?: string;
  projectRoot?: string;
  actor?: string;
}

export interface UndoArgs {
  decisionId?: string;
  decisionIdPositional?: string;
  batchId?: string;
  latest?: boolean;
  dryRun?: boolean;
  actor?: string;
  projectRoot?: string;
}

const LIFECYCLE_USAGE_STDERR =
  "usage: scope_lifecycle.py [-h] [--project-root PROJECT_ROOT] [--force] [--batch]\n" +
  "                          {activate,block,cancel,complete,fail,promote,restore,unblock}\n" +
  "                          [file ...]\n" +
  "scope_lifecycle.py: error: the following arguments are required: action, file\n" +
  "(promote --batch may omit file and promotes all proposed/ scopes; #3011)\n";

function parseLifecycleArgv(argv: string[]): { args: LifecycleArgs | null; error?: string } {
  if (argv.length < 1) {
    return { args: null, error: "usage" };
  }
  const action = argv[0] ?? "";
  if (!(action in TRANSITIONS)) {
    return { args: null, error: "usage" };
  }
  let file = "";
  let projectRoot: string | undefined;
  let force = false;
  let batch = false;
  const batchFiles: string[] = [];
  let nonDeliveryDisposition: NonDeliveryDisposition | undefined;
  let prNumber: number | undefined;
  let mergeCommit: string | undefined;
  let prBase: string | undefined;
  let deliveryBranch: string | undefined;
  let repo: string | undefined;
  let mergedAt: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      return { args: null, error: "usage" };
    }
    if (arg === "--force") {
      force = true;
    } else if (arg === "--batch") {
      batch = true;
    } else if (arg === "--project-root") {
      projectRoot = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--non-delivery" || arg === "--non-delivery-disposition") {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || !isNonDeliveryDisposition(raw)) {
        return { args: null, error: "usage" };
      }
      nonDeliveryDisposition = raw;
    } else if (arg?.startsWith("--non-delivery=")) {
      const raw = arg.slice("--non-delivery=".length);
      if (!isNonDeliveryDisposition(raw)) {
        return { args: null, error: "usage" };
      }
      nonDeliveryDisposition = raw;
    } else if (arg === "--pr" && argv[i + 1] !== undefined) {
      prNumber = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      prNumber = Number.parseInt(arg.slice("--pr=".length), 10);
    } else if (arg === "--merge-commit" && argv[i + 1] !== undefined) {
      mergeCommit = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--merge-commit=")) {
      mergeCommit = arg.slice("--merge-commit=".length);
    } else if (arg === "--pr-base" && argv[i + 1] !== undefined) {
      prBase = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--pr-base=")) {
      prBase = arg.slice("--pr-base=".length);
    } else if (arg === "--delivery-branch" && argv[i + 1] !== undefined) {
      deliveryBranch = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--delivery-branch=")) {
      deliveryBranch = arg.slice("--delivery-branch=".length);
    } else if (arg === "--repo" && argv[i + 1] !== undefined) {
      repo = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--merged-at" && argv[i + 1] !== undefined) {
      mergedAt = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--merged-at=")) {
      mergedAt = arg.slice("--merged-at=".length);
    } else if (!arg.startsWith("-")) {
      if (batch) {
        batchFiles.push(arg);
      } else if (file.length === 0) {
        file = arg;
      } else {
        return { args: null, error: "usage" };
      }
    } else {
      return { args: null, error: "usage" };
    }
  }
  const deliveryEvidence: DeliveryEvidenceInput | undefined =
    prNumber !== undefined ||
    mergeCommit !== undefined ||
    prBase !== undefined ||
    deliveryBranch !== undefined ||
    repo !== undefined ||
    mergedAt !== undefined
      ? {
          prNumber: prNumber !== undefined && Number.isFinite(prNumber) ? prNumber : null,
          mergeCommit: mergeCommit ?? null,
          prBase: prBase ?? null,
          deliveryBranch: deliveryBranch ?? null,
          repository: repo ?? null,
          mergedAt: mergedAt ?? (mergeCommit !== undefined ? "supplied" : null),
          verifier: "scope:complete",
        }
      : undefined;
  if (batch) {
    if (action !== "promote") {
      return { args: null, error: "usage" };
    }
    return {
      args: {
        action,
        file: file.length > 0 ? file : "",
        projectRoot,
        force,
        batch: true,
        batchFiles: batchFiles.length > 0 ? batchFiles : file.length > 0 ? [file] : [],
      },
    };
  }
  if (file.length === 0) {
    return { args: null, error: "usage" };
  }
  return {
    args: {
      action,
      file,
      projectRoot,
      force,
      nonDeliveryDisposition,
      deliveryEvidence,
    },
  };
}

/** Main entry for scope_lifecycle.py parity. */
export function lifecycleMain(argv: string[]): number {
  const parsed = parseLifecycleArgv(argv);
  if (parsed.args === null) {
    if (parsed.error === "usage") {
      process.stderr.write(LIFECYCLE_USAGE_STDERR);
    }
    return 2;
  }
  const {
    action,
    file,
    projectRoot,
    force,
    batch,
    batchFiles,
    nonDeliveryDisposition,
    deliveryEvidence,
  } = parsed.args;

  if (batch === true && action === "promote") {
    const result = batchPromote({
      files: batchFiles && batchFiles.length > 0 ? batchFiles : undefined,
      force: force === true,
      projectRoot,
    });
    for (const line of result.messages) {
      process.stdout.write(`${line}\n`);
    }
    for (const line of result.skipped) {
      process.stdout.write(`  skipped: ${line}\n`);
    }
    if (!result.ok && result.exitCode !== 0) {
      for (const line of result.messages) {
        if (line.startsWith("ERROR:") || line.includes("WIP cap")) {
          process.stderr.write(`${line}\n`);
        }
      }
    }
    return result.exitCode;
  }

  const [filePath, error] = resolveFilePath(file, projectRoot);
  if (error !== null || filePath === null) {
    process.stderr.write(`Error: ${error}\n`);
    return 2;
  }

  let capCheck: ReturnType<typeof checkWipCap> | null = null;
  if (action === "promote") {
    const rootForCap = resolveProjectRoot(projectRoot);
    if (rootForCap !== null) {
      capCheck = checkWipCap(rootForCap, force === true);
      if (!capCheck.allowed) {
        process.stderr.write(`${formatWipCapRefusal(capCheck)}\n`);
        return 1;
      }
    }
  }

  const transitionOptions: TransitionOptions = {
    nonDeliveryDisposition,
    deliveryEvidence,
    verifier: "scope:complete",
  };
  const result = runTransition(action, filePath, new Date(), transitionOptions);
  if (result.ok) {
    if (action === "promote" && capCheck !== null && capCheck.forceOverride) {
      const rootForAudit = resolveProjectRoot(projectRoot);
      if (rootForAudit !== null) {
        const newPath = join(
          rootForAudit,
          "vbrief",
          "pending",
          filePath.split(/[/\\]/).pop() ?? "",
        );
        recordWipCapOverride(newPath, rootForAudit, capCheck);
      }
      process.stderr.write(
        "\u26a0  WIP cap exceeded " +
          `(count=${capCheck.count}, cap=${capCheck.cap}); promote allowed via --force. ` +
          "audit: vbrief/.eval/scope-lifecycle.jsonl entry tagged wip_cap_override (#1124).\n",
      );
    }
    process.stdout.write(`${result.message}\n`);
    if (action === "complete") {
      try {
        const completedPath = completedPathForScopeMove(filePath);
        const rootForWarning =
          resolveProjectRoot(projectRoot) ?? dirname(dirname(dirname(completedPath)));
        const refs = findOpenUmbrellaReferences(rootForWarning, completedPath);
        const warning = renderOpenUmbrellaWarning(refs);
        if (warning.length > 0) {
          process.stderr.write(`${warning}\n`);
          const [, outcome] = reconcileUmbrellas(rootForWarning);
          // Only surface a report when reconcile actually changed something or
          // recorded per-epic errors — skip vacuous setup failures (exit 2 with
          // empty buckets) so a missing lifecycle root does not spam stderr.
          if (outcome.changed.length > 0 || outcome.errors.length > 0) {
            process.stderr.write(`${renderUmbrellasReport(outcome)}\n`);
          }
        }
      } catch {
        /* best-effort drift warning + reconcile; lifecycle success remains authoritative */
      }
      try {
        const rootForTickler =
          resolveProjectRoot(projectRoot) ??
          dirname(dirname(dirname(completedPathForScopeMove(filePath))));
        const tickler = maybeRunStalenessTickler(rootForTickler);
        for (const line of tickler.lines) {
          process.stdout.write(`${line}\n`);
        }
      } catch {
        /* best-effort staleness tickler; lifecycle success remains authoritative */
      }
    }
    return 0;
  }
  process.stderr.write(`Error: ${result.message}\n`);
  return 1;
}

function parseDemoteArgv(argv: string[]): { args: DemoteArgs | null; error?: string } {
  const args: DemoteArgs = { reason: "operator-requested" };
  let positional = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      return { args: null, error: "usage" };
    }
    if (arg === "--batch") {
      args.batch = true;
    } else if (arg === "--older-than-days") {
      args.olderThanDays = Number(argv[i + 1]);
      i += 1;
    } else if (arg?.startsWith("--older-than-days=")) {
      args.olderThanDays = Number(arg.slice("--older-than-days=".length));
    } else if (arg === "--reason") {
      args.reason = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--reason=")) {
      args.reason = arg.slice("--reason=".length);
    } else if (arg === "--project-root") {
      args.projectRoot = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      args.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--actor") {
      args.actor = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith("-") && positional.length === 0) {
      positional = arg;
    } else {
      return { args: null, error: "usage" };
    }
  }
  if (args.batch === true) {
    return { args };
  }
  if (positional.length === 0) {
    return { args: null, error: "usage" };
  }
  args.file = positional;
  return { args };
}

/** Main entry for scope_demote.py parity (included in lifecycle family). */
export function demoteMain(argv: string[]): number {
  const parsed = parseDemoteArgv(argv);
  if (parsed.args === null) {
    process.stderr.write("usage: scope_demote.py <file> [--reason TEXT] [--project-root PATH]\n");
    return 2;
  }
  const args = parsed.args;
  if (args.batch === true) {
    const [root, err] = resolveProjectRootStrict(args.projectRoot);
    if (err !== null || root === null) {
      process.stderr.write(`Error: ${err}\n`);
      return 2;
    }
    const olderThan = args.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
    const [demoted, _entries, skipped] = batchDemote(root, olderThan, { actor: args.actor });
    process.stdout.write(
      `Batch demote: ${demoted} demoted, ${skipped.length} skipped (older-than-days=${olderThan}).\n`,
    );
    for (const line of skipped) {
      process.stdout.write(`  skipped: ${line}\n`);
    }
    return 0;
  }
  const [filePath, error] = resolveDemoteFilePath(args.file ?? "", args.projectRoot);
  if (error !== null || filePath === null) {
    process.stderr.write(`Error: ${error}\n`);
    return 2;
  }
  const [root, rootErr] = resolveProjectRootStrict(args.projectRoot);
  if (rootErr !== null || root === null) {
    process.stderr.write(`Error: ${rootErr}\n`);
    return 2;
  }
  const result = demoteOne(filePath, root, args.reason ?? "operator-requested", {
    actor: args.actor,
  });
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  process.stderr.write(`Error: ${result.message}\n`);
  return 1;
}

function parseUndoArgv(argv: string[]): { args: UndoArgs | null; error?: string; mutex?: string } {
  const args: UndoArgs = { actor: "operator" };
  let positional = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      return { args: null, error: "usage" };
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--latest") {
      args.latest = true;
    } else if (arg === "--decision-id") {
      args.decisionId = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--decision-id=")) {
      args.decisionId = arg.slice("--decision-id=".length);
    } else if (arg === "--batch-id") {
      args.batchId = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--batch-id=")) {
      args.batchId = arg.slice("--batch-id=".length);
    } else if (arg === "--project-root") {
      args.projectRoot = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      args.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--actor") {
      args.actor = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith("-") && positional.length === 0) {
      positional = arg;
    } else {
      return { args: null, error: "usage" };
    }
  }
  if (positional.length > 0) {
    args.decisionIdPositional = positional;
  }
  const decisionId = args.decisionId ?? args.decisionIdPositional;
  if (decisionId !== undefined && args.batchId !== undefined) {
    return {
      args: null,
      mutex:
        "Error: --decision-id (or positional <decision_id>) is mutually exclusive with --batch-id.",
    };
  }
  if (
    args.decisionIdPositional !== undefined &&
    args.decisionId !== undefined &&
    args.decisionIdPositional !== args.decisionId
  ) {
    return {
      args: null,
      mutex:
        `Error: positional <decision_id> conflicts with --decision-id ` +
        `('${args.decisionIdPositional}' vs '${args.decisionId}').`,
    };
  }
  if (args.latest === true && (decisionId !== undefined || args.batchId !== undefined)) {
    return {
      args: null,
      mutex:
        "Error: --latest is mutually exclusive with --decision-id, --batch-id, and the positional <decision_id>.",
    };
  }
  if (decisionId === undefined && args.batchId === undefined && args.latest !== true) {
    return {
      args: null,
      mutex:
        "Error: provide a <decision_id> (positional or --decision-id), --batch-id, or --latest.",
    };
  }
  if (decisionId !== undefined) {
    args.decisionId = decisionId;
  }
  return { args };
}

/** Main entry for scope_undo.py parity. */
export function undoMain(argv: string[]): number {
  const parsed = parseUndoArgv(argv);
  if (parsed.mutex !== undefined) {
    process.stderr.write(`${parsed.mutex}\n`);
    return 2;
  }
  if (parsed.args === null) {
    process.stderr.write("usage: scope_undo.py <decision_id> [--dry-run] [--project-root PATH]\n");
    return 2;
  }
  const args = parsed.args;
  const [root, err] = resolveProjectRootStrict(args.projectRoot);
  if (err !== null || root === null) {
    process.stderr.write(`Error: ${err}\n`);
    return 2;
  }
  const logPath = canonicalLogPath(root);
  if (!existsSync(logPath)) {
    process.stderr.write(`Error: audit log not found at ${logPath}. Nothing to undo.\n`);
    return 1;
  }

  if (args.batchId !== undefined) {
    const [undone, _entries, skipped, previews] = undoBatch(args.batchId, root, {
      actor: args.actor,
      logPath,
      dryRun: args.dryRun,
    });
    if (undone === 0 && skipped.length > 0 && skipped[0]?.startsWith("No audit entries")) {
      process.stderr.write(`${skipped[0]}\n`);
      return 1;
    }
    const prefix = args.dryRun === true ? "DRY-RUN: " : "";
    process.stdout.write(
      `${prefix}Batch undo: ${undone} reversed, ${skipped.length} skipped (batch_id=${args.batchId}).\n`,
    );
    for (const line of previews) {
      process.stdout.write(`  preview: ${line}\n`);
    }
    for (const line of skipped) {
      process.stdout.write(`  skipped: ${line}\n`);
    }
    return 0;
  }

  const logEntries = readAll(logPath);
  let decisionId = args.decisionId;
  if (args.latest === true) {
    let candidate: Record<string, unknown> | null = null;
    for (let i = logEntries.length - 1; i >= 0; i -= 1) {
      const entry = logEntries[i];
      if (entry === undefined) {
        continue;
      }
      const action = entry.action;
      if (typeof action !== "string" || !REVERSIBLE_ACTIONS.has(action)) {
        continue;
      }
      const entryId = entry.decision_id;
      if (typeof entryId !== "string") {
        continue;
      }
      if (isAlreadyUndone(entryId, logEntries)) {
        continue;
      }
      candidate = entry;
      break;
    }
    if (candidate === null) {
      process.stderr.write(
        "Error: --latest found no reversible audit entry (demote / cancel / restore / undo) that has not already been undone.\n",
      );
      return 1;
    }
    decisionId = String(candidate.decision_id);
    if (decisionId.length === 0) {
      process.stderr.write("Error: --latest candidate is missing a decision_id.\n");
      return 1;
    }
  }

  const entry = findByDecisionId(decisionId ?? "", logEntries);
  if (entry === null) {
    process.stderr.write(`Error: no audit entry found with decision_id=${decisionId}.\n`);
    return 1;
  }
  const result = undoOne(entry, root, {
    actor: args.actor,
    logPath,
    dryRun: args.dryRun,
    logEntries,
  });
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  process.stderr.write(`Error: ${result.message}\n`);
  return 1;
}
