import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, runCliCapture } from "./cli.js";
import {
  addLabelToScope,
  addMilestoneToScope,
  fetchUpstreamLabelsAndMilestones,
} from "./mutations.js";
import {
  addIgnore,
  loadProjectDefinitionForMutation,
  ProjectDefinitionIOError,
  recordSubscriptionChange,
  subscribe,
} from "./mutations-core.js";
import { normalizeScopeRules, subscriptionHash } from "./normalize.js";
import { extractReferencedIssues, renderIgnores, renderList } from "./renderers.js";
import {
  getRawIgnores,
  getRawScope,
  isDefaultApplied,
  loadProjectDefinition,
  resolveScopeIgnores,
  resolveScopeRules,
} from "./resolve.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

const mockedSpawn = vi.mocked(spawnSync);

function writePd(root: string, body: Record<string, unknown>): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}

describe("mutations-core branch coverage", () => {
  it("loadProjectDefinitionForMutation error paths", () => {
    const root = mkdtempSync(join(tmpdir(), "mcio-"));
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(ProjectDefinitionIOError);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "[]", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not a JSON object/);
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{bad", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not valid JSON/);
  });

  it("subscribe label appends to existing any-of and milestone paths", () => {
    const root = mkdtempSync(join(tmpdir(), "mcs-"));
    writePd(root, {
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { triageScope: [{ rule: "labels", "any-of": ["bug"] }] },
      },
    });
    const [added] = subscribe(root, { label: "docs" });
    expect(added).toBe(true);
    const [dup] = subscribe(root, { label: "docs" });
    expect(dup).toBe(false);
    const [ms] = subscribe(root, { milestone: "v1" });
    expect(ms).toBe(true);
    const [dupMs] = subscribe(root, { milestone: "v1" });
    expect(dupMs).toBe(false);
  });

  it("subscribe rejects invalid args and malformed scope list", () => {
    const root = mkdtempSync(join(tmpdir(), "mce-"));
    writePd(root, {
      plan: { title: "T", status: "running", items: [], policy: { triageScope: "bad" } },
    });
    expect(() => subscribe(root, { label: "x" })).toThrow(/non-list/);
    expect(() => subscribe(root, {} as { label?: string })).toThrow(/exactly one/);
    expect(() => addIgnore(root, "  ")).toThrow(/non-empty string/);
  });

  it("addIgnore rejects non-list ignores and duplicate label", () => {
    const root = mkdtempSync(join(tmpdir(), "mci-"));
    writePd(root, {
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { triageScopeIgnores: "nope" },
      },
    });
    expect(() => addIgnore(root, "x")).toThrow(/non-list/);
    writePd(root, {
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { triageScopeIgnores: [{ label: "dup" }] },
      },
    });
    expect(addIgnore(root, "dup")[0]).toBe(false);
  });

  it("recordSubscriptionChange uses actor env and survives append errors", () => {
    const root = mkdtempSync(join(tmpdir(), "mca-"));
    process.env.DEFT_TRIAGE_ACTOR = "ci:bot";
    recordSubscriptionChange(root, { op: "test", label: "x" });
    delete process.env.DEFT_TRIAGE_ACTOR;
    recordSubscriptionChange("/\0invalid", { op: "test" });
  });
});

describe("renderers and resolve branch coverage", () => {
  it("extractReferencedIssues walks vbrief lifecycle folders", () => {
    const root = mkdtempSync(join(tmpdir(), "ref-"));
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "story.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/42/" },
            { type: "other", uri: "x" },
            { type: "x-vbrief/github-issue", uri: "not-a-number" },
          ],
        },
      }),
      "utf8",
    );
    writeFileSync(join(root, "vbrief", "proposed", "bad.vbrief.json"), "not-json", "utf8");
    writeFileSync(
      join(root, "vbrief", "proposed", "slice.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/7" }],
        },
      }),
      "utf8",
    );
    const refs = extractReferencedIssues(root);
    expect(refs.any).toEqual(new Set([42, 7]));
    expect(refs.active).toEqual(new Set([42]));
    expect(extractReferencedIssues("/missing-vbrief-root")).toEqual({
      any: new Set(),
      active: new Set(),
    });
  });

  it("renderList and renderIgnores cover rule variants", () => {
    const list = renderList(
      [
        { rule: "labels", "all-of": ["a", "b"] },
        { rule: "milestone", name: "M1" },
        { rule: "milestone", "any-of": ["x"] },
        { rule: "milestone", "is-open": true },
        { rule: "referenced-by-vbrief", scope: "active" },
        { rule: "sliced-from", scope: "proposed" },
        {
          rule: "explicit-watch",
          issues: [{ n: 2, note: "watch" }, null, { n: 1, note: "first" }],
        },
        { rule: "custom" },
        null as unknown as Record<string, unknown>,
      ],
      { isDefault: true },
    );
    expect(list).toContain("default applied");
    expect(list).toContain("all-of");
    expect(list).toContain("referenced-by-vbrief");
    expect(list).toContain("sliced-from");
    expect(list).toContain("explicit-watch");
    const ignores = renderIgnores([
      { label: "bug" },
      { milestone: "v1" },
      { rule: "author", "any-of": ["bot", ""] },
      { weird: true },
    ]);
    expect(ignores).toContain("labels:");
    expect(ignores).toContain("milestones:");
    expect(ignores).toContain("authors:");
    expect(ignores).toContain("unrecognised");
  });

  it("resolve helpers cover null and malformed policy branches", () => {
    expect(isDefaultApplied(null)).toBe(true);
    expect(isDefaultApplied({ plan: { policy: { triageScope: [{ rule: "all-open" }] } } })).toBe(
      false,
    );
    expect(getRawScope({ plan: [] as unknown as Record<string, unknown> })).toBeUndefined();
    expect(
      getRawIgnores({ plan: { policy: { triageScopeIgnores: [{ label: "x" }, null, 1] } } }),
    ).toEqual([{ label: "x" }]);
    const root = mkdtempSync(join(tmpdir(), "resx-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{", "utf8");
    expect(loadProjectDefinition(root)).toBeNull();
    writePd(root, {
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: {
          triageScope: [null, { rule: "all-open" }],
          triageScopeIgnores: [{ rule: "author", "any-of": ["bot"] }, { milestone: "  " }],
        },
      },
    });
    expect(resolveScopeRules(root)).toEqual([{ rule: "all-open" }]);
    const ignores = resolveScopeIgnores(root);
    expect(ignores.authors.has("bot")).toBe(true);
    expect(ignores.milestones.size).toBe(0);
    expect(
      resolveScopeRules(root, {
        plan: { policy: { triageScope: [{ rule: "labels", "any-of": ["z"] }] } },
      })[0],
    ).toEqual({
      rule: "labels",
      "any-of": ["z"],
    });
  });

  it("normalizeScopeRules skips invalid entries and sorts equal hashes", () => {
    const rules = normalizeScopeRules([
      null as unknown as Record<string, unknown>,
      { rule: "labels", "any-of": ["b", "a"] },
      {
        rule: "explicit-watch",
        issues: [
          { n: 2, note: "b" },
          { n: 1, note: "a" },
        ],
      },
    ]);
    expect(rules.length).toBe(2);
    expect(subscriptionHash(rules)).toHaveLength(16);
  });
});

describe("cli parse and mutation branches", () => {
  it("parseCliArgs reads equals and space forms", () => {
    const parsed = parseCliArgs([
      "--project-root=/tmp/p",
      "--repo=org/repo",
      "--add-label=bug",
      "--source=local",
      "--cache-root=/cache",
      "--count",
      "9",
      "--list",
      "--refresh-denominator",
      "--diff-from-upstream",
    ]);
    expect(parsed.projectRoot).toBe("/tmp/p");
    expect(parsed.repo).toBe("org/repo");
    expect(parsed.addLabel).toBe("bug");
    expect(parsed.count).toBe(9);
    expect(parsed.doList).toBe(true);
  });

  it("runCliCapture covers help, mutex, refresh, and milestone mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "clic-"));
    writePd(root, { plan: { title: "T", status: "running", items: [] } });
    expect(runCliCapture(["--project-root", root]).stdout).toContain("usage:");
    const mutex = runCliCapture(["--project-root", root, "--add-label=a", "--ignore-label=b"]);
    expect(mutex.code).toBe(2);
    expect(mutex.stderr).toContain("mutually exclusive");
    const refresh = runCliCapture(["--project-root", root, "--refresh-denominator"]);
    expect(refresh.code).toBe(2);
    expect(refresh.stderr).toContain("requires --repo");
    const ms = runCliCapture(["--project-root", root, "--add-milestone=v1", "--list"]);
    expect(ms.code).toBe(0);
    expect(ms.stdout).toContain("v1");
    const valid = runCliCapture(["--project-root", root, "--list"]);
    expect(valid.code).toBe(0);
    writePd(root, {
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { triageScope: [{ rule: "labels" }] },
      },
    });
    const invalid = runCliCapture(["--project-root", root, "--list"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("validation error");
  });
});

describe("mutations fetch timeout branch", () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws on ETIMEDOUT spawn error", () => {
    mockedSpawn.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [null, "", ""],
      signal: null,
      error: new Error("spawnSync ETIMEDOUT"),
    } as ReturnType<typeof spawnSync>);
    expect(() => fetchUpstreamLabelsAndMilestones("o/r", "gh")).toThrow(/timed out/);
  });

  it("rejects malformed repo string", () => {
    expect(() => fetchUpstreamLabelsAndMilestones("badrepo")).toThrow(/--repo must be/);
    expect(() => addMilestoneToScope("/missing", "  ")).toThrow(/non-empty string/);
    expect(() => addLabelToScope("/missing", "  ")).toThrow(/non-empty string/);
  });
});
