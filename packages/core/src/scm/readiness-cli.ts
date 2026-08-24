/**
 * CLI entry for `scm:status` / `scm-readiness` (#2275).
 *
 * Reports SCM binary + auth readiness in the current execution env.
 * Exit 0 when ready; exit 1 when not ready (loud diagnostic); exit 2 on bad flags.
 */

import { fileURLToPath } from "node:url";
import {
  type ExpectedGithubWorkerPrincipal,
  PRINCIPAL_KIND_APP_INSTALLATION,
  PRINCIPAL_KIND_USER,
} from "../intake/github-auth-modes.js";
import {
  clearScmReadyCache,
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
  readonly repo?: string;
  readonly expectedLogin?: string;
  readonly expectedAppSlug?: string;
  readonly expectedInstallationId?: number;
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
    repo?: string;
    expectedLogin?: string;
    expectedAppSlug?: string;
    expectedInstallationId?: number;
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
    } else if (arg === "--repo") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        return { args: out, error: "--repo expects owner/repo" };
      }
      out.repo = value;
    } else if (arg === "--expected-login") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        return { args: out, error: "--expected-login expects a GitHub login" };
      }
      out.expectedLogin = value;
    } else if (arg === "--expected-app-slug") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        return { args: out, error: "--expected-app-slug expects a GitHub App slug" };
      }
      out.expectedAppSlug = value;
    } else if (arg === "--expected-installation-id") {
      const value = argv[++i];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return {
          args: out,
          error: `--expected-installation-id expects a positive integer, got ${JSON.stringify(value ?? "")}`,
        };
      }
      out.expectedInstallationId = parsed;
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
  "                       [--repo OWNER/REPO] [--expected-login LOGIN]\n" +
  "                       [--expected-app-slug SLUG] [--expected-installation-id ID]\n" +
  "  Report SCM (gh/ghx) availability + auth state in this execution env (#2275).\n" +
  "  Deep probes derive the target repo (flag / GH_REPO / GITHUB_REPOSITORY / origin)\n" +
  "  and compare an expected worker principal when one is supplied (#3665).\n" +
  "  Exit 0 ready / 1 not ready / 2 config error.\n";

function expectedPrincipalFromArgs(
  args: ScmReadinessCliArgs,
): ExpectedGithubWorkerPrincipal | { error: string } | undefined {
  const login = args.expectedLogin?.trim() ?? "";
  const appSlug = args.expectedAppSlug?.trim() ?? "";
  if (login.length > 0 && appSlug.length > 0) {
    return { error: "pass either --expected-login or --expected-app-slug, not both" };
  }
  if (args.expectedInstallationId !== undefined && appSlug.length === 0) {
    return { error: "--expected-installation-id requires --expected-app-slug" };
  }
  if (login.length > 0) {
    return { kind: PRINCIPAL_KIND_USER, login };
  }
  if (appSlug.length > 0) {
    return args.expectedInstallationId !== undefined
      ? {
          kind: PRINCIPAL_KIND_APP_INSTALLATION,
          appSlug,
          installationId: args.expectedInstallationId,
        }
      : { kind: PRINCIPAL_KIND_APP_INSTALLATION, appSlug };
  }
  return undefined;
}

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
  const expectedPrincipal = expectedPrincipalFromArgs(args);
  if (expectedPrincipal !== undefined && "error" in expectedPrincipal) {
    writeErr(`error: ${expectedPrincipal.error}\n${USAGE}`);
    return 2;
  }
  const depth: ScmProbeDepth = args.depth ?? (args.deep ? "deep" : "shallow");
  // Explicit probe always re-evaluates (credentials may have changed since
  // session:start). Clears the process-scoped requireScmReady cache too.
  clearScmReadyCache();
  const probe = options.probe ?? probeScmReadiness;
  const report = probe({
    depth,
    repo: args.repo,
    expectedPrincipal,
  });
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
