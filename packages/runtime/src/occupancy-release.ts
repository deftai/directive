#!/usr/bin/env node
import { releaseOccupancy } from "@deftai/directive-core/session";
import { occupancyUnrecognizedArgument } from "./occupancy-unrecognized.js";

/**
 * Abandoned-lease recovery copy (#4667), owner-only since #6679. Only the owner
 * releases its lease, live or quiet; a quiet lease blocks no write and the next
 * session:start may claim over it under the existing claim rules. The copy never
 * tells the reader to copy session_id out of .deft/occupancy.json and never
 * names occupancy:steal. host:none / address:none are unset metadata, not the
 * lock cause.
 *
 * #5544 Prefer-A: pass the supplied --project-root through to releaseOccupancy
 * so the consumer AGENTS.md header check stays at the project directory.
 * Lease file / lock resolution stays inside releaseOccupancy (shared with the
 * Write-hook lease view); denials / already-free print occupancyFile=.
 */
export const ABANDONED_OCCUPANCY_LEASE_RECOVERY =
  "Abandoned occupancy lease: only the session that owns a lease releases it, live or quiet " +
  "(occupancy:release / session:end with its own presented session identity). A release by " +
  "any other session is refused and leaves the lease in place. Never copy a lease's session_id " +
  "into a release command. A bare release does not use DEFT_SESSION_ID, because child " +
  "processes inherit it. A live lease whose owner is gone goes heartbeat-stale after the TTL. " +
  "A quiet (heartbeat-stale or age-capped) lease blocks no write, and the next session:start " +
  "may claim over it, subject to the existing claim rules. " +
  "host:none / address:none are ordinary unset metadata, not the lock cause. " +
  "Denials and already-free print occupancyFile= for the lease root this CLI resolved.";

export function formatOccupancyReleaseHelp(): string {
  return [
    "Usage: deft occupancy:release [--project-root <path>] [--session-id <id>]",
    "",
    "Release this checkout's occupancy lease when it is the caller's own, live or not. A lease owned by another session is refused.",
    "Pass the consumer project directory as --project-root (header check uses it; lease file resolves to the Git toplevel when available).",
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
  // Keep the supplied project directory for the consumer header check; lease
  // root resolution happens inside releaseOccupancy (#5544 Greptile P1).
  const result = releaseOccupancy(args.projectRoot, {
    sessionId: args.sessionId,
    env: process.env,
  });
  const sink = result.code === 0 ? process.stdout : process.stderr;
  sink.write(`${result.message}\n`);
  return result.code;
}
