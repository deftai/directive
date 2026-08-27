import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectActiveScope } from "./index.js";

const originFreshness = vi.hoisted(() => ({
  evaluate: vi.fn((_payload: unknown, _options?: { readonly skip?: boolean }) => ({
    ok: true,
    message: "origin freshness skipped",
  })),
}));
vi.mock("../vbrief-reconcile/origin-freshness.js", () => ({
  evaluateOriginFreshness: originFreshness.evaluate,
}));

const temps: string[] = [];

beforeEach(() => {
  originFreshness.evaluate.mockClear();
});

afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
  // #3736: the authorization path is local-only. Any candidate evaluated
  // without `skip` would reach live `gh api` and put a forge round trip
  // inside the host's tool.before budget.
  for (const [, options] of originFreshness.evaluate.mock.calls) {
    expect(options).toMatchObject({ skip: true });
  }
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "deft-hook-scope-"));
  temps.push(value);
  return value;
}

const runningPlacement = {
  status: "running",
  metadata: {
    intended_placement: {
      schema: "deft.scope.intended_placement.v1",
      files: ["src/new-module.ts"],
      module_boundary: "new focused module",
    },
  },
};

it("reuses canonical preflight for active/running scope", () => {
  const project = root();
  const active = join(project, "xbrief", "active");
  mkdirSync(active, { recursive: true });
  const path = join(active, "story.xbrief.json");
  writeFileSync(path, JSON.stringify({ plan: runningPlacement }), "utf8");

  expect(inspectActiveScope(project)).toMatchObject({ ready: true, path });
  expect(originFreshness.evaluate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ skip: true }),
  );
});

describe("scope denial", () => {
  it("reports no active artifact", () => {
    expect(inspectActiveScope(root())).toMatchObject({ ready: false, path: null });
  });

  it("reports an active artifact whose canonical preflight rejects it", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "story.xbrief.json"),
      JSON.stringify({ plan: { status: "completed" } }),
      "utf8",
    );

    const result = inspectActiveScope(project);
    expect(result.ready).toBe(false);
    expect(result.message).toContain("only 'running'");
  });

  it("checks every candidate despite deterministic filename ordering", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "a-rejected.xbrief.json"),
      JSON.stringify({ plan: { status: "completed" } }),
      "utf8",
    );
    const passing = join(active, "z-passing.xbrief.json");
    writeFileSync(passing, JSON.stringify({ plan: runningPlacement }), "utf8");

    expect(inspectActiveScope(project)).toMatchObject({ ready: true, path: passing });
  });
});
