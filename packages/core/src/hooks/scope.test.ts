import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStoryWriteFenceFromPath } from "../policy/write-fence.js";
import { fenceUntrustedAcceptanceText } from "../scope/acceptance-evidence.js";
import {
  ACTIVE_SCOPE_PIN_ENV,
  inspectActiveScope,
  matchPinnedActiveScope,
  resolveSoftMissingAcTargets,
} from "./index.js";

/** Fixture tempdirs are not git merge-base trees; use working-tree fence SoT. */
const pathFenceSeam = {
  loadStoryWriteFence: (_root: string, scopePath: string) => loadStoryWriteFenceFromPath(scopePath),
};

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
  vi.unstubAllEnvs();
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

  expect(inspectActiveScope(project, { env: {} })).toMatchObject({ ready: true, path });
  expect(originFreshness.evaluate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ skip: true }),
  );
});

describe("scope denial", () => {
  it("reports no active artifact", () => {
    expect(inspectActiveScope(root(), { env: {} })).toMatchObject({ ready: false, path: null });
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

    const result = inspectActiveScope(project, { env: {} });
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

    expect(inspectActiveScope(project, { env: {} })).toMatchObject({ ready: true, path: passing });
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
    expect(result.denyKind).toBe("multiple-eligible");
    expect(result.message).toContain("Multiple active xBRIEF artifacts");
    expect(result.message).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(result.message).toContain("#4007");
    expect(result.message).toMatch(/Parent\/operator:/);
    expect(result.message).toMatch(/Dispatched worker:/);
    expect(result.message).toContain("scope:block");
    expect(result.message).toContain("scope:complete");
    expect(result.message).toContain("--merge-commit");
    // stamp-evidence is evidence-only; not a clear-deny peer (#4880 A).
    expect(result.message).toContain("scope:stamp-evidence");
    expect(result.message).toMatch(/does not clear this Write\/spawn deny/);
    const workerSection = result.message.split("Dispatched worker:")[1] ?? "";
    expect(workerSection).not.toMatch(
      /pin DEFT_ACTIVE_SCOPE|set DEFT_ACTIVE_SCOPE|Set DEFT_ACTIVE_SCOPE/,
    );
    expect(workerSection).not.toContain("scope:demote");
    expect(workerSection).not.toContain("scope:complete");
  });

  it("names local completionProvenance hint without claiming network class (#5403)", () => {
    const project = root();
    const a = writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);
    const data = JSON.parse(readFileSync(a, "utf8")) as {
      plan: { metadata: Record<string, unknown> };
    };
    data.plan.metadata.completionProvenance = { mergeCommit: "abcdef1", deliveryBranch: "master" };
    writeFileSync(a, JSON.stringify(data), "utf8");
    const result = inspectActiveScope(project, { env: {} });
    expect(result.ready).toBe(false);
    expect(result.message).toContain("completionProvenance.mergeCommit");
    expect(result.message).toContain("scope:block");
  });

  it("reports structured zero-eligible-blocked when scanned candidates are blocked (#4840)", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "a-story.xbrief.json"),
      JSON.stringify({ plan: { status: "blocked" } }),
      "utf8",
    );
    writeFileSync(
      join(active, "b-story.xbrief.json"),
      JSON.stringify({ plan: { status: "blocked" } }),
      "utf8",
    );
    const result = inspectActiveScope(project, { env: {} });
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("zero-eligible-blocked");
    expect(result.message).toContain("blocked");
  });

  // NTFS rejects a basename that contains a newline; the file-create assertion stays on other hosts (#4907).
  it.skipIf(process.platform === "win32")(
    "fences a blocked basename that contains a newline (#4840)",
    () => {
      const project = root();
      const active = join(project, "xbrief", "active");
      mkdirSync(active, { recursive: true });
      const injected = "evil\ninject.xbrief.json";
      writeFileSync(
        join(active, injected),
        JSON.stringify({ plan: { status: "blocked" } }),
        "utf8",
      );
      const result = inspectActiveScope(project, { env: {} });
      expect(result.ready).toBe(false);
      expect(result.denyKind).toBe("zero-eligible-blocked");
      expect(result.message).not.toContain("\n");
      expect(result.message).toContain(fenceUntrustedAcceptanceText(injected));
    },
  );

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

  it("second inspect returns ready after parent pin is visible to hook environ (#4880)", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    const storyB = writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);

    const before = inspectActiveScope(project, { env: {} });
    expect(before.ready).toBe(false);
    expect(before.denyKind).toBe("multiple-eligible");

    const after = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b-story.xbrief.json" },
    });
    expect(after).toMatchObject({ ready: true, path: storyB });
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

  it("binds a win32 pin that differs only by letter case", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    const storyB = writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);
    const pin = "Xbrief/Active/B-Story.xbrief.json";
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

describe("non-fencing partition for unpinned multi-eligible (#4880 Prefer-A C')", () => {
  function writeFencing(project: string, name: string, fileScope: readonly string[]): string {
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

  function writePathless(project: string, name: string, emptyArray = false): string {
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, name);
    const plan = emptyArray
      ? {
          ...runningPlacement,
          metadata: {
            ...runningPlacement.metadata,
            swarm: { file_scope: [] },
          },
        }
      : { ...runningPlacement };
    writeFileSync(path, JSON.stringify({ plan }), "utf8");
    return path;
  }

  it("fencing + absent file_scope competitor → unpinned ready binds fencing brief", () => {
    const project = root();
    const fencing = writeFencing(project, "fence-story.xbrief.json", ["packages/a/**"]);
    writePathless(project, "admin-story.xbrief.json");

    const result = inspectActiveScope(project, { env: {}, ...pathFenceSeam });
    expect(result).toMatchObject({ ready: true, path: fencing });
    expect(result.denyKind).toBeUndefined();
  });

  it("fencing + empty file_scope competitor → unpinned ready binds fencing brief", () => {
    const project = root();
    const fencing = writeFencing(project, "fence-story.xbrief.json", ["packages/a/**"]);
    writePathless(project, "empty-scope.xbrief.json", true);

    const result = inspectActiveScope(project, { env: {}, ...pathFenceSeam });
    expect(result).toMatchObject({ ready: true, path: fencing });
  });

  it("two fencing briefs → still multiple-eligible", () => {
    const project = root();
    writeFencing(project, "a-story.xbrief.json", ["packages/a/**"]);
    writeFencing(project, "b-story.xbrief.json", ["packages/b/**"]);

    const result = inspectActiveScope(project, { env: {}, ...pathFenceSeam });
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("multiple-eligible");
  });

  it("sole no-file_scope → still ready", () => {
    const project = root();
    const pathless = writePathless(project, "solo-admin.xbrief.json");

    const result = inspectActiveScope(project, { env: {}, ...pathFenceSeam });
    expect(result).toMatchObject({ ready: true, path: pathless });
  });

  it("explicit pin to no-file_scope with another fencing eligible → pin binds", () => {
    const project = root();
    writeFencing(project, "fence-story.xbrief.json", ["packages/a/**"]);
    const pathless = writePathless(project, "admin-story.xbrief.json");

    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/admin-story.xbrief.json" },
      ...pathFenceSeam,
    });
    expect(result).toMatchObject({ ready: true, path: pathless });
  });

  it("merge-base fencing beats emptied working-tree scope (write-gate SoT)", () => {
    const project = root();
    const emptied = writePathless(project, "emptied-story.xbrief.json", true);
    writeFencing(project, "other-story.xbrief.json", ["packages/b/**"]);
    const result = inspectActiveScope(project, {
      env: {},
      loadStoryWriteFence: (_root, scopePath) => {
        // Merge-base still fences both; working-tree emptied one.
        if (scopePath === emptied) {
          return { fileScope: ["packages/a/**"], denyPaths: [] };
        }
        return loadStoryWriteFenceFromPath(scopePath);
      },
    });
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("multiple-eligible");
  });
});

describe("omitted-env production pin (#4506 / #5386)", () => {
  it("warn+fallback when ambient pin misses and exactly one brief is eligible (#5386)", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const story = join(active, "story.xbrief.json");
    writeFileSync(story, JSON.stringify({ plan: runningPlacement }), "utf8");
    vi.stubEnv(ACTIVE_SCOPE_PIN_ENV, "xbrief/active/ineligible.xbrief.json");
    const result = inspectActiveScope(project);
    expect(result.ready).toBe(true);
    expect(result.path).toBe(story);
    expect(result.warning).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(result.warning).toContain("ineligible.xbrief.json");
    expect(result.warning).toContain("story.xbrief.json");
  });

  it("still fail-closes ambient pin miss when multiple briefs are eligible", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "a-story.xbrief.json"),
      JSON.stringify({ plan: runningPlacement }),
      "utf8",
    );
    writeFileSync(
      join(active, "b-story.xbrief.json"),
      JSON.stringify({ plan: runningPlacement }),
      "utf8",
    );
    vi.stubEnv(ACTIVE_SCOPE_PIN_ENV, "xbrief/active/ineligible.xbrief.json");
    const result = inspectActiveScope(project);
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("pin-miss");
    expect(result.message).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(result.message).toContain("ineligible.xbrief.json");
  });
});

describe("stale DEFT_ACTIVE_SCOPE pin-miss recovery (#5386)", () => {
  function writeRunning(project: string, name: string): string {
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const path = join(active, name);
    writeFileSync(path, JSON.stringify({ plan: runningPlacement }), "utf8");
    return path;
  }

  it("env miss + zero eligible: absent diagnosis + clear/repoint+restart, no promote/activate", () => {
    const project = root();
    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/gone.xbrief.json" },
    });
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("pin-miss");
    expect(result.message).toContain("absent from xbrief/active/");
    expect(result.message).toContain("gone.xbrief.json");
    expect(result.message).toMatch(/Clear or repoint/);
    expect(result.message).toMatch(/restart the host/);
    expect(result.message).toMatch(/Clearing the pin alone cannot make the fence ready/);
    expect(result.message).not.toMatch(/scope:promote|scope:activate/);
  });

  it("env miss + one eligible: warn+fallback binds that brief", () => {
    const project = root();
    const story = writeRunning(project, "live.xbrief.json");
    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/stale.xbrief.json" },
    });
    expect(result.ready).toBe(true);
    expect(result.path).toBe(story);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("stale.xbrief.json");
    expect(result.warning).toContain("live.xbrief.json");
    expect(result.warning).toContain(ACTIVE_SCOPE_PIN_ENV);
  });

  it("env miss + many eligible: still deny (no first-wins)", () => {
    const project = root();
    writeRunning(project, "a.xbrief.json");
    writeRunning(project, "b.xbrief.json");
    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/missing.xbrief.json" },
    });
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("pin-miss");
    expect(result.message).toContain("absent from xbrief/active/");
    expect(result.warning).toBeUndefined();
  });

  it("matched-rejected pin + one eligible alternative: still deny with evaluator reason", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "blocked.xbrief.json"),
      JSON.stringify({ plan: { status: "blocked" } }),
      "utf8",
    );
    const alt = writeRunning(project, "other.xbrief.json");
    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/blocked.xbrief.json" },
    });
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("pin-miss");
    expect(result.path).not.toBe(alt);
    expect(result.message).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(result.message).toContain("blocked.xbrief.json");
    expect(result.message).toMatch(/plan\.status is 'blocked'|not implementation-eligible/);
    expect(result.message).toMatch(/Recovery: run `deft scope:unblock -- <blocked-brief>`/);
    expect(result.message).not.toMatch(/scope:unblock -- «/);
    expect(result.warning).toBeUndefined();
  });

  it("explicit boundPath miss + one eligible alternative: still deny; no env-repair copy", () => {
    const project = root();
    writeRunning(project, "live.xbrief.json");
    const result = inspectActiveScope(project, {
      boundPath: "xbrief/active/missing-bound.xbrief.json",
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/live.xbrief.json" },
    });
    expect(result.ready).toBe(false);
    expect(result.denyKind).toBe("pin-miss");
    expect(result.message).toContain("boundPath");
    expect(result.message).toContain("missing-bound.xbrief.json");
    expect(result.message).toMatch(/does not override a nonempty boundPath/);
    expect(result.warning).toBeUndefined();
  });

  it("valid boundPath overrides stale env pin", () => {
    const project = root();
    writeRunning(project, "a.xbrief.json");
    const storyB = writeRunning(project, "b.xbrief.json");
    const result = inspectActiveScope(project, {
      boundPath: storyB,
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/stale.xbrief.json" },
    });
    expect(result).toMatchObject({ ready: true, path: storyB });
    expect(result.warning).toBeUndefined();
  });

  it("valid env pin is unchanged", () => {
    const project = root();
    writeRunning(project, "a.xbrief.json");
    const storyB = writeRunning(project, "b.xbrief.json");
    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b.xbrief.json" },
    });
    expect(result).toMatchObject({ ready: true, path: storyB });
    expect(result.warning).toBeUndefined();
  });

  it("fences a CR/LF-bearing env pin on allow-path warn (#5386 S2)", () => {
    const project = root();
    writeRunning(project, "live.xbrief.json");
    const evilPin = "xbrief/active/stale\ninject.xbrief.json";
    const result = inspectActiveScope(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: evilPin },
    });
    expect(result.ready).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).not.toContain("\n");
    expect(result.warning).toContain(
      fenceUntrustedAcceptanceText("xbrief/active/stale inject.xbrief.json"),
    );
  });
});

describe("soft-missing AC target selection (#4285)", () => {
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

  it("fails closed on two actives without pin or path", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);
    const result = resolveSoftMissingAcTargets(project, { env: {} });
    expect(result.kind).toBe("need-pin");
    if (result.kind !== "need-pin") return;
    expect(result.scannedCount).toBe(2);
    expect(result.message).toContain(ACTIVE_SCOPE_PIN_ENV);
    expect(result.message).toContain("#4285");
  });

  it("selects only the pinned story under soft-missing multi-active", () => {
    const project = root();
    writeRunning(project, "a-story.xbrief.json", ["packages/a/**"]);
    const storyB = writeRunning(project, "b-story.xbrief.json", ["packages/b/**"]);
    const byPin = resolveSoftMissingAcTargets(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/b-story.xbrief.json" },
    });
    expect(byPin).toEqual({ kind: "one", path: storyB });
    const byBound = resolveSoftMissingAcTargets(project, { boundPath: storyB, env: {} });
    expect(byBound).toEqual({ kind: "one", path: storyB });
  });

  it("refuses unpinned multi-active when only one artifact passes preflight", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "blocked-dispatched.xbrief.json"),
      JSON.stringify({ plan: { status: "blocked" } }),
      "utf8",
    );
    writeRunning(project, "foreign-leftover.xbrief.json", ["packages/foreign/**"]);
    // inspectActiveScope would select the sole eligible leftover; soft-missing must not.
    expect(inspectActiveScope(project, { env: {} })).toMatchObject({
      ready: true,
      path: join(active, "foreign-leftover.xbrief.json"),
    });
    const result = resolveSoftMissingAcTargets(project, { env: {} });
    expect(result.kind).toBe("need-pin");
    if (result.kind !== "need-pin") return;
    expect(result.scannedCount).toBe(2);
    expect(result.denyKind).toBe("multiple-eligible");
    expect(result.message).toContain(ACTIVE_SCOPE_PIN_ENV);
  });

  it("selects a pinned blocked story for soft-missing acceptance", () => {
    const project = root();
    const active = join(project, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const blocked = join(active, "blocked-dispatched.xbrief.json");
    writeFileSync(blocked, JSON.stringify({ plan: { status: "blocked" } }), "utf8");
    writeRunning(project, "foreign-leftover.xbrief.json", ["packages/foreign/**"]);
    const byPin = resolveSoftMissingAcTargets(project, {
      env: { [ACTIVE_SCOPE_PIN_ENV]: "xbrief/active/blocked-dispatched.xbrief.json" },
    });
    expect(byPin).toEqual({ kind: "one", path: blocked });
    const byBound = resolveSoftMissingAcTargets(project, { boundPath: blocked, env: {} });
    expect(byBound).toEqual({ kind: "one", path: blocked });
  });
});
