import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PARITY_SCENARIO_NAMES,
  renderScenarioOutput,
  runParityScenario,
} from "./parity-scenarios.js";

export function usage(): void {
  process.stderr.write("usage: vbrief-build [--scenario NAME | --all] [--fixture-root PATH]\n");
}

/** Run one or all parity scenarios; writes JSON payload to stdout. */
export function run(argv: string[]): number {
  let scenario: string | null = null;
  let all = false;
  let fixtureRoot: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scenario") {
      scenario = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--fixture-root") {
      fixtureRoot = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      return 0;
    } else {
      process.stderr.write(`vbrief-build: error: unexpected argument: ${arg}\n`);
      usage();
      return 2;
    }
  }

  if (!all && !scenario) {
    usage();
    return 2;
  }

  const ownedFixture = fixtureRoot === null;
  const root = fixtureRoot ?? mkdtempSync(join(tmpdir(), "deft-vbrief-build-"));
  try {
    const names = all ? [...PARITY_SCENARIO_NAMES] : [scenario as string];
    const results = names.map((name) => runParityScenario(name, { fixtureRoot: root }));
    const payload = all ? results : results[0];
    process.stdout.write(renderScenarioOutput(payload as never));
    return 0;
  } finally {
    if (ownedFixture) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export function cmdVbriefBuild(argv: string[]): number {
  try {
    return run(argv);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`vbrief-build: error: ${msg}\n`);
    return 2;
  }
}
