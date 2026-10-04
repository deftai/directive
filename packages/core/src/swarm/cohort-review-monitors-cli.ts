#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePrsCsv, verifyCohortReviewMonitors } from "./cohort-review-monitors.js";

export function parseCohortReviewMonitorsArgv(argv: readonly string[]): {
  prsCsv: string | null;
  projectRoot: string;
  manifestPath: string | null;
  openTrackingCsv: string | null;
  emitJson: boolean;
  help: boolean;
  error?: string;
} {
  let prsCsv: string | null = null;
  let projectRoot = ".";
  let manifestPath: string | null = null;
  let openTrackingCsv: string | null = null;
  let emitJson = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--prs") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prsCsv,
          projectRoot,
          manifestPath,
          openTrackingCsv,
          emitJson,
          help,
          error: "argument --prs: expected one argument",
        };
      }
      prsCsv = value;
      i += 1;
    } else if (arg?.startsWith("--prs=")) {
      prsCsv = arg.slice("--prs=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prsCsv,
          projectRoot,
          manifestPath,
          openTrackingCsv,
          emitJson,
          help,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--manifest") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prsCsv,
          projectRoot,
          manifestPath,
          openTrackingCsv,
          emitJson,
          help,
          error: "argument --manifest: expected one argument",
        };
      }
      manifestPath = value;
      i += 1;
    } else if (arg?.startsWith("--manifest=")) {
      manifestPath = arg.slice("--manifest=".length);
    } else if (arg === "--open-tracking-prs") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prsCsv,
          projectRoot,
          manifestPath,
          openTrackingCsv,
          emitJson,
          help,
          error: "argument --open-tracking-prs: expected one argument",
        };
      }
      openTrackingCsv = value;
      i += 1;
    } else if (arg?.startsWith("--open-tracking-prs=")) {
      openTrackingCsv = arg.slice("--open-tracking-prs=".length);
    } else if (arg?.startsWith("-")) {
      return {
        prsCsv,
        projectRoot,
        manifestPath,
        openTrackingCsv,
        emitJson,
        help,
        error: `unrecognized argument: ${arg}`,
      };
    } else {
      return {
        prsCsv,
        projectRoot,
        manifestPath,
        openTrackingCsv,
        emitJson,
        help,
        error: `unrecognized argument: ${arg}`,
      };
    }
  }

  return { prsCsv, projectRoot, manifestPath, openTrackingCsv, emitJson, help };
}

function resolveOpenTrackingContext(projectRoot: string): {
  expectedRepo: string | null;
  expectedHost: string | null;
  openPrNumbers: Set<number> | null;
} {
  // Best-effort gh context. Failures leave openPrNumbers null (repo-scope still applied when known)
  // so hermetic unit tests that call verifyCohortReviewMonitorsMain without gh stay usable when
  // no active briefs exist; production parents with active Tracking briefs get open filtering when gh works.
  let expectedRepo: string | null = null;
  let expectedHost: string | null = null;
  try {
    const view = execFileSync(
      "gh",
      ["api", "repos/{owner}/{repo}", "--jq", "[.full_name,.html_url]|@tsv"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    const tab = view.indexOf("\t");
    const fullName = (tab >= 0 ? view.slice(0, tab) : view).trim();
    const htmlUrl = tab >= 0 ? view.slice(tab + 1).trim() : "";
    if (fullName.includes("/")) expectedRepo = fullName;
    if (htmlUrl.length > 0) {
      try {
        expectedHost = new URL(htmlUrl).hostname.toLowerCase();
      } catch {
        expectedHost = null;
      }
    }
  } catch {
    expectedRepo = null;
    expectedHost = null;
  }
  if (expectedHost === null) {
    const fromEnv = process.env.GH_HOST?.trim();
    if (fromEnv && fromEnv.length > 0) expectedHost = fromEnv.toLowerCase();
  }
  if (expectedRepo === null) {
    return { expectedRepo: null, expectedHost, openPrNumbers: null };
  }
  try {
    const openPrNumbers = new Set<number>();
    // Paginate — a single page of 100 can hide open siblings (#5318 Greptile).
    for (let page = 1; page <= 20; page += 1) {
      const raw = execFileSync(
        "gh",
        [
          "api",
          `repos/${expectedRepo}/pulls?state=open&per_page=100&page=${page}`,
          "--jq",
          ".[].number",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line));
      if (lines.length === 0) break;
      for (const line of lines) {
        openPrNumbers.add(Number.parseInt(line, 10));
      }
      if (lines.length < 100) break;
    }
    return { expectedRepo, expectedHost, openPrNumbers };
  } catch {
    return { expectedRepo, expectedHost, openPrNumbers: null };
  }
}

const HELP =
  "deft verify:cohort-review-monitors — cohort babysit inventory (#5318)\n" +
  "\n" +
  "  --prs <csv>                 PR numbers (optional when launch-manifest / open Tracking is non-empty)\n" +
  "  --manifest <path>           Launch-manifest JSON (default .deft/swarm-launch-manifest.json)\n" +
  "  --open-tracking-prs <csv>   Open linked Tracking PRs (unioned; omit to soft-discover from active briefs)\n" +
  "  --project-root <path>       Project root\n" +
  "  --json                      Structured JSON on stdout\n" +
  "\n" +
  "Exit 0: every PR armed-live or halted-explicit.\n" +
  "Exit 1: one or more unarmed (lists remediation Approach 1 commands).\n" +
  "Exit 2: empty/malformed PR set.\n" +
  "\n" +
  "armed-live = verify:review-monitor --merge-path-arm --live-wait SoT (#4882/#5219).\n" +
  "halted-explicit = durable --explicit-finish / option-C attestation (prose dual-stop is not).\n" +
  "Anti-substitute: swarm:verify-review-clean CLEAN does not satisfy this inventory.\n";

export function verifyCohortReviewMonitorsMain(argv: string[] = process.argv.slice(2)): number {
  const args = parseCohortReviewMonitorsArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`verify_cohort_review_monitors: ${args.error}\n`);
    process.stderr.write("Try: task verify:cohort-review-monitors -- --help\n");
    return 2;
  }

  let openTrackingPrs: number[] | undefined;
  if (args.openTrackingCsv !== null) {
    const parsed = parsePrsCsv(args.openTrackingCsv);
    if (!parsed.ok) {
      process.stderr.write(`verify_cohort_review_monitors: --open-tracking-prs ${parsed.reason}\n`);
      return 2;
    }
    openTrackingPrs = parsed.prs;
  }

  const { expectedRepo, expectedHost, openPrNumbers } = resolveOpenTrackingContext(
    args.projectRoot,
  );
  const result = verifyCohortReviewMonitors({
    projectRoot: args.projectRoot,
    prsCsv: args.prsCsv,
    launchManifestPath: args.manifestPath,
    openTrackingPrs,
    expectedRepo,
    expectedHost,
    openPrNumbers,
    emitJson: args.emitJson,
  });
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(verifyCohortReviewMonitorsMain());
}
