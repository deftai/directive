#!/usr/bin/env node
/**
 * Fail-closed query-before-cancel gate (#5278 Prefer-A).
 * Dest-capable args required for linked-worktree children (#4066).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultFirstSeenDir,
  defaultScratchDir,
  defaultSteerDir,
  EXIT_PRE_CANCEL_CONFIG,
  EXIT_PRE_CANCEL_OK,
  evaluatePreCancel,
} from "@deftai/directive-core/orchestration";

export const SUBAGENT_PRE_CANCEL_HELP = `subagent:pre-cancel — query-before-cancel gate (#5278)

Usage:
  task subagent:pre-cancel -- --agent <id> --canceller-id <id> [options]

Exit 0 only when one ordered branch clears:
  (a) canceller-authored status steer (kind note|correction) + matching ack
      OR observed first-seen window (default 3 minutes; PA-18 forward skew only)
  (b) heartbeat STALE/missing under startup grace from --dispatch-started-at
  (c) --force --reason <text>

Options:
  --agent ID                 Target child agent_id (required)
  --canceller-id ID          Canceller identity; must match steer writer_id for (a)
  --target-id PATH           Worktree root (resolves steer/scratch/first-seen under it)
  --steer-dir PATH           Steer inbox dir (default: <cwd|target>/.deft-scratch/subagent-steer)
  --scratch-dir PATH         Heartbeat dir (default: <cwd|target>/.deft-scratch/subagent-status)
  --first-seen-dir PATH      First-seen stamps (default: .../subagent-steer-firstseen)
  --dispatch-started-at ISO  DeliveryAttemptRecord.startedAt for grace path (b)
  --expected-worker-id ID    Refuse when agent does not match current attempt worker
  --observed-window-seconds N  Default 180
  --force                    Explicit force clear (requires --reason)
  --reason TEXT              Printed force reason
  --json                     Machine-readable verdict

Exit codes:
  0  Pre-cancel green
  1  Refused (gate red)
  2  Config / usage error
`;

export interface SubagentPreCancelArgs {
  agentId: string | null;
  cancellerId: string | null;
  targetId: string | null;
  steerDir: string | null;
  scratchDir: string | null;
  firstSeenDir: string | null;
  dispatchStartedAt: string | null;
  expectedWorkerId: string | null;
  observedWindowSeconds: number | null;
  force: boolean;
  forceReason: string | null;
  emitJson: boolean;
  help: boolean;
  error?: string;
}

export function parseSubagentPreCancelArgs(argv: readonly string[]): SubagentPreCancelArgs {
  const acc: SubagentPreCancelArgs = {
    agentId: null,
    cancellerId: null,
    targetId: null,
    steerDir: null,
    scratchDir: null,
    firstSeenDir: null,
    dispatchStartedAt: null,
    expectedWorkerId: null,
    observedWindowSeconds: null,
    force: false,
    forceReason: null,
    emitJson: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...acc, help: true };
    }
    if (arg === "--json") {
      acc.emitJson = true;
    } else if (arg === "--force") {
      acc.force = true;
    } else if (arg === "--agent" || arg === "--agent-id") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: `argument ${arg}: expected one argument` };
      acc.agentId = value;
      i += 1;
    } else if (arg?.startsWith("--agent=") || arg?.startsWith("--agent-id=")) {
      acc.agentId = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--canceller-id" || arg === "--canceller") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: `argument ${arg}: expected one argument` };
      acc.cancellerId = value;
      i += 1;
    } else if (arg?.startsWith("--canceller-id=") || arg?.startsWith("--canceller=")) {
      acc.cancellerId = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--target-id" || arg === "--target") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: `argument ${arg}: expected one argument` };
      acc.targetId = value;
      i += 1;
    } else if (arg?.startsWith("--target-id=") || arg?.startsWith("--target=")) {
      acc.targetId = arg.slice(arg.indexOf("=") + 1);
    } else if (arg === "--steer-dir") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --steer-dir: expected one argument" };
      acc.steerDir = value;
      i += 1;
    } else if (arg?.startsWith("--steer-dir=")) {
      acc.steerDir = arg.slice("--steer-dir=".length);
    } else if (arg === "--scratch-dir") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...acc, error: "argument --scratch-dir: expected one argument" };
      acc.scratchDir = value;
      i += 1;
    } else if (arg?.startsWith("--scratch-dir=")) {
      acc.scratchDir = arg.slice("--scratch-dir=".length);
    } else if (arg === "--first-seen-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --first-seen-dir: expected one argument" };
      }
      acc.firstSeenDir = value;
      i += 1;
    } else if (arg?.startsWith("--first-seen-dir=")) {
      acc.firstSeenDir = arg.slice("--first-seen-dir=".length);
    } else if (arg === "--dispatch-started-at") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --dispatch-started-at: expected one argument" };
      }
      acc.dispatchStartedAt = value;
      i += 1;
    } else if (arg?.startsWith("--dispatch-started-at=")) {
      acc.dispatchStartedAt = arg.slice("--dispatch-started-at=".length);
    } else if (arg === "--expected-worker-id") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --expected-worker-id: expected one argument" };
      }
      acc.expectedWorkerId = value;
      i += 1;
    } else if (arg?.startsWith("--expected-worker-id=")) {
      acc.expectedWorkerId = arg.slice("--expected-worker-id=".length);
    } else if (arg === "--observed-window-seconds") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --observed-window-seconds: expected one argument" };
      }
      acc.observedWindowSeconds = Number(value);
      i += 1;
    } else if (arg?.startsWith("--observed-window-seconds=")) {
      acc.observedWindowSeconds = Number(arg.slice("--observed-window-seconds=".length));
    } else if (arg === "--reason") {
      const value = argv[i + 1];
      if (value === undefined) return { ...acc, error: "argument --reason: expected one argument" };
      acc.forceReason = value;
      i += 1;
    } else if (arg?.startsWith("--reason=")) {
      acc.forceReason = arg.slice("--reason=".length);
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

export function run(argv: readonly string[], cwd: string = process.cwd()): number {
  const args = parseSubagentPreCancelArgs(argv);
  if (args.help) {
    process.stdout.write(SUBAGENT_PRE_CANCEL_HELP);
    return EXIT_PRE_CANCEL_OK;
  }
  if (args.error !== undefined) {
    process.stderr.write(`subagent:pre-cancel: ${args.error}\n`);
    return EXIT_PRE_CANCEL_CONFIG;
  }

  const root =
    args.targetId !== null && args.targetId.trim().length > 0 ? resolve(cwd, args.targetId) : cwd;
  const steerDir = resolve(root, args.steerDir ?? defaultSteerDir(root));
  const scratchDir = resolve(root, args.scratchDir ?? defaultScratchDir(root));
  const firstSeenDir = resolve(root, args.firstSeenDir ?? defaultFirstSeenDir(root));

  // Linked-worktree children: refuse default-to-parent-cwd alone without dest args (#4066 / #5278).
  // Partial dest (only --steer-dir or only --scratch-dir) mixes worktrees — require a pair or --target-id.
  const hasTarget = args.targetId !== null && args.targetId.trim().length > 0;
  const hasSteer = args.steerDir !== null;
  const hasScratch = args.scratchDir !== null;
  if (!hasTarget && hasSteer !== hasScratch) {
    process.stderr.write(
      "subagent:pre-cancel: --steer-dir and --scratch-dir must be paired when --target-id is omitted (partial dest mixes worktrees)\n",
    );
    return EXIT_PRE_CANCEL_CONFIG;
  }
  const hasDest = hasTarget || (hasSteer && hasScratch);
  if (!hasDest) {
    process.stderr.write(
      "subagent:pre-cancel: dest-capable --target-id and/or paired --steer-dir/--scratch-dir required (default-to-cwd alone is refuse-closed for linked-worktree children)\n",
    );
    return EXIT_PRE_CANCEL_CONFIG;
  }

  if (
    args.observedWindowSeconds !== null &&
    (!Number.isFinite(args.observedWindowSeconds) || args.observedWindowSeconds <= 0)
  ) {
    process.stderr.write("subagent:pre-cancel: --observed-window-seconds must be positive\n");
    return EXIT_PRE_CANCEL_CONFIG;
  }

  const verdict = evaluatePreCancel({
    agentId: args.agentId ?? "",
    cancellerId: args.cancellerId ?? "",
    steerDir,
    firstSeenDir,
    scratchDir,
    force: args.force,
    forceReason: args.forceReason ?? undefined,
    dispatchStartedAt: args.dispatchStartedAt,
    expectedWorkerId: args.expectedWorkerId,
    observedWindowSeconds: args.observedWindowSeconds ?? undefined,
  });

  if (args.emitJson) {
    process.stdout.write(`${JSON.stringify(verdict.json, null, 2)}\n`);
  } else if (verdict.message.length > 0) {
    if (verdict.ok) {
      process.stdout.write(`${verdict.message}\n`);
    } else {
      process.stderr.write(`${verdict.message}\n`);
    }
  }

  return verdict.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
