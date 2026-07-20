#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PlatformPrimitive,
  REGISTER_HELP,
  registerReviewMonitor,
} from "@deftai/directive-core/review-monitor";

interface ParsedArgs {
  pr: number | null;
  monitorAgentId: string | null;
  platformPrimitive: PlatformPrimitive | null;
  repo: string | null;
  headSha: string | null;
  projectRoot: string;
  parentSessionId: string | null;
  help: boolean;
  error?: string;
}

const PRIMITIVES = new Set<PlatformPrimitive>(["start_agent", "spawn_subagent", "cursor-task"]);

export function parseRegisterArgs(argv: readonly string[]): ParsedArgs {
  const acc: ParsedArgs = {
    pr: null,
    monitorAgentId: null,
    platformPrimitive: null,
    repo: null,
    headSha: null,
    projectRoot: ".",
    parentSessionId: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...acc, help: true };
    }
    if (arg === "--pr") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --pr: expected one argument" };
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return { ...acc, error: `invalid --pr value: ${value}` };
      }
      acc.pr = n;
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      const n = Number(arg.slice("--pr=".length));
      if (!Number.isInteger(n) || n <= 0) {
        return { ...acc, error: `invalid --pr value: ${arg}` };
      }
      acc.pr = n;
    } else if (arg === "--monitor-agent-id") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --monitor-agent-id: expected one argument" };
      }
      acc.monitorAgentId = value;
      i += 1;
    } else if (arg?.startsWith("--monitor-agent-id=")) {
      acc.monitorAgentId = arg.slice("--monitor-agent-id=".length);
    } else if (arg === "--platform-primitive") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --platform-primitive: expected one argument" };
      }
      if (!PRIMITIVES.has(value as PlatformPrimitive)) {
        return { ...acc, error: `invalid --platform-primitive: ${value}` };
      }
      acc.platformPrimitive = value as PlatformPrimitive;
      i += 1;
    } else if (arg?.startsWith("--platform-primitive=")) {
      const value = arg.slice("--platform-primitive=".length);
      if (!PRIMITIVES.has(value as PlatformPrimitive)) {
        return { ...acc, error: `invalid --platform-primitive: ${value}` };
      }
      acc.platformPrimitive = value as PlatformPrimitive;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --repo: expected one argument" };
      }
      acc.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      acc.repo = arg.slice("--repo=".length);
    } else if (arg === "--head-sha") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --head-sha: expected one argument" };
      }
      acc.headSha = value;
      i += 1;
    } else if (arg?.startsWith("--head-sha=")) {
      acc.headSha = arg.slice("--head-sha=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --project-root: expected one argument" };
      }
      acc.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      acc.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--parent-session-id") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --parent-session-id: expected one argument" };
      }
      acc.parentSessionId = value;
      i += 1;
    } else if (arg?.startsWith("--parent-session-id=")) {
      acc.parentSessionId = arg.slice("--parent-session-id=".length);
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

export function run(argv: readonly string[]): number {
  const args = parseRegisterArgs(argv);
  if (args.help) {
    process.stdout.write(REGISTER_HELP);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`review_monitor_register: ${args.error}\n`);
    return 2;
  }
  if (args.pr === null) {
    process.stderr.write("review_monitor_register: --pr is required\n");
    return 2;
  }
  if (args.monitorAgentId === null || args.monitorAgentId.trim().length === 0) {
    process.stderr.write("review_monitor_register: --monitor-agent-id is required\n");
    return 2;
  }
  if (args.platformPrimitive === null) {
    process.stderr.write("review_monitor_register: --platform-primitive is required\n");
    return 2;
  }

  try {
    const { path, record } = registerReviewMonitor({
      pr: args.pr,
      repo: args.repo,
      headSha: args.headSha,
      platformPrimitive: args.platformPrimitive,
      monitorAgentId: args.monitorAgentId,
      projectRoot: resolve(args.projectRoot),
      parentSessionId: args.parentSessionId,
    });
    process.stdout.write(
      `review_monitor_register: recorded PR #${record.pr} monitor ${record.monitor_agent_id} at ${path}\n`,
    );
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`review_monitor_register: ${String((err as Error).message ?? err)}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
