#!/usr/bin/env node
import { resolve } from "node:path";
import { releaseOccupancy } from "@deftai/directive-core/session";
import { occupancyUnrecognizedArgument } from "./occupancy-unrecognized.js";

/**
 * First-class abandoned-lease recovery (#4667). Live actor is session_id in
 * .deft/occupancy.json; bare session:end with empty identity refuses; TTL
 * claim-over and deny-embedded copy-paste remain. host:none / address:none
 * are unset metadata, not the lock cause. Does not reopen anonymous live
 * auto-release (#3954).
 */
export const ABANDONED_OCCUPANCY_LEASE_RECOVERY =
  "Abandoned live occupancy lease: bare session:end / occupancy:release without a presented " +
  "session identity refuses while the lease is live. Immediate recovery: " +
  "occupancy:release --session-id=<id from .deft/occupancy.json> " +
  "(read session_id from that file). Or wait for TTL claim-over. " +
  "host:none / address:none are ordinary unset metadata, not the lock cause.";

export function formatOccupancyReleaseHelp(): string {
  return [
    "Usage: deft occupancy:release [--project-root <path>] [--session-id <id>]",
    "",
    "Release this worktree occupancy lease (owner live, or expired residue).",
    "",
    ABANDONED_OCCUPANCY_LEASE_RECOVERY,
    "",
  ].join("\n");
}

export function parseArgs(argv: readonly string[]): {
  projectRoot: string;
  sessionId?: string;
  help?: boolean;
  error?: string;
} {
  const parsed: { projectRoot: string; sessionId?: string; help?: boolean } = {
    projectRoot: ".",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--project-root") {
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
      return { ...parsed, error: occupancyUnrecognizedArgument(arg) };
    }
  }
  return parsed;
}

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`occupancy:release: ${args.error}\n`);
    return 2;
  }
  if (args.help === true) {
    process.stdout.write(formatOccupancyReleaseHelp());
    return 0;
  }
  const result = releaseOccupancy(resolve(args.projectRoot), {
    sessionId: args.sessionId,
    env: process.env,
  });
  const sink = result.code === 0 ? process.stdout : process.stderr;
  sink.write(`${result.message}\n`);
  return result.code;
}
