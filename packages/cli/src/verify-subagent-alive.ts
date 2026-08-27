#!/usr/bin/env node
/**
 * Fail-closed worker liveness gate (#2824). Wraps subagent-monitor with
 * REDISPATCH_OK on missing/STALE heartbeats for registered in-flight workers.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_THRESHOLD_MINUTES,
  defaultScratchDir,
  EXIT_EXTERNAL_ERROR,
  EXIT_OK,
  EXIT_STALE,
  recordOk,
  type ScratchDirEntry,
  sweepAllOk,
  sweepScratchDirs,
} from "@deftai/directive-core/orchestration";

export const SUBAGENT_ALIVE_HELP = `verify:subagent-alive — fail-closed worker liveness gate (#2824)

Usage:
  task verify:subagent-alive -- [options]
  task agent:monitor -- [options]   (alias: raw heartbeat sweep)

Options:
  --scratch-dir PATH       Heartbeat directory (repeatable; default: .deft-scratch/subagent-status)
  --require-agent ID       In-flight worker that MUST have a fresh heartbeat (repeatable)
  --threshold-minutes N    Staleness threshold (default: 30)
  --json                   Machine-readable output

Exit codes:
  0  All required agents fresh (or no required agents and sweep clean)
  1  Missing/STALE/malformed heartbeat — prints REDISPATCH_OK for takeover
  2  Config error (invalid args, missing scratch dir with no records)
`;

export interface VerifySubagentAliveArgs {
  scratchDirs: string[];
  requireAgents: string[];
  thresholdMinutes: number;
  emitJson: boolean;
  help: boolean;
  error?: string;
}

export function parseVerifySubagentAliveArgs(argv: readonly string[]): VerifySubagentAliveArgs {
  const acc: VerifySubagentAliveArgs = {
    scratchDirs: [],
    requireAgents: [],
    thresholdMinutes: DEFAULT_THRESHOLD_MINUTES,
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
    } else if (arg === "--scratch-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --scratch-dir: expected one argument" };
      }
      acc.scratchDirs.push(value);
      i += 1;
    } else if (arg?.startsWith("--scratch-dir=")) {
      acc.scratchDirs.push(arg.slice("--scratch-dir=".length));
    } else if (arg === "--threshold-minutes") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --threshold-minutes: expected one argument" };
      }
      acc.thresholdMinutes = Number(value);
      i += 1;
    } else if (arg?.startsWith("--threshold-minutes=")) {
      acc.thresholdMinutes = Number(arg.slice("--threshold-minutes=".length));
    } else if (arg === "--require-agent") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --require-agent: expected one argument" };
      }
      acc.requireAgents.push(value);
      i += 1;
    } else if (arg?.startsWith("--require-agent=")) {
      acc.requireAgents.push(arg.slice("--require-agent=".length));
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

function scratchEntries(scratchDirs: string[], cwd: string): ScratchDirEntry[] {
  if (scratchDirs.length > 0) {
    return scratchDirs.map((p) => ({ readPath: resolve(cwd, p), label: p }));
  }
  const defaultDir = defaultScratchDir(cwd);
  return [{ readPath: defaultDir, label: defaultDir }];
}

export interface SubagentAliveVerdict {
  exitCode: number;
  redispatchOk: boolean;
  message: string;
  json?: Record<string, unknown>;
}

/** Evaluate liveness for required in-flight workers. */
export function evaluateSubagentAliveGate(
  args: VerifySubagentAliveArgs,
  cwd: string = process.cwd(),
): SubagentAliveVerdict {
  if (args.error !== undefined) {
    return {
      exitCode: EXIT_EXTERNAL_ERROR,
      redispatchOk: false,
      message: `verify_subagent_alive: ${args.error}`,
    };
  }

  if (Number.isNaN(args.thresholdMinutes) || args.thresholdMinutes <= 0) {
    return {
      exitCode: EXIT_EXTERNAL_ERROR,
      redispatchOk: false,
      message: `verify_subagent_alive: --threshold-minutes must be positive, got ${args.thresholdMinutes}`,
    };
  }

  const entries = scratchEntries(args.scratchDirs, cwd);
  const sweep = sweepScratchDirs(entries, { thresholdMinutes: args.thresholdMinutes });
  const configError = sweep.sweep_errors.length > 0 && sweep.records.length === 0;

  const missingAgents: string[] = [];
  for (const agentId of args.requireAgents) {
    const rec = sweep.records.find((r) => r.agent_id === agentId);
    if (rec === undefined || !recordOk(rec)) {
      missingAgents.push(agentId);
    }
  }

  const requiredUnhealthy = missingAgents.length > 0;
  // When --require-agent is set, only named workers gate the verdict; unrelated
  // stale records in a shared scratch dir must not trigger REDISPATCH_OK (#2824).
  const sweepUnhealthy = args.requireAgents.length === 0 && !sweepAllOk(sweep);
  const unhealthy = sweepUnhealthy || requiredUnhealthy;

  if (args.emitJson) {
    return {
      exitCode: configError ? EXIT_EXTERNAL_ERROR : unhealthy ? EXIT_STALE : EXIT_OK,
      redispatchOk: unhealthy && !configError,
      message: "",
      json: {
        all_ok: !unhealthy && !configError,
        redispatch_ok: unhealthy && !configError,
        required_agents: [...args.requireAgents],
        missing_or_stale_agents: missingAgents,
        sweep: {
          scratch_dirs: sweep.scratch_dirs,
          threshold_minutes: sweep.threshold_minutes,
          stale_count: sweep.records.filter((r) => r.is_stale).length,
          malformed_count: sweep.records.filter((r) => r.failures.length > 0).length,
          sweep_errors: sweep.sweep_errors,
        },
      },
    };
  }

  if (configError) {
    const detail = sweep.sweep_errors.join("; ");
    return {
      exitCode: EXIT_EXTERNAL_ERROR,
      redispatchOk: false,
      message: `verify_subagent_alive: config error — ${detail}`,
    };
  }

  if (!unhealthy) {
    const count = args.requireAgents.length > 0 ? args.requireAgents.length : sweep.records.length;
    return {
      exitCode: EXIT_OK,
      redispatchOk: false,
      message: `verify_subagent_alive: all ${count} monitored worker(s) alive`,
    };
  }

  const lines: string[] = ["verify_subagent_alive: worker liveness gate FAILED"];
  if (requiredUnhealthy) {
    lines.push(`  Missing or STALE required agent(s): ${missingAgents.join(", ")}`);
  }
  if (sweepUnhealthy && args.requireAgents.length === 0) {
    const stale = sweep.records.filter((r) => r.is_stale).length;
    const malformed = sweep.records.filter((r) => r.failures.length > 0).length;
    lines.push(`  Sweep: ${stale} stale, ${malformed} malformed record(s)`);
  }
  lines.push("");
  lines.push("REDISPATCH_OK: host-reported running + missing/STALE heartbeat authorizes takeover.");
  lines.push("A killed worker's delivery attempt stays running until cancelled.");
  lines.push(
    "Takeover: task swarm:pre-dispatch -- --scope-id <id> --target-id <worktree> --action cancel",
  );
  lines.push("then:     task swarm:pre-dispatch -- --scope-id <id> --target-id <worktree>");
  lines.push(
    "If verify:session-ritual --tier=gated fails, run session:start --rearm --session-id=<same> first.",
  );
  lines.push("Do not wait on Cursor false-alive state. Do not spawn while DENY_DUPLICATE_ACTIVE.");

  return {
    exitCode: EXIT_STALE,
    redispatchOk: true,
    message: lines.join("\n"),
  };
}

export function run(argv: readonly string[]): number {
  const args = parseVerifySubagentAliveArgs(argv);
  if (args.help) {
    process.stdout.write(SUBAGENT_ALIVE_HELP);
    return EXIT_OK;
  }

  const verdict = evaluateSubagentAliveGate(args);
  if (args.emitJson && verdict.json !== undefined) {
    process.stdout.write(`${JSON.stringify(verdict.json, null, 2)}\n`);
  } else if (verdict.message.length > 0) {
    if (verdict.exitCode === EXIT_OK) {
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
