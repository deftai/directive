import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_SCOPE_PIN_ENV, inspectActiveScope, matchPinnedActiveScope } from "./index.js";

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

describe("shared-active write-fence bind (#4007)", () => {
  function writeRunning(project: string, name: string, fileScope: readonly string[]): string {
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, name);
    writeFileSync(
      path,
      JSON.stringify({
        plan: {
          ...runningPlacement,
          metadata: {
            ...runningPlacement.metadata,
            swarm: { file_scope: [...fileScope] },
          },
        },
      }),
      "utf8",
    );
    return path;
  }

  it("fails closed when two eligible briefs share active/ and no pin is set", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);

    const result = inspectActiveScope(project, { env: {} });
    expect(result.ready).toBe(false);
    expect(result.path).toBeNull();
    expect(result.message).toContain("Multiple active xBRIEF artifacts");
    expect(result.message).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(result.message).toContain("#4007");
  });

  it("binds the dispatched story when DEFT_ACTIVE_SCOPE names it", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    const storyB = writeRunning(project, "b-story.xbrief.json", [
      "packages/b/**",
      "src/ui/__tests__/fonts.test.ts",
    ]);

    const byRelative = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b-story.xbrief.json" },
    });
    expect(byRelative).toMatchObject({ ready: true, path: storyB });

    const byBasename = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "b-story.xbrief.json" },
    });
    expect(byBasename).toMatchObject({ ready: true, path: storyB });

    const byBoundPath = inspectActiveScope(project, { boundPath: storyB, env: {} });
    expect(byBoundPath).toMatchObject({ ready: true, path: storyB });
  });

  it("does not rewrite a backslash pin into a posix path except on win32", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    const storyB = writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);
    const pin = "xbrief\\active\\b-story.xbrief.json";
    const result = inspectActiveScope(project, { env: { [ACTIVE_SCOPE_PIN_ENV]: pin } });
    if (process.platform === "win32") {
      expect(result).toMatchObject({ ready: true, path: storyB });
    } else {
      expect(result.ready).toBe(false);
      expect(result.path).toBeNull();
      expect(result.message).toContain(pin);
    }
  });

  it("does not degrade a path-shaped miss to a same-named basename", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);

    const wrongDir = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/pending/b-story.xbrief.json" },
    });
    expect(wrongDir.ready).toBe(false);
    expect(wrongDir.path).toBeNull();
    expect(wrongDir.message).toContain("xbrief/pending/b-story.xbrief.json");
  });

  it("fails closed when the pin does not name an eligible brief", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);

    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/missing.xbrief.json" },
    });
    expect(result.ready).toBe(false);
    expect(result.message).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(result.message).toContain("missing.xbrief.json");
  });

  it("does not treat a __tests__ segment as a special matcher token", () => {
    const project = root();
    const story = writeRunning(project, "ui-story.xbrief.json", [
      "src/ui/fonts.css",
      "src/ui/__tests__/fonts.test.ts",
    ]);
    expect(inspectActiveScope(project, { env: {} })).toMatchObject({ ready: true, path: story });
    expect(matchPinnedActiveScope(project, "ui-story.xbrief.json", [story])).toBe(story);
  });
});
