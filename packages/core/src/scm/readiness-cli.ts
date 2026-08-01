/**
 * CLI entry for `scm:status` / `scm-readiness` (#2275).
 *
 * Reports SCM binary + auth readiness in the current execution env.
 * Exit 0 when ready; exit 1 when not ready (loud diagnostic); exit 2 on bad flags.
 */

import { fileURLToPath } from "node:url";
import {
  formatScmReadinessLines,
  probeScmReadiness,
  type ScmProbeDepth,
  scmReadinessToDict,
} from "./readiness.js";

export interface ScmReadinessCliArgs {
  readonly json?: boolean;
  readonly deep?: boolean;
  readonly depth?: ScmProbeDepth;
  readonly help?: boolean;
}

export function parseScmReadinessArgs(argv: readonly string[]): {
  args: ScmReadinessCliArgs;
  error: string | null;
} {
  const out: {
    json?: boolean;
    deep?: boolean;
    depth?: ScmProbeDepth;
    help?: boolean;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--deep") {
      out.deep = true;
      out.depth = "deep";
    } else if (arg === "--shallow") {
      out.depth = "shallow";
    } else if (arg === "--depth") {
      const value = argv[++i];
      if (value !== "shallow" && value !== "deep") {
        return {
          args: out,
          error: `--depth expects shallow|deep, got ${JSON.stringify(value ?? "")}`,
        };
      }
      out.depth = value;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg.startsWith("-")) {
      return { args: out, error: `unknown flag ${JSON.stringify(arg)}` };
    } else {
      return { args: out, error: `unexpected argument ${JSON.stringify(arg)}` };
    }
  }
  return { args: out, error: null };
}

const USAGE =
  "usage: deft scm:status [--json] [--deep|--shallow|--depth shallow|deep]\n" +
  "  Report SCM (gh/ghx) availability + auth state in this execution env (#2275).\n" +
  "  Exit 0 ready / 1 not ready / 2 config error.\n";

export function scmReadinessMain(
  args: ScmReadinessCliArgs,
  options: {
    writeOut?: (s: string) => void;
    writeErr?: (s: string) => void;
    probe?: typeof probeScmReadiness;
  } = {},
): number {
  const writeOut = options.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = options.writeErr ?? ((s) => process.stderr.write(s));
  if (args.help) {
    writeOut(USAGE);
    return 0;
  }
  const depth: ScmProbeDepth = args.depth ?? (args.deep ? "deep" : "shallow");
  // Explicit probe always re-evaluates (credentials may have changed since
  // session:start). Clears the process-scoped requireScmReady cache too.
  clearScmReadyCache();
  const probe = options.probe ?? probeScmReadiness;
  const report = probe({ depth });
  if (args.json) {
    writeOut(`${JSON.stringify(scmReadinessToDict(report), null, 2)}\n`);
  } else {
    for (const line of formatScmReadinessLines(report)) {
      writeOut(`${line}\n`);
    }
    if (!report.ready && report.remediation) {
      writeErr(`${report.remediation}\n`);
    }
  }
  return report.ready ? 0 : 1;
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  const { args, error } = parseScmReadinessArgs(argv);
  if (error) {
    process.stderr.write(`error: ${error}\n${USAGE}`);
    return 2;
  }
  return scmReadinessMain(args);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
