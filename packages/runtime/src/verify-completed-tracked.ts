#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPLETED_TRACKED_PROGRESS_MIN_BLOBS,
  COMPLETED_TRACKED_PROGRESS_THRESHOLD_MS,
  type CompletedTrackedProgress,
  evaluateCompletedTracked,
  evaluateShippedClosedDiscovery,
  shouldAnnounceProgress,
  shouldAnnounceUpFrontCount,
} from "@deftai/directive-core/lifecycle";

interface ParsedArgs {
  projectRoot: string;
  repo: string | null;
  tip: string | null;
  issue: number | null;
  quiet: boolean;
  skipGh: boolean;
  /** Opt-in discovery when --issue is set; unscoped defaults to on (#3495). */
  discover: boolean | null;
  enforce: boolean;
  error?: string;
}

function parseIssueNumber(raw: string): number | null {
  const trimmed = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Parse verify-completed-tracked CLI args (#3264 / #3476 / #3495). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    repo: null,
    tip: null,
    issue: null,
    quiet: false,
    skipGh: false,
    discover: null,
    enforce: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--skip-gh") {
      parsed.skipGh = true;
    } else if (arg === "--discover") {
      parsed.discover = true;
    } else if (arg === "--no-discover") {
      parsed.discover = false;
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--tip") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --tip: expected one argument" };
      }
      parsed.tip = value;
      i += 1;
    } else if (arg?.startsWith("--tip=")) {
      parsed.tip = arg.slice("--tip=".length);
    } else if (arg === "--issue") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --issue: expected one argument" };
      }
      const issue = parseIssueNumber(value);
      if (issue === null) {
        return { ...parsed, error: `argument --issue: expected a positive integer, got ${value}` };
      }
      parsed.issue = issue;
      i += 1;
    } else if (arg?.startsWith("--issue=")) {
      const value = arg.slice("--issue=".length);
      const issue = parseIssueNumber(value);
      if (issue === null) {
        return { ...parsed, error: `argument --issue: expected a positive integer, got ${value}` };
      }
      parsed.issue = issue;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

function shouldRunDiscovery(args: ParsedArgs): boolean {
  if (args.discover === false) {
    return false;
  }
  if (args.discover === true || args.enforce) {
    return true;
  }
  // Warn-first default: unscoped corpus scans discover; --issue N stays land-only.
  return args.issue === null;
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_completed_tracked: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const thresholdMs = resolveProgressThresholdMs();
  let announced = false;
  const land = evaluateCompletedTracked(projectRoot, {
    quiet: args.quiet,
    repo: args.repo,
    tip: args.tip,
    issue: args.issue,
    skipGh: args.skipGh,
    onProgress: (event) => {
      if (args.quiet || announced) {
        return;
      }
      const minBlobs = resolveProgressMinBlobs();
      const upFront =
        event.phase === "listed" &&
        shouldAnnounceUpFrontCount(event.terminalCount, event.nonterminalCount, minBlobs);
      if (!upFront && !shouldAnnounceProgress(event.elapsedMs, thresholdMs)) {
        return;
      }
      announced = true;
      writeProgress(event);
    },
  });

  let discoveryCode: 0 | 1 | 2 = 0;
  let discoveryMessage = "";
  let discoveryStream: "stdout" | "stderr" | "none" = "none";

  if (shouldRunDiscovery(args)) {
    const discovery = evaluateShippedClosedDiscovery(projectRoot, {
      quiet: args.quiet,
      repo: args.repo,
      tip: args.tip,
      skipGh: args.skipGh,
      enforce: args.enforce,
    });
    discoveryCode = discovery.code;
    discoveryMessage = discovery.message;
    discoveryStream = discovery.stream;
  }

  // Scoped land fail-closed must not be softened by discovery warn (#3495 Reject).
  if (land.message.length > 0) {
    if (land.stream === "stdout") {
      process.stdout.write(`${land.message}\n`);
    } else if (land.stream === "stderr") {
      process.stderr.write(`${land.message}\n`);
    }
  }
  if (discoveryMessage.length > 0) {
    if (discoveryStream === "stdout") {
      process.stdout.write(`${discoveryMessage}\n`);
    } else if (discoveryStream === "stderr") {
      process.stderr.write(`${discoveryMessage}\n`);
    }
  }

  if (land.code === 2 || discoveryCode === 2) {
    return 2;
  }
  if (land.code === 1 || discoveryCode === 1) {
    return 1;
  }
  return 0;
}

function resolveProgressThresholdMs(): number {
  const raw = process.env.DEFT_COMPLETED_TRACKED_PROGRESS_MS;
  if (raw !== undefined && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return COMPLETED_TRACKED_PROGRESS_THRESHOLD_MS;
}

function resolveProgressMinBlobs(): number {
  const raw = process.env.DEFT_COMPLETED_TRACKED_PROGRESS_MIN_BLOBS;
  if (raw !== undefined && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return COMPLETED_TRACKED_PROGRESS_MIN_BLOBS;
}

function writeProgress(event: CompletedTrackedProgress): void {
  process.stderr.write(
    `verify:completed-tracked: still running (${event.elapsedMs}ms); ` +
      `reading ${event.terminalCount} terminal and ${event.nonterminalCount} nonterminal blobs.\n`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
