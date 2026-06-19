import { resolve } from "node:path";
import { graphOutcomeToJson, reconcileGraph, renderGraphReport } from "./graph.js";
import { labelsOutcomeToJson, reconcileLabels, renderLabelsReport } from "./labels.js";
import {
  PARITY_SCENARIO_NAMES,
  renderScenarioOutput,
  runParityScenario,
} from "./parity-scenarios.js";
import { reconcileUmbrellas, renderUmbrellasReport, umbrellasOutcomeToJson } from "./umbrellas.js";

export interface CliOptions {
  projectRoot?: string;
  repo?: string | null;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  scenario?: string | null;
  all?: boolean;
  fixtureRoot?: string | null;
}

function parseCommon(argv: string[]): { verb: string | null; rest: string[] } {
  if (argv.length === 0) return { verb: null, rest: [] };
  const first = argv[0];
  if (first === "graph" || first === "labels" || first === "umbrellas" || first === "parity") {
    return { verb: first, rest: argv.slice(1) };
  }
  if (first === "--scenario" || first === "--all") return { verb: "parity", rest: argv };
  return { verb: null, rest: argv };
}

function parseOptions(rest: string[]): CliOptions {
  const opts: CliOptions = { projectRoot: "." };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--project-root") {
      opts.projectRoot = rest[i + 1] ?? ".";
      i += 1;
    } else if (arg === "--repo") {
      opts.repo = rest[i + 1] ?? null;
      i += 1;
    } else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--scenario") {
      opts.scenario = rest[i + 1] ?? null;
      i += 1;
    } else if (arg === "--all") opts.all = true;
    else if (arg === "--fixture-root") {
      opts.fixtureRoot = rest[i + 1] ?? null;
      i += 1;
    }
  }
  return opts;
}

export function usage(): void {
  process.stderr.write(
    "usage: vbrief-reconcile <graph|labels|umbrellas> [--project-root PATH] [--dry-run] [--json] [--force] [--repo OWNER/NAME]\n" +
      "       vbrief-reconcile parity --scenario NAME [--fixture-root PATH]\n" +
      "       vbrief-reconcile parity --all [--fixture-root PATH]\n",
  );
}

export function runGraph(opts: CliOptions): number {
  const root = resolve(opts.projectRoot ?? ".");
  const [code, outcome] = reconcileGraph(root, { force: opts.force, dryRun: opts.dryRun });
  if (code === 2) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: "no vbrief/proposed/ directory found" })}\n`);
    } else {
      process.stderr.write(`Error: no vbrief/proposed/ directory found under ${root}\n`);
    }
    return 2;
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(graphOutcomeToJson(outcome), null, 2)}\n`);
  else process.stdout.write(`${renderGraphReport(outcome)}\n`);
  return code;
}

export function runLabels(opts: CliOptions): number {
  const root = resolve(opts.projectRoot ?? ".");
  const [code, outcome] = reconcileLabels(root, { repo: opts.repo, dryRun: opts.dryRun });
  if (code === 2) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: "no vbrief/ directory found" })}\n`);
    } else {
      process.stderr.write(`Error: no vbrief/ directory found under ${root}\n`);
    }
    return 2;
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(labelsOutcomeToJson(outcome), null, 2)}\n`);
  else process.stdout.write(`${renderLabelsReport(outcome)}\n`);
  return code;
}

export function runUmbrellas(opts: CliOptions): number {
  const root = resolve(opts.projectRoot ?? ".");
  const [code, outcome] = reconcileUmbrellas(root, { repo: opts.repo, dryRun: opts.dryRun });
  if (code === 2) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: "no vbrief/ directory found" })}\n`);
    } else {
      process.stderr.write(`Error: no vbrief/ directory found under ${root}\n`);
    }
    return 2;
  }
  if (opts.json)
    process.stdout.write(`${JSON.stringify(umbrellasOutcomeToJson(outcome), null, 2)}\n`);
  else process.stdout.write(`${renderUmbrellasReport(outcome)}\n`);
  return code;
}

export function runParityMode(opts: CliOptions): number {
  const root = opts.fixtureRoot ?? process.env.DEFT_VBRIEF_RECONCILE_FIXTURE ?? "/tmp/unset";
  const names = opts.all ? [...PARITY_SCENARIO_NAMES] : [opts.scenario as string];
  const results = names.map((name) => runParityScenario(name, { fixtureRoot: root }));
  process.stdout.write(renderScenarioOutput(opts.all ? results : (results[0] as never)));
  return 0;
}

export function run(argv: string[]): number {
  const { verb, rest } = parseCommon(argv);
  if (verb === null) {
    usage();
    return 2;
  }
  const opts = parseOptions(rest);
  switch (verb) {
    case "graph":
      return runGraph(opts);
    case "labels":
      return runLabels(opts);
    case "umbrellas":
      return runUmbrellas(opts);
    case "parity":
      if (!opts.all && !opts.scenario) {
        usage();
        return 2;
      }
      return runParityMode(opts);
    default:
      usage();
      return 2;
  }
}

export function cmdVbriefReconcile(argv: string[]): number {
  try {
    return run(argv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`vbrief-reconcile: error: ${msg}\n`);
    return 2;
  }
}
