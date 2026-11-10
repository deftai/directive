#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { clearApplyingHost } from "@deftai/directive-core/session";
import { occupancyUnrecognizedArgument } from "./occupancy-unrecognized.js";

/**
 * Clear the worktree applying-host soft claim (#6143 Prefer-A).
 *
 * session:end / occupancy:release already clear applying-host with the lease.
 * This verb clears an abandoned no-lease claim or the matching owner record.
 */
export function formatApplyingHostReleaseHelp(): string {
  return [
    "Usage: deft applying-host:release [--project-root <path>] [--session-id <id>]",
    "",
    "Clear .deft/applying-host.json for this worktree.",
    "Owner match always clears. With no live foreign occupant, an abandoned",
    "no-lease soft claim may be cleared without impersonating the recorded owner.",
    "Live foreign lease keeps the record (use occupancy:release / session:end or steal).",
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
    process.stderr.write(`applying-host:release: ${args.error}\n`);
    return 2;
  }
  if (args.help === true) {
    process.stdout.write(formatApplyingHostReleaseHelp());
    return 0;
  }
  const result = clearApplyingHost(args.projectRoot, {
    sessionId: args.sessionId ?? process.env.DEFT_SESSION_ID ?? null,
  });
  if (result.status === "missing") {
    process.stdout.write("applying-host already clear\n");
    return 0;
  }
  if (result.status === "denied") {
    process.stderr.write(`${result.message}\n`);
    return 1;
  }
  process.stdout.write(`applying-host cleared (${result.previousSessionId})\n`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
