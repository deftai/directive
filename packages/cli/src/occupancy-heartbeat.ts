#!/usr/bin/env node
import { resolve } from "node:path";
import { heartbeatOccupancy } from "@deftai/directive-core/session";

export function parseArgs(argv: readonly string[]): {
  projectRoot: string;
  sessionId?: string;
  error?: string;
} {
  const parsed: { projectRoot: string; sessionId?: string } = { projectRoot: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      const value = arg.slice("--project-root=".length);
      if (value.length === 0 || value.startsWith("--")) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
    } else if (arg === "--session-id") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...parsed, error: "argument --session-id: expected one argument" };
      }
      const sessionId = value.trim();
      if (sessionId.length === 0 || sessionId.startsWith("--")) {
        return { ...parsed, error: "argument --session-id: expected a non-empty value" };
      }
      parsed.sessionId = sessionId;
      i += 1;
    } else if (arg?.startsWith("--session-id=")) {
      const sessionId = arg.slice("--session-id=".length).trim();
      if (sessionId.length === 0 || sessionId.startsWith("--")) {
        return { ...parsed, error: "argument --session-id: expected a non-empty value" };
      }
      parsed.sessionId = sessionId;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`occupancy:heartbeat: ${args.error}\n`);
    return 2;
  }
  const result = heartbeatOccupancy(resolve(args.projectRoot), {
    sessionId: args.sessionId,
    env: process.env,
  });
  const sink = result.code === 0 ? process.stdout : process.stderr;
  sink.write(`${result.message}\n`);
  return result.code;
}
