#!/usr/bin/env node
/**
 * No-agent lifecycle fixture CLI (#6614). Run after `pnpm run build`:
 *
 *   node packages/core/dist/release-e2e/ovpr-lifecycle-fixture-cli.js [--step N ...] [--keep-work]
 *
 * Prints one line per step on stdout, progress on stderr, and the total
 * duration. Exits 1 when any step fails, 2 on a bad argument.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_STEPS,
  type FixtureStep,
  findStep,
  formatStepLine,
  runLifecycleFixture,
} from "./ovpr-lifecycle-fixture.js";

function parseArgs(argv: readonly string[]): { steps: FixtureStep[]; keepWork: boolean } | string {
  const selected: FixtureStep[] = [];
  let keepWork = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--keep-work") {
      keepWork = true;
      continue;
    }
    let value: string | undefined;
    if (arg === "--step") value = argv[++i];
    else if (arg.startsWith("--step=")) value = arg.slice("--step=".length);
    else return `unknown argument: ${arg}`;
    for (const part of (value ?? "").split(",")) {
      const step = findStep(part);
      if (step === null) return `unknown step: ${part || "(empty)"}`;
      if (!selected.includes(step)) selected.push(step);
    }
  }
  const steps =
    selected.length === 0 ? [...FIXTURE_STEPS] : FIXTURE_STEPS.filter((s) => selected.includes(s));
  return { steps, keepWork };
}

const parsed = parseArgs(process.argv.slice(2));
if (typeof parsed === "string") {
  process.stderr.write(`ovpr-lifecycle-fixture: ${parsed}\n`);
  process.stderr.write(`steps: ${FIXTURE_STEPS.map((s) => s.id).join(", ")}\n`);
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const report = runLifecycleFixture(repoRoot, {
  steps: parsed.steps,
  keepWork: parsed.keepWork,
  onProgress: (message) => process.stderr.write(`${message}\n`),
});
for (const step of report.steps) {
  process.stdout.write(`${formatStepLine(step)}\n`);
}
process.stdout.write(
  `ovpr-lifecycle-fixture: ${report.ok ? "OK" : "FAILED"} in ${(report.durationMs / 1000).toFixed(1)}s (setup ${(report.setupMs / 1000).toFixed(1)}s)\n`,
);
process.exit(report.ok ? 0 : 1);
