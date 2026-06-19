import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coveragePath, writeCoverageDenominator } from "./coverage.js";
import {
  addLabelToIgnores,
  addLabelToScope,
  addMilestoneToScope,
  computeDiffFromUpstream,
  fetchUpstreamLabelsAndMilestones,
  renderDiffReport,
} from "./mutations.js";
import { subscriptionHash } from "./normalize.js";
import { pyListRepr } from "./python-repr.js";
import { renderIgnores, renderList } from "./renderers.js";
import {
  getRawIgnores,
  getRawScope,
  isDefaultApplied,
  loadProjectDefinition,
  resolveScopeRules,
} from "./resolve.js";
import { validateScopeRules } from "./validate.js";

export interface ParsedCliArgs {
  projectRoot: string;
  doList: boolean;
  refreshDenominator: boolean;
  repo: string | undefined;
  addLabel: string | undefined;
  addMilestone: string | undefined;
  ignoreLabel: string | undefined;
  diffFromUpstream: boolean;
  source: string;
  cacheRoot: string | undefined;
  count: number | undefined;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? ".",
    doList: false,
    refreshDenominator: false,
    repo: process.env.DEFT_TRIAGE_REPO,
    addLabel: undefined,
    addMilestone: undefined,
    ignoreLabel: undefined,
    diffFromUpstream: false,
    source: "github-issue",
    cacheRoot: undefined,
    count: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") parsed.doList = true;
    else if (arg === "--refresh-denominator") parsed.refreshDenominator = true;
    else if (arg === "--diff-from-upstream") parsed.diffFromUpstream = true;
    else if (arg === "--project-root") {
      parsed.projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg?.startsWith("--project-root="))
      parsed.projectRoot = arg.slice("--project-root=".length);
    else if (arg === "--repo") {
      parsed.repo = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--repo=")) parsed.repo = arg.slice("--repo=".length);
    else if (arg === "--add-label") {
      parsed.addLabel = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--add-label=")) parsed.addLabel = arg.slice("--add-label=".length);
    else if (arg === "--add-milestone") {
      parsed.addMilestone = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--add-milestone="))
      parsed.addMilestone = arg.slice("--add-milestone=".length);
    else if (arg === "--ignore-label") {
      parsed.ignoreLabel = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--ignore-label="))
      parsed.ignoreLabel = arg.slice("--ignore-label=".length);
    else if (arg === "--source") {
      parsed.source = argv[i + 1] ?? "github-issue";
      i += 1;
    } else if (arg?.startsWith("--source=")) parsed.source = arg.slice("--source=".length);
    else if (arg === "--cache-root") {
      parsed.cacheRoot = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--cache-root="))
      parsed.cacheRoot = arg.slice("--cache-root=".length);
    else if (arg === "--count") {
      const raw = argv[i + 1];
      parsed.count = raw !== undefined ? Number.parseInt(raw, 10) : undefined;
      i += 1;
    } else if (arg?.startsWith("--count=")) {
      parsed.count = Number.parseInt(arg.slice("--count=".length), 10);
    }
  }
  return parsed;
}

export const CLI_HELP = `usage: triage_scope.py [-h] [--project-root PROJECT_ROOT] [--list]
                       [--refresh-denominator] [--repo REPO]
                       [--add-label ADD_LABEL] [--add-milestone ADD_MILESTONE]
                       [--ignore-label IGNORE_LABEL] [--diff-from-upstream]
                       [--source SOURCE] [--cache-root CACHE_ROOT]
                       [--count COUNT]

Inspect, mutate, and diff the typed plan.policy.triageScope[] subscription +
plan.policy.triageScopeIgnores[] (#1131 / D12, #1133 / D14, #1182 / D14c).
Read paths never trigger a recompute; use --refresh-denominator to update the
coverage cache. Mutation flags --add-label / --add-milestone / --ignore-label
are idempotent and atomic; every mutation appends a subscription-change audit
entry to vbrief/.eval/subscription-history.jsonl.
`;

interface CliOutput {
  readonly stdout: string[];
  readonly stderr: string[];
}

function handleMutation(
  projectRoot: string,
  args: ParsedCliArgs,
): { code: number; out: CliOutput } {
  const out: CliOutput = { stdout: [], stderr: [] };
  try {
    let changed: boolean;
    let message: string;
    let verb: string;
    if (args.addLabel !== undefined) {
      [changed, message] = addLabelToScope(projectRoot, args.addLabel);
      verb = "add-label";
    } else if (args.addMilestone !== undefined) {
      [changed, message] = addMilestoneToScope(projectRoot, args.addMilestone);
      verb = "add-milestone";
    } else if (args.ignoreLabel !== undefined) {
      [changed, message] = addLabelToIgnores(projectRoot, args.ignoreLabel);
      verb = "ignore-label";
    } else {
      throw new Error("internal: mutation flag set but no handler matched");
    }
    const suffix = changed ? "." : " (no-op).";
    const line = `triage:scope ${verb}: ${message}${suffix}\n`;
    if (changed) out.stdout.push(line);
    else out.stderr.push(line);
    return { code: 0, out };
  } catch (err) {
    out.stderr.push(`triage:scope: ${String(err)}`);
    return { code: 1, out };
  }
}

/** Run triage:scope CLI; returns exit code and captured output for parity. */
export function runCliCapture(argv: string[]): { code: number; stdout: string; stderr: string } {
  const args = parseCliArgs(argv);
  const stdout: string[] = [];
  const stderr: string[] = [];

  const projectRoot = resolve(args.projectRoot);
  if (!existsSync(projectRoot)) {
    return {
      code: 2,
      stdout: "",
      stderr: `triage:scope: --project-root ${projectRoot} does not exist or is not a directory.\n`,
    };
  }

  const mutationFlags = [
    args.addLabel !== undefined ? "--add-label" : null,
    args.addMilestone !== undefined ? "--add-milestone" : null,
    args.ignoreLabel !== undefined ? "--ignore-label" : null,
  ].filter((f): f is string => f !== null);

  if (mutationFlags.length > 1) {
    return {
      code: 2,
      stdout: "",
      stderr:
        "triage:scope: --add-label / --add-milestone / --ignore-label " +
        `are mutually exclusive (got ${pyListRepr(mutationFlags)}).\n`,
    };
  }

  const noAction =
    !args.doList &&
    !args.refreshDenominator &&
    mutationFlags.length === 0 &&
    !args.diffFromUpstream;

  if (noAction) {
    return { code: 0, stdout: CLI_HELP, stderr: "" };
  }

  if (mutationFlags.length > 0) {
    const mutation = handleMutation(projectRoot, args);
    stderr.push(...mutation.out.stderr);
    stdout.push(...mutation.out.stdout);
    if (mutation.code !== 0) {
      return { code: mutation.code, stdout: stdout.join(""), stderr: stderr.join("") };
    }
  }

  const data = loadProjectDefinition(projectRoot);
  const rules = resolveScopeRules(projectRoot, data);
  const isDefault = isDefaultApplied(data);
  const { errors: schemaErrors } = validateScopeRules(getRawScope(data));
  if (schemaErrors.length > 0) {
    stderr.push(
      `triage:scope: PROJECT-DEFINITION plan.policy.triageScope has ${schemaErrors.length} validation error(s):\n`,
    );
    for (const err of schemaErrors) stderr.push(`  - ${err}\n`);
    return { code: 1, stdout: stdout.join(""), stderr: stderr.join("") };
  }

  if (args.doList) {
    stdout.push(`${renderList(rules, { isDefault })}\n`);
    stdout.push(`${renderIgnores(getRawIgnores(data))}\n`);
  }

  if (args.refreshDenominator) {
    if (!args.repo?.includes("/")) {
      return {
        code: 2,
        stdout: stdout.join(""),
        stderr:
          `${stderr.join("")}` +
          "triage:scope --refresh-denominator requires --repo OWNER/NAME (or $DEFT_TRIAGE_REPO).\n",
      };
    }
    if (args.count === undefined || Number.isNaN(args.count)) {
      return {
        code: 2,
        stdout: stdout.join(""),
        stderr:
          `${stderr.join("")}` +
          "triage:scope --refresh-denominator requires --count <int> (D5 will provide the live-probe wiring; until then a synthetic / cached count is the caller's contract).\n",
      };
    }
    const path = coveragePath(args.source, args.repo, {
      projectRoot,
      cacheRoot: args.cacheRoot !== undefined ? resolve(args.cacheRoot) : undefined,
    });
    const subHash = subscriptionHash(rules);
    const record = writeCoverageDenominator(path, {
      count: args.count,
      subscriptionHashValue: subHash,
    });
    stdout.push(
      `triage:scope: wrote coverage denominator count=${record.count} ` +
        `subscription-hash=${record.subscriptionHash} path=${path}\n`,
    );
  }

  if (args.diffFromUpstream) {
    if (!args.repo?.includes("/")) {
      return {
        code: 2,
        stdout: stdout.join(""),
        stderr:
          `${stderr.join("")}` +
          "triage:scope --diff-from-upstream requires --repo OWNER/NAME (or $DEFT_TRIAGE_REPO).\n",
      };
    }
    try {
      const [labels, milestones] = fetchUpstreamLabelsAndMilestones(args.repo);
      const report = computeDiffFromUpstream(projectRoot, {
        upstreamLabels: labels,
        upstreamMilestones: milestones,
        repo: args.repo,
      });
      stdout.push(`${renderDiffReport(report)}\n`);
    } catch (err) {
      return {
        code: 1,
        stdout: stdout.join(""),
        stderr: `${stderr.join("")}triage:scope --diff-from-upstream: ${String(err)}\n`,
      };
    }
  }

  return { code: 0, stdout: stdout.join(""), stderr: stderr.join("") };
}

export function run(argv: string[]): number {
  const result = runCliCapture(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
