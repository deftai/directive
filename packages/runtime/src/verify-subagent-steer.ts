#!/usr/bin/env node
/**
 * Parent-visible unread steer flag (#4286). Exit 1 is STEER_PENDING.
 * Never prints REDISPATCH_OK — unread steer is not missing heartbeat.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSteerDir,
  EXIT_STEER_CONFIG,
  EXIT_STEER_OK,
  EXIT_STEER_PENDING,
  renderSteerPendingText,
  steerPendingConfigError,
  sweepSteerPending,
} from "@deftai/directive-core/orchestration";

export const SUBAGENT_STEER_HELP = `verify:subagent-steer — parent-visible unread steer flag (#4286)

Usage:
  task verify:subagent-steer -- [options]

Options:
  --steer-dir PATH    Inbox directory (default: .deft-scratch/subagent-steer)
  --agent ID          Agent whose inbox to inspect (repeatable; default: all)
  --json              Machine-readable output

Exit codes:
  0  No unread unexpired steer
  1  STEER_PENDING — unread inbox; not REDISPATCH_OK / takeover
  2  Config error (invalid args, steer path is not a directory)
`;

export interface VerifySubagentSteerArgs {
  steerDir: string | null;
  agentIds: string[];
  emitJson: boolean;
  help: boolean;
  error?: string;
}

export function parseVerifySubagentSteerArgs(argv: readonly string[]): VerifySubagentSteerArgs {
  const acc: VerifySubagentSteerArgs = {
    steerDir: null,
    agentIds: [],
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
    } else if (arg === "--steer-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --steer-dir: expected one argument" };
      }
      acc.steerDir = value;
      i += 1;
    } else if (arg?.startsWith("--steer-dir=")) {
      acc.steerDir = arg.slice("--steer-dir=".length);
    } else if (arg === "--agent") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --agent: expected one argument" };
      }
      acc.agentIds.push(value);
      i += 1;
    } else if (arg?.startsWith("--agent=")) {
      acc.agentIds.push(arg.slice("--agent=".length));
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

export interface SubagentSteerVerdict {
  exitCode: number;
  redispatchOk: false;
  message: string;
  json?: Record<string, unknown>;
}

export function evaluateSubagentSteerGate(
  args: VerifySubagentSteerArgs,
  cwd: string = process.cwd(),
): SubagentSteerVerdict {
  if (args.error !== undefined) {
    return {
      exitCode: EXIT_STEER_CONFIG,
      redispatchOk: false,
      message: `verify_subagent_steer: ${args.error}`,
    };
  }

  const steerDir = resolve(cwd, args.steerDir ?? defaultSteerDir(cwd));
  const sweep = sweepSteerPending(steerDir, {
    agentIds: args.agentIds.length > 0 ? args.agentIds : undefined,
  });
  const configError = steerPendingConfigError(sweep);
  const pending = sweep.pending.length > 0 || sweep.parse_failures.length > 0;

  if (args.emitJson) {
    return {
      exitCode: configError ? EXIT_STEER_CONFIG : pending ? EXIT_STEER_PENDING : EXIT_STEER_OK,
      redispatchOk: false,
      message: "",
      json: {
        all_ok: !pending && !configError,
        steer_pending: pending,
        redispatch_ok: false,
        pending_agents: sweep.pending.map((p) => p.agent_id),
        pending: sweep.pending,
        parse_failures: sweep.parse_failures,
        sweep_errors: sweep.sweep_errors,
      },
    };
  }

  if (configError) {
    return {
      exitCode: EXIT_STEER_CONFIG,
      redispatchOk: false,
      message: renderSteerPendingText(sweep),
    };
  }

  return {
    exitCode: pending ? EXIT_STEER_PENDING : EXIT_STEER_OK,
    redispatchOk: false,
    message: renderSteerPendingText(sweep),
  };
}

export function run(argv: readonly string[]): number {
  const args = parseVerifySubagentSteerArgs(argv);
  if (args.help) {
    process.stdout.write(SUBAGENT_STEER_HELP);
    return EXIT_STEER_OK;
  }

  const verdict = evaluateSubagentSteerGate(args);
  if (args.emitJson && verdict.json !== undefined) {
    process.stdout.write(`${JSON.stringify(verdict.json, null, 2)}\n`);
  } else if (verdict.message.length > 0) {
    if (verdict.exitCode === EXIT_STEER_OK) {
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
