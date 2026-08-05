/**
 * CLI entry for freshness:report / freshness:bind (#3117).
 */

import { resolveProjectRoot } from "../scope/project-context.js";
import { bindSessionGeneration } from "./bind.js";
import {
  formatFreshnessReport,
  freshnessReportExitCode,
  freshnessReportToJson,
  reportFreshness,
} from "./report.js";

export type FreshnessCliCommand = "report" | "bind" | "help";

export interface FreshnessCliOptions {
  readonly command: FreshnessCliCommand;
  readonly projectRoot: string | null;
  readonly json: boolean;
  readonly sessionId: string | null;
  readonly help: boolean;
}

export interface FreshnessCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const HELP_TEXT = `Usage: deft freshness:<command> [options]

Host-agnostic freshness contract: compare session bound generation vs live deposit.

Commands:
  report   Compare bound vs live (default). Exit 0=current, 1=soft/unbound, 2=hard.
  bind     Bind the current live generation into this session (rebind without host restart).

Options:
  --project-root <path>   Project root (default: cwd / nearest project)
  --session-id <id>       Optional host session identity stored on bind
  --json                  Machine-readable JSON on stdout
  --help                  Show this help

See content/docs/freshness-contract.md for soft vs hard meanings and mid-mission safety.
`;

export function parseFreshnessArgv(argv: readonly string[]): FreshnessCliOptions {
  let command: FreshnessCliCommand = "report";
  let projectRoot: string | null = null;
  let json = false;
  let sessionId: string | null = null;
  let help = false;

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--project-root" || arg === "--cwd") {
      projectRoot = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length) || null;
      continue;
    }
    if (arg === "--session-id") {
      sessionId = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      sessionId = arg.slice("--session-id=".length) || null;
      continue;
    }
    if (arg.startsWith("-")) {
      // Unknown flag — leave for command validation via help path.
      positional.push(arg);
      continue;
    }
    positional.push(arg);
  }

  if (positional[0] === "report" || positional[0] === "bind" || positional[0] === "help") {
    command = positional[0];
  } else if (positional[0]) {
    // Treat unknown subcommand as help-worthy.
    help = true;
  }

  return { command: help ? "help" : command, projectRoot, json, sessionId, help };
}

/** Run freshness CLI. Returns structured stdout/stderr + exit code. */
export function runFreshnessCli(argv: readonly string[] = []): FreshnessCliResult {
  const options = parseFreshnessArgv(argv);
  if (options.help || options.command === "help") {
    return { exitCode: 0, stdout: HELP_TEXT, stderr: "" };
  }

  const projectRoot = resolveProjectRoot(options.projectRoot);
  if (projectRoot === null) {
    return {
      exitCode: 2,
      stdout: "",
      stderr:
        "freshness: could not resolve project root. Pass --project-root PATH, set $DEFT_PROJECT_ROOT, or run from a tree with xbrief/ or .git/.\n",
    };
  }

  if (options.command === "bind") {
    try {
      const { bound, live, path } = bindSessionGeneration(projectRoot, {
        sessionId: options.sessionId,
      });
      if (options.json) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(
            {
              success: true,
              action: "bind",
              bound,
              live,
              path,
            },
            null,
            2,
          )}\n`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout:
          `[deft freshness] bound session to live generation ${live.generation} ` +
          `(content v${live.contentVersion})\n` +
          `  bind path: ${path}\n` +
          "  Re-loaded payload surfaces are now the session's bound generation.\n",
        stderr: "",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (options.json) {
        return {
          exitCode: 2,
          stdout: `${JSON.stringify({ success: false, action: "bind", error: message }, null, 2)}\n`,
          stderr: "",
        };
      }
      return { exitCode: 2, stdout: "", stderr: `freshness:bind: ${message}\n` };
    }
  }

  // report (default) — pass --session-id for multi-agent isolation
  const report = reportFreshness(projectRoot, { sessionId: options.sessionId });
  const exitCode = freshnessReportExitCode(report);
  if (options.json) {
    return {
      exitCode,
      stdout: `${JSON.stringify(freshnessReportToJson(report), null, 2)}\n`,
      stderr: "",
    };
  }
  return {
    exitCode,
    stdout: formatFreshnessReport(report),
    stderr: "",
  };
}

/** Core-module main entry for dispatch (stdout/stderr + process.exit). */
export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  const result = runFreshnessCli(argv);
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}
