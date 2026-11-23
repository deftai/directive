/**
 * #6849: the nightly workflow runs a Linux coverage lane and a Windows
 * full-suite lane on the delivery-branch tip once a day, never on pull requests
 * or merge_group, and is not a required check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MERGE_GATE_TASK_CHECK_NAME } from "../../pr-wait-mergeable/constants.js";
import { TYPESCRIPT_BUILD_LINT_CHECK_NAME } from "../../release/ci-reuse.js";
import {
  NIGHTLY_COVERAGE_LANE_NAME,
  NIGHTLY_WINDOWS_LANE_NAME,
  NIGHTLY_WORKFLOW_FILE,
} from "../../release/nightly-reuse.js";
import { repoRoot } from "./_helpers.js";

const text = readFileSync(join(repoRoot(), ".github/workflows", NIGHTLY_WORKFLOW_FILE), "utf8");

function topBlock(key: string): string {
  const start = text.search(new RegExp(`^${key}:`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const next = rest.slice(1).search(/\n[a-z]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function jobBlock(id: string): string {
  const start = text.indexOf(`\n  ${id}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function stepBlock(job: string, name: string): string {
  const start = job.indexOf(`- name: ${name}`);
  expect(start, `step ${name}`).toBeGreaterThanOrEqual(0);
  const rest = job.slice(start);
  const next = rest.slice(1).search(/\n {6}- /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function jobIds(): string[] {
  const jobs = topBlock("jobs");
  return [...jobs.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((m) => m[1] as string);
}

const LANE_JOBS = ["coverage", "windows"] as const;

describe("nightly workflow triggers and permissions (#6849 clauses 1, 10)", () => {
  it("runs only on schedule (one daily cron) and workflow_dispatch", () => {
    const on = topBlock("on");
    const events = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(events).toEqual(["schedule", "workflow_dispatch"]);
    expect(on.match(/- cron:/g)).toHaveLength(1);
    expect(on).toMatch(/- cron: "\d+ \d+ \* \* \*"/);
    expect(on).not.toMatch(/pull_request|merge_group|push:/);
  });

  it("reads contents at workflow level; only the reporting job gets issues: write", () => {
    expect(topBlock("permissions")).toMatch(/^permissions:\n {2}contents: read\n/);
    expect(text.match(/issues: write/g)).toHaveLength(1);
    expect(jobBlock("report")).toMatch(/permissions:\n {6}contents: read\n {6}issues: write/);
    for (const id of LANE_JOBS) expect(jobBlock(id)).not.toMatch(/permissions:/);
  });

  it("serializes runs under concurrency nightly without cancelling", () => {
    expect(topBlock("concurrency")).toMatch(/group: nightly\n {2}cancel-in-progress: false/);
  });

  it("has no job named like a required check", () => {
    const names = [...text.matchAll(/^ {4}name: (.+)$/gm)].map((m) => (m[1] as string).trim());
    expect(names).toEqual([
      NIGHTLY_COVERAGE_LANE_NAME,
      NIGHTLY_WINDOWS_LANE_NAME,
      "Nightly report",
    ]);
    expect(names).not.toContain(TYPESCRIPT_BUILD_LINT_CHECK_NAME);
    expect(names).not.toContain(MERGE_GATE_TASK_CHECK_NAME);
    expect(jobIds()).toEqual(["coverage", "windows", "report"]);
  });
});

describe("nightly jobs run on master only and test one commit (#6849 clauses 1, 11)", () => {
  it("guards every job on refs/heads/master", () => {
    for (const id of jobIds()) {
      expect(jobBlock(id)).toMatch(
        /\n {4}if: (always\(\) && )?github\.ref == 'refs\/heads\/master'\n/,
      );
    }
  });

  it("checks out github.sha in both lanes", () => {
    for (const id of LANE_JOBS) {
      expect(jobBlock(id)).toMatch(
        /actions\/checkout@[0-9a-f]{40}[^\n]*\n {8}with:\n {10}ref: \$\{\{ github\.sha \}\}/,
      );
    }
  });
});

describe("nightly lane preparation (#6849 clauses 2, 12)", () => {
  it("uses the merge-gate-primary preparation steps and adds no setup-go (#6863)", () => {
    for (const id of LANE_JOBS) {
      const job = jobBlock(id);
      expect(job).toContain("node-version-file: .nvmrc");
      expect(job).toContain("corepack enable");
      expect(job).toContain("pnpm install --frozen-lockfile");
      expect(job).toContain("arduino/setup-task@");
      expect(job).toContain("astral-sh/setup-uv@");
      expect(job).toContain("task materialize:runtime");
    }
    expect(text).not.toContain("actions/setup-go");
  });

  it("fails as a setup failure before the tests unless Task runs and the built CLI exists", () => {
    for (const id of LANE_JOBS) {
      const job = jobBlock(id);
      const verify = stepBlock(job, "Verify setup (Task and built CLI)");
      expect(verify).toContain("id: verify_setup");
      expect(verify).toContain("set -eu");
      expect(verify).toContain("task --version");
      expect(verify).toContain("test -f packages/cli/dist/bin.js");
      expect(verify).toContain('echo "setup=ok" >> "$GITHUB_OUTPUT"');
      expect(job.indexOf("id: verify_setup")).toBeLessThan(job.indexOf("id: tests"));
      expect(job.indexOf("task materialize:runtime")).toBeLessThan(job.indexOf("id: verify_setup"));
      expect(job).toMatch(/setup: \$\{\{ steps\.verify_setup\.outputs\.setup \}\}/);
      expect(job).toMatch(/tests: \$\{\{ steps\.record\.outputs\.tests \}\}/);
    }
  });
});

describe("nightly lanes (#6849 clauses 3, 4)", () => {
  it("runs the coverage lane on ubuntu-latest within 60 minutes with the vitest.config.ts floor", () => {
    const job = jobBlock("coverage");
    expect(job).toContain("runs-on: ubuntu-latest");
    expect(job).toContain("timeout-minutes: 60");
    const tests = stepBlock(job, "Test suite with coverage");
    expect(tests).toMatch(/pnpm run test\n/);
    expect(tests).toContain("--reporter=json");
    expect(tests).toContain("--coverage.reporter=json-summary");
    expect(job).not.toMatch(/check:merge|coverage-debt|allow-coverage-debt|--retry/);
    expect(job).toContain("coverage/coverage-final.json");
  });

  it("runs the Windows lane on windows-latest within 240 minutes without coverage", () => {
    const job = jobBlock("windows");
    expect(job).toContain("runs-on: windows-latest");
    expect(job).toContain("timeout-minutes: 240");
    const tests = stepBlock(job, "Full test suite");
    expect(tests).toMatch(/pnpm exec vitest run\n/);
    expect(tests).not.toMatch(/coverage|--project/);
    expect(job).not.toMatch(/check:merge|--retry/);
  });

  it("collects failing tests with CLI reporter flags, not a vitest.config.ts edit", () => {
    for (const id of LANE_JOBS) {
      expect(jobBlock(id)).toContain("--outputFile.json=nightly-report/vitest.json");
    }
  });
});

describe("nightly reporting job (#6849 clause 5)", () => {
  it("runs after both lanes whatever they concluded and hands the script the job results", () => {
    const job = jobBlock("report");
    expect(job).toContain("needs: [coverage, windows]");
    expect(job).toContain("if: always() && github.ref == 'refs/heads/master'");
    expect(job).toMatch(/NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
    expect(job).toMatch(/NIGHTLY_OWNER: \$\{\{ vars\.NIGHTLY_OWNER \}\}/);
    expect(job).toContain("run: node .github/scripts/nightly-report.mjs");
    // A failure of the report step fails the run: it is not continue-on-error.
    expect(stepBlock(job, "Report lanes")).not.toContain("continue-on-error");
  });
});
