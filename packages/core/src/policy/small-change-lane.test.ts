import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateProvisionalCeremonyInputs } from "./ceremony-dial.js";
import {
  buildSmallChangeLaneMarker,
  classifyPublicSurfacePath,
  evaluateSmallChangeLane,
  evaluateSmallChangeLaneGate,
  isFullBriefShape,
  isLaneLifecyclePath,
  measureSmallChangeLaneDiff,
  readSmallChangeLaneBound,
  readSmallChangeLaneBoundFromProject,
  readSmallChangeLaneMarker,
  SMALL_CHANGE_LANE_DEFAULT_MAX_CHANGED_LINES,
  SMALL_CHANGE_LANE_DEFAULT_MAX_PRODUCTION_FILES,
  SMALL_CHANGE_LANE_MARKER_KEY,
  SMALL_CHANGE_LANE_REMEDIATION,
  type SmallChangeLaneMeasurement,
  validateSmallChangeLaneBound,
} from "./small-change-lane.js";

const BOUND = { maxProductionFiles: 2, maxChangedLines: 10 };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function write(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

/** Temp repo with one committed production file; returns root and the admit base. */
function initRepo(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "small-change-lane-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "lane@test.invalid");
  git(root, "config", "user.name", "lane");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  write(root, "src/a.ts", "const a = 1;\nconst b = 2;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

function measurement(over: Partial<SmallChangeLaneMeasurement> = {}): SmallChangeLaneMeasurement {
  return {
    base: "abc123",
    source: "worktree",
    productionFiles: ["src/a.ts"],
    changedLines: 4,
    publicSurface: "none",
    publicSurfaceReason: "no manifest, entry, task or export change",
    ...over,
  };
}

function lanePlan(admitBase: string, state: "admitted" | "escalated" = "admitted") {
  return {
    title: "fix",
    status: "running",
    items: [],
    acceptance: {
      commands: [{ command: "npx vitest run a.test.ts" }],
      none_stated: false,
      source_rung: "stated",
    },
    metadata: {
      swarm: { file_scope: ["src/a.ts"] },
      [SMALL_CHANGE_LANE_MARKER_KEY]: buildSmallChangeLaneMarker(admitBase, state),
    },
  };
}

describe("evaluateSmallChangeLane (#6204 predicate)", () => {
  it("admits only at rapid", () => {
    for (const depth of ["minimal", "standard", "elevated"] as const) {
      const v = evaluateSmallChangeLane({
        depth,
        bound: BOUND,
        measure: { ok: true, measurement: measurement() },
      });
      expect(v.ok).toBe(false);
      expect(v.kind).toBe("not-rapid");
    }
    const ok = evaluateSmallChangeLane({
      depth: "rapid",
      bound: BOUND,
      measure: { ok: true, measurement: measurement() },
    });
    expect(ok).toMatchObject({ ok: true, kind: "admitted" });
  });

  it("refuses when the bound is invalid", () => {
    const v = evaluateSmallChangeLane({
      depth: "rapid",
      bound: null,
      measure: { ok: true, measurement: measurement() },
    });
    expect(v).toMatchObject({ ok: false, kind: "unconfigured" });
    expect(v.reason).toContain("plan.policy.ceremonyDial.smallChangeLane");
  });

  it("refuses an unmeasured diff and an unknown public surface", () => {
    expect(
      evaluateSmallChangeLane({ depth: "rapid", bound: BOUND, measure: { ok: false, reason: "x" } })
        .kind,
    ).toBe("unmeasured");
    expect(
      evaluateSmallChangeLane({
        depth: "rapid",
        bound: BOUND,
        measure: { ok: true, measurement: measurement({ publicSurface: "unknown" }) },
      }).kind,
    ).toBe("public-surface-unknown");
    expect(
      evaluateSmallChangeLane({
        depth: "rapid",
        bound: BOUND,
        measure: { ok: true, measurement: measurement({ publicSurface: "changed" }) },
      }).kind,
    ).toBe("public-surface-changed");
  });

  it("refuses past either bound and admits at the bound", () => {
    const at = measurement({ productionFiles: ["src/a.ts", "src/b.ts"], changedLines: 10 });
    expect(
      evaluateSmallChangeLane({
        depth: "rapid",
        bound: BOUND,
        measure: { ok: true, measurement: at },
      }).ok,
    ).toBe(true);
    const files = measurement({ productionFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    const lines = measurement({ changedLines: 11 });
    for (const m of [files, lines]) {
      const v = evaluateSmallChangeLane({
        depth: "rapid",
        bound: BOUND,
        measure: { ok: true, measurement: m },
      });
      expect(v.kind).toBe("bound-crossed");
    }
  });
});

describe("small-change lane bound policy", () => {
  it("validates and reads the bound under plan.policy.ceremonyDial", () => {
    expect(validateSmallChangeLaneBound(BOUND)).toEqual([]);
    expect(
      validateSmallChangeLaneBound({ maxProductionFiles: -1, maxChangedLines: 1.5 }),
    ).toHaveLength(2);
    expect(validateSmallChangeLaneBound("x")).toHaveLength(1);
    expect(readSmallChangeLaneBound({ smallChangeLane: BOUND })).toEqual({
      bound: BOUND,
      error: null,
    });
    const bad = readSmallChangeLaneBound({ smallChangeLane: { maxChangedLines: "many" } });
    expect(bad.bound).toBeNull();
    expect(bad.error).toContain("maxChangedLines");
  });

  it("uses the shipped defaults (5 files, 500 lines) when the policy field is unset", () => {
    expect(SMALL_CHANGE_LANE_DEFAULT_MAX_PRODUCTION_FILES).toBe(5);
    expect(SMALL_CHANGE_LANE_DEFAULT_MAX_CHANGED_LINES).toBe(500);
    const defaults = { maxProductionFiles: 5, maxChangedLines: 500 };
    expect(readSmallChangeLaneBound({})).toEqual({ bound: defaults, error: null });
    expect(readSmallChangeLaneBound(null)).toEqual({ bound: defaults, error: null });
    expect(readSmallChangeLaneBound({ smallChangeLane: null }).bound).toEqual(defaults);
  });

  it("lets a policy value override each field on its own", () => {
    expect(readSmallChangeLaneBound({ smallChangeLane: { maxProductionFiles: 1 } }).bound).toEqual({
      maxProductionFiles: 1,
      maxChangedLines: 500,
    });
    expect(readSmallChangeLaneBound({ smallChangeLane: { maxChangedLines: 40 } }).bound).toEqual({
      maxProductionFiles: 5,
      maxChangedLines: 40,
    });
  });

  it("reads the bound from PROJECT-DEFINITION", () => {
    const root = mkdtempSync(join(tmpdir(), "small-change-lane-pd-"));
    roots.push(root);
    write(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "P",
          status: "running",
          items: [],
          policy: { ceremonyDial: { smallChangeLane: BOUND } },
        },
      }),
    );
    expect(readSmallChangeLaneBoundFromProject(root)).toEqual({ bound: BOUND, error: null });
  });
});

describe("measureSmallChangeLaneDiff (#6204 measurement)", () => {
  it("measures the cumulative worktree diff against the lane-admit base", () => {
    const { root, base } = initRepo();
    write(root, "src/a.ts", "const a = 1;\nconst b = 3;\n");
    git(root, "commit", "-q", "-am", "first");
    write(root, "src/b.ts", "const c = 1;\n");
    write(root, "src/a.test.ts", "it('x', () => {});\n");
    write(root, "xbrief/active/x.xbrief.json", "{}\n");
    write(root, "CHANGELOG.md", "- entry\n");
    const r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.measurement.base).toBe(base);
    expect(r.measurement.source).toBe("worktree");
    // Committed + untracked are cumulative; tests count lines, not production files.
    expect(r.measurement.productionFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.measurement.changedLines).toBe(4);
    expect(r.measurement.publicSurface).toBe("none");
  });

  it("measures a delivered commit against its first parent only", () => {
    const { root } = initRepo();
    write(root, "src/a.ts", "const a = 1;\nconst b = 3;\n");
    git(root, "commit", "-q", "-am", "delivered");
    const delivered = git(root, "rev-parse", "HEAD");
    write(root, "src/later.ts", "const later = 1;\n");
    const r = measureSmallChangeLaneDiff({
      projectRoot: root,
      admitBase: "does-not-matter",
      deliveredCommit: delivered,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.measurement.source).toBe("delivered");
    expect(r.measurement.productionFiles).toEqual(["src/a.ts"]);
    expect(r.measurement.changedLines).toBe(2);
  });

  it("determines public surface from the diff, not a declaration", () => {
    const { root, base } = initRepo();
    write(root, "src/a.ts", "export const a = 1;\nconst b = 2;\n");
    let r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok && r.measurement.publicSurface).toBe("changed");

    git(root, "checkout", "-q", "--", "src/a.ts");
    write(root, "package.json", "{}\n");
    r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok && r.measurement.publicSurface).toBe("changed");

    rmSync(join(root, "package.json"));
    write(root, "src/tool.py", "x = 1\n");
    r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok && r.measurement.publicSurface).toBe("unknown");

    rmSync(join(root, "src/tool.py"));
    write(root, "docs/notes.md", "note\n");
    r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok && r.measurement.publicSurface).toBe("none");
  });

  it("fails the measurement on a binary file, a bad base, or no git tree", () => {
    const { root, base } = initRepo();
    write(root, "src/blob.bin", "a\0b");
    expect(measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base }).ok).toBe(false);
    rmSync(join(root, "src/blob.bin"));
    expect(measureSmallChangeLaneDiff({ projectRoot: root, admitBase: "0".repeat(40) }).ok).toBe(
      false,
    );
    expect(measureSmallChangeLaneDiff({ projectRoot: root, admitBase: "" }).ok).toBe(false);
    const bare = mkdtempSync(join(tmpdir(), "small-change-lane-nogit-"));
    roots.push(bare);
    expect(measureSmallChangeLaneDiff({ projectRoot: bare, admitBase: base }).ok).toBe(false);
  });

  it("classifies lifecycle and public-surface paths", () => {
    expect(isLaneLifecyclePath("xbrief/active/x.json")).toBe(true);
    expect(isLaneLifecyclePath("CHANGELOG.md")).toBe(true);
    expect(isLaneLifecyclePath("src/a.ts")).toBe(false);
    expect(classifyPublicSurfacePath("packages/core/src/index.ts")).toBe("surface");
    expect(classifyPublicSurfacePath("tasks/verify.yml")).toBe("surface");
    expect(classifyPublicSurfacePath("src/a.ts")).toBe("code");
    expect(classifyPublicSurfacePath("README.md")).toBe("doc");
    expect(classifyPublicSurfacePath("src/a.go")).toBe("unknown");
  });
});

describe("small-change lane marker", () => {
  it("reads absent, invalid and valid markers", () => {
    expect(readSmallChangeLaneMarker({ metadata: {} })).toEqual({ present: false });
    expect(
      readSmallChangeLaneMarker({ metadata: { [SMALL_CHANGE_LANE_MARKER_KEY]: {} } }),
    ).toMatchObject({
      present: true,
      ok: false,
    });
    expect(
      readSmallChangeLaneMarker({
        metadata: {
          [SMALL_CHANGE_LANE_MARKER_KEY]: { ...buildSmallChangeLaneMarker("x"), state: "other" },
        },
      }),
    ).toMatchObject({ present: true, ok: false });
    expect(
      readSmallChangeLaneMarker({
        metadata: { [SMALL_CHANGE_LANE_MARKER_KEY]: buildSmallChangeLaneMarker(" ") },
      }),
    ).toMatchObject({ present: true, ok: false });
    expect(readSmallChangeLaneMarker(lanePlan("abc"))).toEqual({
      present: true,
      ok: true,
      marker: { state: "admitted", admitBase: "abc" },
    });
  });

  it("full brief shape needs a narrative and an item", () => {
    expect(isFullBriefShape({ narratives: {}, items: [] })).toBe(false);
    expect(isFullBriefShape({ narratives: { Description: "x" }, items: [] })).toBe(false);
    expect(isFullBriefShape({ narratives: { Description: "x" }, items: [{}] })).toBe(true);
    expect(isFullBriefShape(null)).toBe(false);
  });
});

describe("evaluateSmallChangeLaneGate (#6204 recheck + lane exit)", () => {
  it("is a no-op for a brief outside the lane", () => {
    const r = evaluateSmallChangeLaneGate(
      { title: "x", items: [] },
      { projectRoot: ".", gate: "verify:ac" },
    );
    expect(r).toMatchObject({ applies: false, ok: true });
  });

  it("admits a brief within the bound at rapid", () => {
    const { root, base } = initRepo();
    write(root, "src/a.ts", "const a = 1;\nconst b = 3;\n");
    const r = evaluateSmallChangeLaneGate(lanePlan(base), {
      projectRoot: root,
      gate: "xbrief:preflight",
      depth: "rapid",
      bound: BOUND,
    });
    expect(r).toMatchObject({ applies: true, ok: true });
    expect(r.message).toContain("within bound");
  });

  it("refuses every retry once the bound is crossed, with the one lane-exit remediation", () => {
    const { root, base } = initRepo();
    write(root, "src/a.ts", "const a = 1;\nconst b = 3;\n");
    write(root, "src/b.ts", "const b = 1;\n");
    write(root, "src/c.ts", "const c = 1;\n");
    for (const gate of ["xbrief:preflight", "verify:ac", "scope:complete", "verify:ac"] as const) {
      const r = evaluateSmallChangeLaneGate(lanePlan(base), {
        projectRoot: root,
        gate,
        depth: "rapid",
        bound: BOUND,
      });
      expect(r.ok).toBe(false);
      expect(r.verdict?.kind).toBe("bound-crossed");
      expect(r.message).toContain(`${gate} refused (#6204)`);
      expect(r.message).toContain(SMALL_CHANGE_LANE_REMEDIATION);
    }
  });

  it("a #3319 dial-depth raise does not clear the refusal", () => {
    const { root, base } = initRepo();
    for (const depth of ["standard", "elevated"] as const) {
      const r = evaluateSmallChangeLaneGate(lanePlan(base), {
        projectRoot: root,
        gate: "verify:ac",
        depth,
        bound: BOUND,
      });
      expect(r.ok).toBe(false);
      expect(r.verdict?.kind).toBe("not-rapid");
    }
  });

  it("provisional dial estimators are not proof: a size-S estimate still refuses a crossed bound", () => {
    const estimate = estimateProvisionalCeremonyInputs({ fileCount: 1, env: {} });
    expect(estimate.taskSize).toBe("S");
    const { root, base } = initRepo();
    write(root, "src/a.ts", `${"const x = 1;\n".repeat(20)}`);
    const r = evaluateSmallChangeLaneGate(lanePlan(base), {
      projectRoot: root,
      gate: "verify:ac",
      depth: "rapid",
      bound: BOUND,
    });
    expect(r.verdict?.kind).toBe("bound-crossed");
  });

  it("refuses an unconfigured bound and an invalid marker", () => {
    const { root, base } = initRepo();
    const unset = evaluateSmallChangeLaneGate(lanePlan(base), {
      projectRoot: root,
      gate: "verify:ac",
      depth: "rapid",
      bound: null,
    });
    expect(unset.verdict?.kind).toBe("unconfigured");
    const invalid = evaluateSmallChangeLaneGate(
      { metadata: { [SMALL_CHANGE_LANE_MARKER_KEY]: { schema: "x" } } },
      { projectRoot: root, gate: "verify:ac" },
    );
    expect(invalid).toMatchObject({ applies: true, ok: false });
  });

  it("an escalated scope passes only with the full brief shape", () => {
    const { root, base } = initRepo();
    const thin = evaluateSmallChangeLaneGate(lanePlan(base, "escalated"), {
      projectRoot: root,
      gate: "scope:complete",
    });
    expect(thin.ok).toBe(false);
    expect(thin.message).toContain("lane exit is incomplete");
    const full = evaluateSmallChangeLaneGate(
      { ...lanePlan(base, "escalated"), narratives: { Description: "x" }, items: [{ title: "i" }] },
      { projectRoot: root, gate: "scope:complete" },
    );
    expect(full).toMatchObject({ applies: true, ok: true });
  });

  it("reads depth and bound from the project when not overridden", () => {
    const { root, base } = initRepo();
    write(
      root,
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "P",
          status: "running",
          items: [],
          policy: { ceremonyDial: { override: "rapid", smallChangeLane: BOUND } },
        },
      }),
    );
    write(root, "src/a.ts", "const a = 1;\nconst b = 3;\n");
    const r = evaluateSmallChangeLaneGate(lanePlan(base), { projectRoot: root, gate: "verify:ac" });
    expect(r).toMatchObject({ applies: true, ok: true });
  });

  it("applies the default bound at the gate when policy leaves it unset, and a policy value tightens it", () => {
    const { root, base } = initRepo();
    const writePolicy = (ceremonyDial: Record<string, unknown>) =>
      write(
        root,
        "xbrief/PROJECT-DEFINITION.xbrief.json",
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "P", status: "running", items: [], policy: { ceremonyDial } },
        }),
      );
    write(root, "src/a.ts", `${"const x = 1;\n".repeat(30)}`);
    writePolicy({ override: "rapid" });
    const byDefault = evaluateSmallChangeLaneGate(lanePlan(base), {
      projectRoot: root,
      gate: "verify:ac",
    });
    expect(byDefault).toMatchObject({ applies: true, ok: true });
    writePolicy({ override: "rapid", smallChangeLane: { maxChangedLines: 10 } });
    const tightened = evaluateSmallChangeLaneGate(lanePlan(base), {
      projectRoot: root,
      gate: "verify:ac",
    });
    expect(tightened.verdict?.kind).toBe("bound-crossed");
    expect(tightened.message).toContain("(max 10)");
  });
});

describe("export-statement spans (Greptile P1 on #6240)", () => {
  function repoWith(path: string, text: string): { root: string; base: string } {
    const { root } = initRepo();
    write(root, path, text);
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "seed");
    return { root, base: git(root, "rev-parse", "HEAD") };
  }

  it("removing a name from a multi-line export list changes public surface", () => {
    const { root, base } = repoWith(
      "src/lib.ts",
      'export {\n  alpha,\n  beta,\n} from "./impl.js";\nconst keep = 1;\n',
    );
    write(root, "src/lib.ts", 'export {\n  alpha,\n} from "./impl.js";\nconst keep = 1;\n');
    const r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok && r.measurement.publicSurface).toBe("changed");
    expect(r.ok && r.measurement.publicSurfaceReason).toContain("export statement");
  });

  it("changing a parameter on a multi-line exported signature changes public surface", () => {
    const { root, base } = repoWith(
      "src/fn.ts",
      "export function run(\n  a: number,\n): number {\n  return a;\n}\n",
    );
    write(root, "src/fn.ts", "export function run(\n  a: string,\n): number {\n  return a;\n}\n");
    const r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok && r.measurement.publicSurface).toBe("changed");
  });

  it("changing only an exported function body keeps public surface none", () => {
    const { root, base } = repoWith(
      "src/fn.ts",
      "export function run(a: number): number {\n  const b = a + 1;\n  return b;\n}\n",
    );
    write(
      root,
      "src/fn.ts",
      "export function run(a: number): number {\n  const b = a + 2;\n  return b;\n}\n",
    );
    const r = measureSmallChangeLaneDiff({ projectRoot: root, admitBase: base });
    expect(r.ok && r.measurement.publicSurface).toBe("none");
  });
});

describe("crossing persistence (Greptile P1 on #6240)", () => {
  it("records a crossing on the brief and refuses a later retry under the bound", () => {
    const { root, base } = initRepo();
    const briefPath = join(root, "xbrief", "active", "thin.xbrief.json");
    write(
      root,
      "xbrief/active/thin.xbrief.json",
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: lanePlan(base) }),
    );
    write(root, "src/a.ts", `${"const x = 1;\n".repeat(20)}`);
    const crossed = evaluateSmallChangeLaneGate(lanePlan(base), {
      projectRoot: root,
      gate: "verify:ac",
      depth: "rapid",
      bound: BOUND,
      briefPath,
    });
    expect(crossed.ok).toBe(false);
    expect(crossed.message).toContain("recorded on the brief as crossed");
    const onDisk = JSON.parse(readFileSync(briefPath, "utf8")) as {
      plan: Record<string, unknown>;
    };
    expect(readSmallChangeLaneMarker(onDisk.plan)).toMatchObject({
      ok: true,
      marker: { state: "crossed", admitBase: base },
    });

    // Shrink the diff back under the bound: still refused until lane exit.
    git(root, "checkout", "-q", "--", "src/a.ts");
    const retry = evaluateSmallChangeLaneGate(onDisk.plan, {
      projectRoot: root,
      gate: "verify:ac",
      depth: "rapid",
      bound: BOUND,
      briefPath,
    });
    expect(retry.ok).toBe(false);
    expect(retry.message).toContain("crossed after admit");
  });

  it("reports when the crossing cannot be recorded", () => {
    const { root, base } = initRepo();
    write(root, "src/a.ts", `${"const x = 1;\n".repeat(20)}`);
    const r = evaluateSmallChangeLaneGate(lanePlan(base), {
      projectRoot: root,
      gate: "verify:ac",
      depth: "rapid",
      bound: BOUND,
      briefPath: join(root, "missing.xbrief.json"),
    });
    expect(r.message).toContain("could not record the crossing");
  });
});
