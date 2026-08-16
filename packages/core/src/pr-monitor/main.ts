import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { EXIT_CONFIG_ERROR } from "./constants.js";
import { monitor, summaryLabelForExit } from "./monitor.js";

/** Match Python json.dumps(..., indent=2) default ensure_ascii=True. */
function pythonJsonDumps(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json.replace(/[\u007f-\uffff]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export interface ParsedMonitorArgs {
  readonly prNumber: number | null;
  readonly repo: string | null;
  readonly capMinutes: number;
  readonly emitJson: boolean;
  /** Project root for minGreptileConfidence (#3095 / #3102). Null = default cwd at run. */
  readonly projectRoot: string | null;
  readonly error?: string;
}

export function parseMonitorArgs(argv: readonly string[]): ParsedMonitorArgs {
  let prNumber: number | null = null;
  let repo: string | null = null;
  let capMinutes = 60;
  let emitJson = false;
  let projectRoot: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prNumber,
          repo,
          capMinutes,
          emitJson,
          projectRoot,
          error: "argument --repo: expected one argument",
        };
      }
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prNumber,
          repo,
          capMinutes,
          emitJson,
          projectRoot,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--cap-minutes") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prNumber,
          repo,
          capMinutes,
          emitJson,
          projectRoot,
          error: "argument --cap-minutes: expected one argument",
        };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return {
          prNumber,
          repo,
          capMinutes,
          emitJson,
          projectRoot,
          error: `invalid --cap-minutes value: ${value}`,
        };
      }
      capMinutes = parsed;
      i += 1;
    } else if (arg?.startsWith("--cap-minutes=")) {
      const value = arg.slice("--cap-minutes=".length);
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return {
          prNumber,
          repo,
          capMinutes,
          emitJson,
          projectRoot,
          error: `invalid --cap-minutes value: ${value}`,
        };
      }
      capMinutes = parsed;
    } else if (arg?.startsWith("-")) {
      return {
        prNumber,
        repo,
        capMinutes,
        emitJson,
        projectRoot,
        error: `unrecognized arguments: ${arg}`,
      };
    } else if (prNumber === null) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n <= 0) {
        return {
          prNumber,
          repo,
          capMinutes,
          emitJson,
          projectRoot,
          error: `invalid PR number: ${arg}`,
        };
      }
      prNumber = n;
    } else {
      return {
        prNumber,
        repo,
        capMinutes,
        emitJson,
        projectRoot,
        error: `unrecognized arguments: ${arg}`,
      };
    }
  }

  if (prNumber === null) {
    return {
      prNumber,
      repo,
      capMinutes,
      emitJson,
      projectRoot,
      error: "the following arguments are required: pr_number",
    };
  }
  return { prNumber, repo, capMinutes, emitJson, projectRoot };
}

export interface RunMonitorOptions {
  readonly runGh?: RunGhFn;
  readonly monitorFn?: typeof monitor;
}

export function runMonitor(argv: readonly string[], options: RunMonitorOptions = {}): number {
  const args = parseMonitorArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const repo = args.repo ?? process.env.GH_REPO ?? null;
  if (repo === null || repo.length === 0) {
    process.stderr.write("Error: --repo OWNER/REPO is required (or set $GH_REPO).\n");
    return EXIT_CONFIG_ERROR;
  }

  const monitorFn = options.monitorFn ?? monitor;
  const { exitCode, payload, pollCount } = monitorFn(args.prNumber as number, repo, {
    capMinutes: args.capMinutes,
    runGh: options.runGh,
    // CLI --project-root or cwd: production remote-monitor path must not silently
    // resolve minGreptileConfidence from an unrelated cwd (#3095 residual / #3102).
    projectRoot: args.projectRoot ?? process.cwd(),
  });

  const summaryLabel = summaryLabelForExit(exitCode);
  const via = typeof payload.via === "string" ? payload.via : "?";
  process.stderr.write(
    `[monitor_pr] PR #${args.prNumber} repo=${repo} result=${summaryLabel} ` +
      `polls=${pollCount} via=${via}\n`,
  );

  if (args.emitJson) {
    const envelope = {
      monitor_result: summaryLabel,
      polls: pollCount,
      readiness: payload,
    };
    process.stdout.write(`${pythonJsonDumps(envelope)}\n`);
  } else {
    const lines: string[] = [];
    lines.push(`PR #${args.prNumber} monitor result: ${summaryLabel}`);
    lines.push(`  polls: ${pollCount}`);
    lines.push(`  via:   ${via}`);
    const err = payload.error;
    if (typeof err === "string" && err.length > 0) {
      lines.push(`  error: ${err}`);
    }
    const missingRaw = payload.monitor_absent_required;
    if (Array.isArray(missingRaw) && missingRaw.length > 0) {
      lines.push(`  missing: ${missingRaw.map(String).join(", ")}`);
    }
    const failuresRaw = payload.failures;
    if (Array.isArray(failuresRaw)) {
      failuresRaw.forEach((fail, index) => {
        lines.push(`  [${index + 1}] ${String(fail)}`);
      });
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  return exitCode;
}

export function cmdPrMonitor(argv: readonly string[], options: RunMonitorOptions = {}): number {
  return runMonitor(argv, options);
}
