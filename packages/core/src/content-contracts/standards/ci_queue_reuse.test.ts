import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  lookupQueueRun,
  REQUIRED_AGGREGATORS,
} from "../../../../../.github/scripts/ci-queue-reuse-lookup.mjs";
import { resolveAuthoritativeLane } from "../../../../../.github/scripts/resolve-ci-authoritative-lane.mjs";

const ROOT = resolve(__dirname, "../../../../..");
const ci = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

function jobBlock(text: string, id: string): string {
  const start = text.indexOf(`\n  ${id}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const SHA = "a".repeat(40);
const ENV = { REPO: "deftai/directive", RUN_ID: "10", HEAD_SHA: SHA };

type Api = (path: string) => Record<string, unknown>;

function fakeApi(opts: {
  runs?: Record<string, unknown>[];
  jobs?: Record<string, unknown>[];
  throwOn?: string;
}): { api: Api; paths: string[] } {
  const paths: string[] = [];
  const api: Api = (path) => {
    paths.push(path);
    if (opts.throwOn && path.includes(opts.throwOn)) throw new Error("boom");
    if (path.endsWith("/actions/runs/10")) return { workflow_id: 7 };
    if (path.includes("/actions/workflows/7/runs")) return { workflow_runs: opts.runs ?? [] };
    if (path.includes("/attempts/")) return { jobs: opts.jobs ?? [] };
    throw new Error(`unexpected ${path}`);
  };
  return { api, paths };
}

const goodRun = {
  id: 99,
  run_number: 5,
  run_attempt: 2,
  event: "merge_group",
  head_sha: SHA,
  workflow_id: 7,
  status: "completed",
  conclusion: "success",
};
const goodJobs = REQUIRED_AGGREGATORS.map((name) => ({
  name,
  status: "completed",
  conclusion: "success",
}));

describe("ci-queue-reuse-lookup (#6584)", () => {
  it("passes only for a completed success queue attempt with both aggregators green", () => {
    const { api, paths } = fakeApi({ runs: [goodRun], jobs: goodJobs });
    const result = lookupQueueRun(ENV, api);
    expect(result).toMatchObject({
      queue_passed: true,
      queue_run_id: "99",
      queue_run_attempt: "2",
    });
    expect(paths.at(-1)).toBe(
      "repos/deftai/directive/actions/runs/99/attempts/2/jobs?per_page=100",
    );
  });

  it("takes the newest run and refuses when that run is not a success", () => {
    const older = { ...goodRun, id: 50, run_number: 4 };
    const newer = { ...goodRun, id: 60, run_number: 6, conclusion: "cancelled" };
    const { api } = fakeApi({ runs: [older, newer], jobs: goodJobs });
    expect(lookupQueueRun(ENV, api).queue_passed).toBe(false);
  });

  it.each([
    ["no run", { runs: [] }],
    ["in progress", { runs: [{ ...goodRun, status: "in_progress", conclusion: null }] }],
    ["failure", { runs: [{ ...goodRun, conclusion: "failure" }] }],
    ["wrong SHA", { runs: [{ ...goodRun, head_sha: "b".repeat(40) }], jobs: goodJobs }],
    ["wrong event", { runs: [{ ...goodRun, event: "push" }], jobs: goodJobs }],
    ["wrong workflow", { runs: [{ ...goodRun, workflow_id: 8 }], jobs: goodJobs }],
    ["unreadable attempt", { runs: [{ ...goodRun, run_attempt: null }], jobs: goodJobs }],
    ["missing aggregator job", { runs: [goodRun], jobs: [goodJobs[0]] }],
    [
      "aggregator not success",
      {
        runs: [goodRun],
        jobs: [goodJobs[0], { ...goodJobs[1], conclusion: "skipped" }],
      },
    ],
  ])("is false for %s", (_label, opts) => {
    const { api } = fakeApi(opts as Parameters<typeof fakeApi>[0]);
    const result = lookupQueueRun(ENV, api);
    expect(result.queue_passed).toBe(false);
    expect(result.queue_run_id).toBe("");
  });

  it("is false on an API error and on missing input", () => {
    const { api } = fakeApi({ runs: [goodRun], jobs: goodJobs, throwOn: "/attempts/" });
    expect(lookupQueueRun(ENV, api).queue_passed).toBe(false);
    expect(lookupQueueRun({ REPO: "x" }, api).queue_passed).toBe(false);
  });
});

describe("resolve-ci-authoritative-lane queue reuse (#6584)", () => {
  const base = {
    REPO: "deftai/directive",
    RUN_ID: "1",
    WANT_FAILOVER: "false",
    FAILOVER_RESULT: "skipped",
    PRIMARY_NEEDLE: "typescript (blacksmith primary)",
    SUITE_LABEL: "TypeScript",
  };

  it("exits 0 citing the queue run URL and attempt with no API read", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const api = vi.fn();
    const code = resolveAuthoritativeLane(
      { ...base, QUEUE_PASSED: "true", QUEUE_RUN_ID: "99", QUEUE_RUN_ATTEMPT: "2" },
      { ghApi: api },
    );
    expect(code).toBe(0);
    expect(api).not.toHaveBeenCalled();
    expect(String(log.mock.calls.at(-1)?.[0])).toContain(
      "https://github.com/deftai/directive/actions/runs/99/attempts/2",
    );
    log.mockRestore();
  });

  it.each([
    ["queue not passed", { QUEUE_PASSED: "false", QUEUE_RUN_ID: "99", QUEUE_RUN_ATTEMPT: "2" }],
    ["no id", { QUEUE_PASSED: "true", QUEUE_RUN_ID: "", QUEUE_RUN_ATTEMPT: "2" }],
    ["no attempt", { QUEUE_PASSED: "true", QUEUE_RUN_ID: "99", QUEUE_RUN_ATTEMPT: "" }],
    ["bad id", { QUEUE_PASSED: "true", QUEUE_RUN_ID: "x", QUEUE_RUN_ATTEMPT: "2" }],
  ])("behaves as today when %s", (_label, queue) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = resolveAuthoritativeLane(
      { ...base, WANT_FAILOVER: "true", FAILOVER_RESULT: "failure", ...queue },
      { ghApi: vi.fn() },
    );
    expect(code).toBe(1);
    err.mockRestore();
  });
});

describe("ci.yml queue reuse wiring (#6584)", () => {
  const skip = "needs.changes.outputs.queue_passed != 'true'";

  it("changes job looks up the queue run once, on push, from the base tree", () => {
    const changes = jobBlock(ci, "changes");
    expect(changes).toContain("queue_passed: ${{ steps.queue.outputs.queue_passed }}");
    expect(changes).toContain("queue_run_id: ${{ steps.queue.outputs.queue_run_id }}");
    expect(changes).toContain("queue_run_attempt: ${{ steps.queue.outputs.queue_run_attempt }}");
    expect(changes).toContain("if: github.event_name == 'push'");
    expect(changes).toContain('git show "${PUSH_BEFORE}:${LOOKUP}"');
    expect(changes).toContain('|| echo "queue_passed=false" >> "$GITHUB_OUTPUT"');
  });

  it.each([
    "ts-primary",
    "merge-gate-primary",
    "windows-task-dispatch",
    "capacity-watchdog",
    "capacity-arm",
    "ts-failover",
    "merge-gate-failover",
  ])("%s skips when queue_passed is true and keeps its if guard", (id) => {
    const block = jobBlock(ci, id);
    // #7014: the merge-gate lanes use `!cancelled()` so an ordinary cancel takes.
    const guard = id.startsWith("merge-gate") ? "if: ${{ !cancelled() &&" : "if: always() &&";
    expect(block).toContain(guard);
    expect(block).toContain(skip);
    expect(block).toMatch(/needs:\s*\[changes/);
  });

  it("aggregators keep names, depend on changes and pass the queue run", () => {
    for (const [id, name] of [
      ["ts", "TypeScript (build + lint)"],
      ["merge-gate", "Merge gate (task check)"],
    ] as const) {
      const block = jobBlock(ci, id);
      expect(block).toContain(`name: ${name}`);
      expect(block).toMatch(/needs:\s*\[changes/);
      expect(block).toContain("QUEUE_PASSED: ${{ needs.changes.outputs.queue_passed }}");
      expect(block).toContain("QUEUE_RUN_ID: ${{ needs.changes.outputs.queue_run_id }}");
      expect(block).toContain("QUEUE_RUN_ATTEMPT: ${{ needs.changes.outputs.queue_run_attempt }}");
    }
  });

  it("the header names the new meaning of a green aggregator on a master push", () => {
    expect(ci).toContain("Gate meaning on a master push (#6584)");
    const github = readFileSync(resolve(ROOT, "content/scm/github.md"), "utf8");
    expect(github).toContain("On a master push, a green required aggregator");
    expect(github).toContain("any lookup doubt");
  });
});
