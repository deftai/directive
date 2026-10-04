#!/usr/bin/env node
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

const HELP =
  "deft verify:cohort-review-monitors — cohort babysit inventory (#5318)\n" +
  "\n" +
  "  --prs <csv>                 PR numbers (required unless resolver yields a set)\n" +
  "  --manifest <path>           Launch-manifest JSON (default .deft/swarm-launch-manifest.json)\n" +
  "  --open-tracking-prs <csv>   Currently open linked Tracking PRs (unioned; never silently shrunk)\n" +
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

  const result = verifyCohortReviewMonitors({
    projectRoot: args.projectRoot,
    prsCsv: args.prsCsv,
    launchManifestPath: args.manifestPath,
    openTrackingPrs,
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
