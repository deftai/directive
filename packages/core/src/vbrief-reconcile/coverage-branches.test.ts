import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as scm from "../scm/call.js";
import { formatVbriefJson } from "../scope/vbrief-json.js";
import { graphOutcomeToJson, reconcileGraph, renderGraphReport } from "./graph.js";
import {
  computeDesiredLabels,
  labelsOutcomeToJson,
  reconcileLabels,
  renderLabelsReport,
  ScmLabelClient,
  ScmLabelError,
} from "./labels.js";
import { run, runGraph, runLabels, runUmbrellas } from "./main.js";
import { loadFixtureBrief, runParityScenario } from "./parity-scenarios.js";
import {
  detectStatusMarker,
  formatReconciliationMarkdown,
  hasDisagreement,
  parseOverridesYaml,
  reconcileScopeItems,
  writeReconciliationReport,
} from "./reconciliation.js";
import { allScopeIds, candidateDepGraph, candidateFromPath, markCycles } from "./swarm-deps.js";
import type { Candidate } from "./types.js";
import {
  buildChildIndex,
  childFromData,
  computeChildren,
  reconcileUmbrellas,
  renderUmbrellasReport,
  ScmUmbrellaClient,
} from "./umbrellas.js";

describe("coverage branches round 2", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("renderGraphReport lists waiting cycles and errors", () => {
    const report = renderGraphReport({
      promoted: ["a"],
      deferredWip: ["b"],
      waiting: [{ story_id: "c", unresolved: ["d", "e"] }],
      cycles: ["a -> b -> a"],
      errors: [{ story_id: "x", message: "bad" }],
      cap: 5,
      count: 3,
      dryRun: true,
      forced: false,
    });
    expect(report).toContain("c: needs d, e");
    expect(report).toContain("a -> b -> a");
    expect(report).toContain("Errors:");
    expect(
      graphOutcomeToJson({
        promoted: ["a"],
        deferredWip: [],
        waiting: [{ story_id: "w", unresolved: ["z"] }],
        cycles: [],
        errors: [],
        cap: 1,
        count: 0,
        dryRun: false,
        forced: false,
      }),
    ).toHaveProperty("waiting");
  });

  it("main runners json success and error stderr branches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-json2-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    expect(runGraph({ projectRoot: root, json: true })).toBe(0);
    expect(runLabels({ projectRoot: root, json: true })).toBe(0);
    expect(runUmbrellas({ projectRoot: root, json: true })).toBe(0);
    expect(runGraph({ projectRoot: join(root, "missing"), json: false })).toBe(2);
    expect(runUmbrellas({ projectRoot: join(root, "missing"), json: true })).toBe(2);
  });

  it("run graph labels umbrellas via argv", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-run-argv-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    expect(run(["graph", "--project-root", root, "--json"])).toBe(0);
    expect(run(["labels", "--project-root", root])).toBe(0);
    expect(run(["umbrellas", "--project-root", root, "--json"])).toBe(0);
  });

  it("formatReconciliationMarkdown overrides and orphans sections", () => {
    const md = formatReconciliationMarkdown(
      {
        conflicts: [],
        orphans: [{ task_id: "orph", title: "Orphan title" }],
        overridesTriggered: [
          { task_id: "t1", title: "One", action: "dropped from migration" },
          { task_id: "t2", fields: "status=completed" },
        ],
        overridesUnused: ["unused-key"],
      },
      new Date("2026-06-19T12:00:00Z"),
    );
    expect(md).toContain("orph");
    expect(md).toContain("dropped from migration");
    expect(md).toContain("unused-key");
    expect(
      hasDisagreement({
        conflicts: [{ task_id: "x", title: "t", dimensions: [] }],
        orphans: [],
        overridesTriggered: [],
        overridesUnused: [],
      }),
    ).toBe(true);
  });

  it("writeReconciliationReport skips when no disagreement", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-wrr-"));
    roots.push(root);
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    expect(
      writeReconciliationReport(
        { conflicts: [], orphans: [], overridesTriggered: [], overridesUnused: [] },
        vbrief,
      ),
    ).toBeNull();
  });

  it("swarm-deps non-object branches and allScopeIds stem alias", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sd-"));
    roots.push(root);
    const proposed = join(root, "vbrief", "proposed");
    mkdirSync(proposed, { recursive: true });
    writeFileSync(join(proposed, "bad-json.vbrief.json"), "{bad\n");
    writeFileSync(
      join(proposed, "from-name.vbrief.json"),
      `${JSON.stringify({ plan: { status: "proposed", metadata: { swarm: 1 } } })}\n`,
    );
    writeFileSync(
      join(proposed, "with-id.vbrief.json"),
      `${JSON.stringify({ plan: { id: "wid", status: "proposed", metadata: { swarm: "bad" } } })}\n`,
    );
    expect(candidateFromPath(join(proposed, "bad-json.vbrief.json"), root)).toBeNull();
    const fromName = candidateFromPath(join(proposed, "from-name.vbrief.json"), root);
    expect(fromName?.storyId).toBe("from-name");
    const ids = allScopeIds(root);
    expect(ids["from-name"]).toBeDefined();
    expect(ids.wid).toBeDefined();
    const a: Candidate = {
      path: "/a",
      storyId: "a",
      status: "proposed",
      swarm: { depends_on: ["ext"] },
      blocked: [],
    };
    candidateDepGraph([a], { ext: ["/p", "running"] });
    expect(a.blocked.length).toBe(1);
    const b: Candidate = {
      path: "/b",
      storyId: "b",
      status: "proposed",
      swarm: { depends_on: ["c"] },
      blocked: [],
    };
    const c: Candidate = {
      path: "/c",
      storyId: "c",
      status: "proposed",
      swarm: { depends_on: ["b"] },
      blocked: [],
    };
    markCycles([b, c], { b: ["c"], c: ["b"] });
    expect(b.blocked.length).toBeGreaterThan(0);
  });

  it("labels report errors and scm client edge cases", () => {
    const report = renderLabelsReport({
      changed: [],
      unchanged: [],
      skipped_no_ref: [],
      errors: [{ story_id: "e", message: "fail" }],
      dry_run: false,
    });
    expect(report).toContain("Errors:");
    expect(
      labelsOutcomeToJson({
        changed: [],
        unchanged: [],
        skipped_no_ref: ["s"],
        errors: [],
        dry_run: true,
      }),
    ).toHaveProperty("skipped_no_ref");

    vi.spyOn(scm, "call")
      .mockReturnValueOnce({ args: [], returncode: 1, stdout: "", stderr: "boom" })
      .mockReturnValueOnce({
        args: [],
        returncode: 0,
        stdout: JSON.stringify({ labels: "bad" }),
        stderr: "",
      })
      .mockReturnValueOnce({
        args: [],
        returncode: 0,
        stdout: JSON.stringify({ labels: ["raw-label"] }),
        stderr: "",
      })
      .mockReturnValueOnce({ args: [], returncode: 1, stdout: "", stderr: "edit fail" });
    const client = new ScmLabelClient();
    expect(() => client.fetchLabels("r", 1)).toThrow(ScmLabelError);
    expect(client.fetchLabels("r", 2)).toEqual([]);
    expect(client.fetchLabels("r", 3)).toEqual(["raw-label"]);
    expect(() => client.apply("r", 4, ["a"], [])).toThrow(ScmLabelError);
  });

  it("labels reconcile metadata.swarm non-object and null data", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lmeta-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "m.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "m",
          status: "running",
          metadata: { kind: "story", swarm: null },
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/7" }],
        },
      })}\n`,
    );
    writeFileSync(join(active, "null.vbrief.json"), "null\n");
    const client = {
      fetchLabels: () => [] as string[],
      apply: () => {},
    };
    const [, outcome] = reconcileLabels(root, { client });
    expect(outcome.unchanged.length).toBe(1);
  });

  it("umbrellas render skipped and invalid json skip", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umb-skip-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "bad.vbrief.json"), "{oops\n");
    writeFileSync(
      join(active, "story.vbrief.json"),
      `${JSON.stringify({ plan: { id: "story", metadata: { kind: "story" } } })}\n`,
    );
    writeFileSync(
      join(active, "noref.vbrief.json"),
      `${JSON.stringify({ plan: { id: "noref", metadata: { kind: "epic" } } })}\n`,
    );
    const client = {
      fetchComments: () => [],
      editComment: () => {},
      createComment: () => 1,
    };
    const [, outcome] = reconcileUmbrellas(root, { client });
    const report = renderUmbrellasReport(outcome);
    expect(report).toContain("Skipped");
    expect(outcome.skipped_no_ref).toContain("noref");
  });

  it("parity scenarios use built-in memory umbrella client", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-parity-mem-"));
    roots.push(root);
    expect(runParityScenario("umbrellas-create-dry-run", { fixtureRoot: root }).ok).toBe(true);
    const root2 = mkdtempSync(join(tmpdir(), "deft-parity-mem2-"));
    roots.push(root2);
    expect(runParityScenario("umbrellas-unchanged", { fixtureRoot: root2 }).ok).toBe(true);
  });

  it("loadFixtureBrief reads json file", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-fix-"));
    roots.push(root);
    const path = join(root, "x.json");
    writeFileSync(path, '{"a":1}\n');
    expect(loadFixtureBrief(path)).toEqual({ a: 1 });
  });

  it("graph promotes for real", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-live-"));
    roots.push(root);
    for (const folder of ["proposed", "pending", "active", "completed"]) {
      mkdirSync(join(root, "vbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "vbrief", "completed", "dep.vbrief.json"),
      formatVbriefJson({
        vBRIEFInfo: { version: "0.5" },
        plan: {
          id: "dep",
          title: "dep",
          status: "completed",
          metadata: { kind: "story", swarm: { depends_on: [] } },
        },
      }),
    );
    writeFileSync(
      join(root, "vbrief", "proposed", "child.vbrief.json"),
      formatVbriefJson({
        vBRIEFInfo: { version: "0.5" },
        plan: {
          id: "child",
          title: "child",
          status: "proposed",
          metadata: { kind: "story", swarm: { depends_on: ["dep"] } },
        },
      }),
    );
    const [code, outcome] = reconcileGraph(root, { dryRun: false });
    expect(code).toBe(0);
    expect(outcome.promoted).toContain("child");
    expect(existsSync(join(root, "vbrief", "pending", "child.vbrief.json"))).toBe(true);
  });

  it("graph records transition failures", async () => {
    const transition = await import("../scope/transition.js");
    vi.spyOn(transition, "runTransition").mockReturnValue({ ok: false, message: "promote failed" });
    const root = mkdtempSync(join(tmpdir(), "deft-graph-err-"));
    roots.push(root);
    for (const folder of ["proposed", "pending", "active", "completed"]) {
      mkdirSync(join(root, "vbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "vbrief", "completed", "dep2.vbrief.json"),
      formatVbriefJson({
        vBRIEFInfo: { version: "0.5" },
        plan: {
          id: "dep2",
          title: "dep2",
          status: "completed",
          metadata: { kind: "story", swarm: { depends_on: [] } },
        },
      }),
    );
    writeFileSync(
      join(root, "vbrief", "proposed", "kid.vbrief.json"),
      formatVbriefJson({
        vBRIEFInfo: { version: "0.5" },
        plan: {
          id: "kid",
          title: "kid",
          status: "proposed",
          metadata: { kind: "story", swarm: { depends_on: ["dep2"] } },
        },
      }),
    );
    const [, outcome] = reconcileGraph(root, { dryRun: false });
    expect(outcome.errors[0]?.story_id).toBe("kid");
  });

  it("main runGraph human report path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-human-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    expect(runGraph({ projectRoot: root, dryRun: true })).toBe(0);
  });

  it("reconciliation conflict markdown with overrides and phases", () => {
    const [items, report] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t9", title: "[wip] Task", number: "", phase: "P1", tier: "T1" }],
      roadmapCompleted: [],
      specVbrief: {
        plan: {
          items: [
            {
              id: "phase-1",
              title: "Phase 1: Foundation",
              subItems: [{ id: "t9", title: "Spec title", status: "pending" }],
            },
          ],
        },
      },
      phaseDescriptions: { P1: "Phase one" },
      overrides: { t9: { status: "running" } },
    });
    expect(items[0]?.phase_description).toBe("Phase one");
    expect(items[0]?.spec_phase).toContain("Phase 1");
    const md = formatReconciliationMarkdown(report, new Date("2026-06-19T12:00:00Z"));
    expect(md).toContain("Overrides applied:");
    expect(md).toContain("TITLE drift");
    expect(hasDisagreement(report)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "deft-rec-wr-"));
    roots.push(root);
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    expect(writeReconciliationReport(report, vbrief, new Date("2026-06-19T12:00:00Z"))).toContain(
      "RECONCILIATION.md",
    );
  });

  it("computeDesiredLabels non-object metadata and research rfc", () => {
    expect(computeDesiredLabels({ status: "running", metadata: null }, false)).toEqual(new Set());
    expect(
      computeDesiredLabels({ status: "running", metadata: { kind: "research" } }, true),
    ).toEqual(new Set(["status:blocked", "rfc"]));
  });

  it("scm umbrella client createComment bad json returns null", () => {
    vi.spyOn(scm, "call").mockReturnValue({
      args: [],
      returncode: 0,
      stdout: "not-json",
      stderr: "",
    });
    expect(new ScmUmbrellaClient().createComment("deftai/directive", 1, "body")).toBeNull();
  });

  it("umbrellas skips non-object plan and metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umb-plan-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "weird.vbrief.json"),
      `${JSON.stringify({
        plan: "not-object",
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/3" }],
      })}\n`,
    );
    const client = {
      fetchComments: () => [],
      editComment: () => {},
      createComment: () => 1,
    };
    const [, outcome] = reconcileUmbrellas(root, { client });
    expect(outcome.changed.length + outcome.unchanged.length).toBe(0);
  });

  it("swarm-deps plan and metadata non-object branches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sd2-"));
    roots.push(root);
    const proposed = join(root, "vbrief", "proposed");
    mkdirSync(proposed, { recursive: true });
    writeFileSync(
      join(proposed, "p.vbrief.json"),
      `${JSON.stringify({ plan: "x", metadata: 1 })}\n`,
    );
    const cand = candidateFromPath(join(proposed, "p.vbrief.json"), root);
    expect(cand?.storyId).toBe("p");
    expect(cand?.swarm).toEqual({});
  });

  it("cli option branches and umbrellas json output", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-opts-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "e.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "ep",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/44" }],
        },
      })}\n`,
    );
    vi.spyOn(scm, "call").mockReturnValue({ args: [], returncode: 0, stdout: "[]", stderr: "" });
    expect(run(["graph", "--project-root", root, "--force", "--dry-run"])).toBe(0);
    expect(run(["umbrellas", "--project-root", root, "--repo", "o/r", "--json", "--dry-run"])).toBe(
      0,
    );
    expect(run(["parity", "--all", "--fixture-root", root])).toBe(0);
  });

  it("scm umbrella client error branches", () => {
    vi.spyOn(scm, "call")
      .mockReturnValueOnce({ args: [], returncode: 1, stdout: "", stderr: "list fail" })
      .mockReturnValueOnce({ args: [], returncode: 0, stdout: "{bad", stderr: "" })
      .mockReturnValueOnce({ args: [], returncode: 0, stdout: "[]", stderr: "" })
      .mockReturnValueOnce({ args: [], returncode: 1, stdout: "", stderr: "edit fail" })
      .mockReturnValueOnce({ args: [], returncode: 1, stdout: "", stderr: "create fail" });
    const client = new ScmUmbrellaClient();
    expect(() => client.fetchComments("r", 1)).toThrow();
    expect(() => client.fetchComments("r", 2)).toThrow();
    client.fetchComments("r", 3);
    expect(() => client.editComment("r", 9, "b")).toThrow();
    expect(() => client.createComment("r", 4, "b")).toThrow();
  });

  it("labels scm non-array labels and filename story id", () => {
    vi.spyOn(scm, "call").mockReturnValue({
      args: [],
      returncode: 0,
      stdout: JSON.stringify({ labels: { bad: true } }),
      stderr: "",
    });
    expect(new ScmLabelClient().fetchLabels("r", 1)).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), "deft-lname-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "from-file.vbrief.json"),
      `${JSON.stringify({
        plan: {
          status: "running",
          metadata: 1,
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/8" }],
        },
      })}\n`,
    );
    const client = { fetchLabels: () => [] as string[], apply: () => {} };
    const [, outcome] = reconcileLabels(root, { client });
    expect(outcome.unchanged[0]?.story_id).toBe("from-file");
  });

  it("graph depResolved and cycle fallback branches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-graph-br-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "proposed", "solo.vbrief.json"),
      formatVbriefJson({
        vBRIEFInfo: { version: "0.5" },
        plan: {
          id: "solo",
          status: "proposed",
          metadata: { kind: "story", swarm: { depends_on: [] } },
        },
      }),
    );
    const [, outcome] = reconcileGraph(root, { dryRun: true });
    expect(outcome.promoted).toEqual([]);
  });

  it("reconciliation yaml task keys and synthetic task ids", () => {
    const yaml =
      "overrides:\n" +
      "  task-a:\n" +
      "    status: completed\n" +
      "  task-b:\n" +
      "    drop: true\n";
    const parsed = parseOverridesYaml(yaml);
    expect(parsed["task-a"]).toEqual({ status: "completed" });
    const [items] = reconcileScopeItems({
      roadmapActive: [{ synthetic_id: "syn-42", title: "Synthetic", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: null,
      overrides: { "syn-42": { body_source: "spec" } },
    });
    expect(items[0]?.task_id).toBe("syn-42");
    expect(items[0]?.description_source).toContain("fallback");
    const [, report] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t1.2.3", title: "Matched", number: "", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: { plan: { items: [{ id: "t1.2.3", title: "Matched", status: "pending" }] } },
    });
    expect(report.conflicts).toEqual([]);
  });

  it("parity shorthand --all first argv", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-all-first-"));
    roots.push(root);
    expect(run(["--all", "--fixture-root", root])).toBe(0);
  });

  it("umbrella scm parses comment entries", () => {
    vi.spyOn(scm, "call").mockReturnValue({
      args: [],
      returncode: 0,
      stdout: JSON.stringify([
        { id: 1, body: "## Current shape (as of pass-1)\n" },
        { id: "bad", body: 1 },
      ]),
      stderr: "",
    });
    const comments = new ScmUmbrellaClient().fetchComments("deftai/directive", 9);
    expect(comments).toEqual([{ id: 1, body: "## Current shape (as of pass-1)\n" }]);
  });

  it("reconciliation marker and narrative branches", () => {
    expect(detectStatusMarker("[cancelled] task")).toBe("cancelled");
    const [items] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t-no-match", title: "No spec", number: "", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: { plan: { items: [{ id: "other", title: "Other", status: "pending" }] } },
    });
    expect(items[0]?.description).toBe("No spec");
    const [withBody] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t1", title: "RM", number: "", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: {
        plan: {
          items: [
            { id: "t1", title: "", status: "pending", narrative: { Summary: "From summary" } },
          ],
        },
      },
    });
    expect(withBody[0]?.description).toBe("From summary");
  });

  it("umbrellas readJson null and computeChildren without refs", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umb-json-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "arr.vbrief.json"), "[]\n");
    expect(buildChildIndex(join(root, "vbrief"))).toEqual({});
    expect(computeChildren({ plan: { references: "nope" } }, {})).toEqual([]);
    expect(childFromData({ plan: { id: "c" } }, "active", "fb").folder).toBe("active");
  });

  it("runUmbrellas json stdout with epic fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umb-json-out-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "ep.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "ep",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/77" }],
        },
      })}\n`,
    );
    vi.spyOn(scm, "call").mockReturnValue({ args: [], returncode: 0, stdout: "[]", stderr: "" });
    expect(runUmbrellas({ projectRoot: root, json: true, dryRun: true })).toBe(0);
  });
});
