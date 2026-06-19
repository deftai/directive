import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as scm from "../scm/call.js";
import {
  computeDesiredLabels,
  MANAGED_LABELS,
  reconcileLabels,
  renderLabelsReport,
  ScmLabelClient,
  ScmLabelError,
} from "./labels.js";
import { cmdVbriefReconcile, runGraph, runLabels, runParityMode, runUmbrellas } from "./main.js";
import { PARITY_SCENARIO_NAMES, runParityScenario } from "./parity-scenarios.js";
import { loadOverrides, parseOverridesYaml, reconcileScopeItems } from "./reconciliation.js";
import type { LabelClient, UmbrellaClient } from "./types.js";
import {
  buildChildIndex,
  childFromData,
  computeChildren,
  parseCurrentShape,
  reconcileUmbrellas,
  renderBody,
  renderUmbrellasReport,
  ScmUmbrellaClient,
  UmbrellaScmError,
} from "./umbrellas.js";

class FakeLabelClient implements LabelClient {
  labels = new Map<string, string[]>();
  fetchLabels(repo: string, n: number): string[] {
    return [...(this.labels.get(`${repo}:${n}`) ?? [])];
  }
  apply(repo: string, n: number, add: readonly string[], remove: readonly string[]): void {
    const key = `${repo}:${n}`;
    const cur = new Set(this.labels.get(key) ?? []);
    for (const a of add) cur.add(a);
    for (const r of remove) cur.delete(r);
    this.labels.set(key, [...cur].sort());
  }
}

class FakeUmbrellaClient implements UmbrellaClient {
  comments = new Map<string, Array<{ id: number; body: string }>>();
  private nextId = 1000;
  fetchComments(repo: string, n: number) {
    return [...(this.comments.get(`${repo}:${n}`) ?? [])];
  }
  editComment(_repo: string, id: number, body: string): void {
    for (const bucket of this.comments.values()) {
      for (const c of bucket) if (c.id === id) c.body = body;
    }
  }
  createComment(repo: string, n: number, body: string): number {
    const key = `${repo}:${n}`;
    const id = this.nextId++;
    const bucket = this.comments.get(key) ?? [];
    bucket.push({ id, body });
    this.comments.set(key, bucket);
    return id;
  }
}

describe("main CLI runners", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("runGraph missing proposed exits 2", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-graph-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief"), { recursive: true });
    expect(runGraph({ projectRoot: root })).toBe(2);
  });

  it("runLabels missing vbrief exits 2", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-labels-"));
    roots.push(root);
    expect(runLabels({ projectRoot: root })).toBe(2);
  });

  it("runUmbrellas missing vbrief exits 2", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-umbrellas-"));
    roots.push(root);
    expect(runUmbrellas({ projectRoot: root })).toBe(2);
  });

  it("runParityMode emits json", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-parity-"));
    roots.push(root);
    const code = runParityMode({ scenario: "reconcile-overrides", fixtureRoot: root });
    expect(code).toBe(0);
  });

  it("cmd handles labels and umbrellas human output", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-labels-umb-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "s.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "s",
          status: "running",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/99" },
          ],
        },
      })}\n`,
    );
    vi.spyOn(scm, "call").mockReturnValue({
      args: [],
      returncode: 0,
      stdout: JSON.stringify({ labels: [] }),
      stderr: "",
    });
    expect(cmdVbriefReconcile(["labels", "--project-root", root, "--dry-run"])).toBe(0);
    vi.spyOn(scm, "call").mockReturnValue({ args: [], returncode: 0, stdout: "[]", stderr: "" });
    writeFileSync(
      join(active, "e.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "e",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/100",
            },
          ],
        },
      })}\n`,
    );
    expect(cmdVbriefReconcile(["umbrellas", "--project-root", root, "--dry-run", "--json"])).toBe(
      0,
    );
  });

  it("runParityMode --all", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-all-"));
    roots.push(root);
    expect(runParityMode({ all: true, fixtureRoot: root })).toBe(0);
  });
});

describe("parity scenarios exhaustive", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  for (const name of PARITY_SCENARIO_NAMES) {
    it(`runs ${name}`, () => {
      const root = mkdtempSync(join(tmpdir(), `deft-parity-${name}-`));
      roots.push(root);
      const needsClient = name.startsWith("labels-") || name.startsWith("umbrellas-");
      const result = runParityScenario(name, {
        fixtureRoot: root,
        labelClient: needsClient ? new FakeLabelClient() : undefined,
        umbrellaClient: needsClient ? new FakeUmbrellaClient() : undefined,
      });
      expect(result.ok).toBe(true);
    });
  }
});

describe("reconciliation branches", () => {
  it("override drop and unused keys", () => {
    const [, report] = reconcileScopeItems({
      roadmapActive: [
        { task_id: "t1", title: "One", number: "", phase: "P1" },
        { number: "9", title: "Drop me", phase: "P1", synthetic_id: "roadmap-9" },
      ],
      roadmapCompleted: [],
      specVbrief: { plan: { items: [{ id: "t1", title: "One", status: "pending" }] } },
      overrides: { "roadmap-9": { drop: true }, unused: { status: "pending" } },
    });
    expect(report.overridesTriggered.some((o) => o.action === "dropped from migration")).toBe(true);
    expect(report.overridesUnused).toContain("unused");
  });

  it("loadOverrides reads file", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ovr-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "migration-overrides.yaml"),
      "overrides:\n  t1:\n    status: completed\n",
    );
    expect(loadOverrides(vbrief)).toEqual({ t1: { status: "completed" } });
    rmSync(root, { recursive: true, force: true });
  });

  it("title and status conflicts logged", () => {
    const [items, report] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t5", title: "Road title", number: "", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: {
        plan: {
          items: [
            {
              id: "t5",
              title: "Spec title",
              status: "running",
              narrative: { Description: "body" },
            },
          ],
        },
      },
    });
    expect(items[0]?.title).toBe("Spec title");
    expect(report.conflicts.length).toBeGreaterThan(0);
  });

  it("completed orphan routes to completed", () => {
    const [items] = reconcileScopeItems({
      roadmapActive: [],
      roadmapCompleted: [{ number: "9", title: "Done orphan", phase: "Completed" }],
      specVbrief: { plan: { items: [{ id: "t1", title: "One", status: "pending" }] } },
    });
    expect(items[0]?.folder).toBe("completed");
  });

  it("body_source override roadmap", () => {
    const [items] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t1", title: "RM", number: "", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: {
        plan: {
          items: [{ id: "t1", title: "Spec", status: "pending", narrative: { Description: "d" } }],
        },
      },
      overrides: { t1: { body_source: "roadmap" } },
    });
    expect(items[0]?.description_source).toContain("override");
  });
});

describe("labels SCM client", () => {
  it("fetch and apply via scm.call", () => {
    vi.spyOn(scm, "call")
      .mockReturnValueOnce({
        args: [],
        returncode: 0,
        stdout: JSON.stringify({ labels: [{ name: "bug" }, { name: "epic" }] }),
        stderr: "",
      })
      .mockReturnValueOnce({ args: [], returncode: 0, stdout: "", stderr: "" });
    const client = new ScmLabelClient();
    expect(client.fetchLabels("deftai/directive", 1)).toEqual(["bug", "epic"]);
    client.apply("deftai/directive", 1, ["rfc"], ["epic"]);
  });

  it("labels unchanged and errors", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-br-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "ok.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "ok",
          status: "running",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/20" },
          ],
        },
      })}\n`,
    );
    writeFileSync(join(active, "bad.vbrief.json"), "not-json\n");
    writeFileSync(
      join(active, "noref.vbrief.json"),
      `${JSON.stringify({ plan: { id: "noref", metadata: { kind: "story", swarm: { depends_on: [] } } } })}\n`,
    );
    const client = new FakeLabelClient();
    client.labels.set("deftai/directive:20", []);
    const [code, outcome] = reconcileLabels(root, { client });
    expect(code).toBe(0);
    expect(outcome.unchanged.length).toBe(1);
    expect(outcome.skipped_no_ref).toContain("noref");
    rmSync(root, { recursive: true, force: true });
  });

  it("labels apply error path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-labels-err-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "e.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "e",
          status: "blocked",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/30" },
          ],
        },
      })}\n`,
    );
    const client: LabelClient = {
      fetchLabels: () => [],
      apply: () => {
        throw new ScmLabelError("apply failed");
      },
    };
    const [code, outcome] = reconcileLabels(root, { client });
    expect(code).toBe(1);
    expect(outcome.errors.length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("scm label client bad json", () => {
    vi.spyOn(scm, "call").mockReturnValue({
      args: [],
      returncode: 0,
      stdout: "not-json",
      stderr: "",
    });
    expect(() => new ScmLabelClient().fetchLabels("r", 1)).toThrow(ScmLabelError);
  });

  it("computeDesiredLabels branches", () => {
    expect(
      computeDesiredLabels({ status: "running", metadata: { kind: "research" } }, true),
    ).toEqual(new Set(["status:blocked", "rfc"]));
    expect(
      renderLabelsReport({
        changed: [],
        unchanged: [],
        skipped_no_ref: ["x"],
        errors: [],
        dry_run: true,
      }),
    ).toContain("Skipped");
    expect(MANAGED_LABELS).toContain("status:blocked");
  });
});

describe("umbrellas SCM client", () => {
  it("fetch edit create via scm", () => {
    vi.spyOn(scm, "call")
      .mockReturnValueOnce({ args: [], returncode: 0, stdout: "[]", stderr: "" })
      .mockReturnValueOnce({
        args: [],
        returncode: 0,
        stdout: JSON.stringify({ id: 42 }),
        stderr: "",
      });
    const client = new ScmUmbrellaClient();
    expect(client.fetchComments("deftai/directive", 1)).toEqual([]);
    expect(client.createComment("deftai/directive", 1, "body")).toBe(42);
    vi.spyOn(scm, "call").mockReturnValue({ args: [], returncode: 0, stdout: "", stderr: "" });
    client.editComment("deftai/directive", 1, "new");
  });

  it("umbrella edit when body changes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umb-edit-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    const existingBody = renderBody({
      passN: 1,
      lastPassType: "additive",
      lastUpdated: "2026-06-14T20:00:00Z",
      openChildren: [],
      closedChildren: [],
      waves: [],
      history: [[1, 0]],
    });
    const client = new FakeUmbrellaClient();
    client.comments.set("deftai/directive:200", [{ id: 5, body: existingBody }]);
    writeFileSync(
      join(active, "c.vbrief.json"),
      `${JSON.stringify({ plan: { id: "c1", metadata: { kind: "story", swarm: { depends_on: [] } } } })}\n`,
    );
    writeFileSync(
      join(active, "e.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "ep",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [
            { type: "x-vbrief/plan", uri: "active/c.vbrief.json" },
            {
              type: "x-vbrief/github-issue",
              uri: "https://github.com/deftai/directive/issues/200",
            },
          ],
        },
      })}\n`,
    );
    const [code, outcome] = reconcileUmbrellas(root, { client, now: "2026-06-14T20:00:00Z" });
    expect(code).toBe(0);
    expect(outcome.changed[0]?.action).toBe("edited");
    rmSync(root, { recursive: true, force: true });
  });

  it("scm umbrella bad json on list", () => {
    vi.spyOn(scm, "call").mockReturnValue({ args: [], returncode: 0, stdout: "{bad", stderr: "" });
    expect(() => new ScmUmbrellaClient().fetchComments("r", 1)).toThrow(UmbrellaScmError);
  });

  it("child index and render branches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umb-idx-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "c.vbrief.json"),
      `${JSON.stringify({ plan: { id: "c", metadata: { kind: "story", swarm: { depends_on: ["x"] } } } })}\n`,
    );
    const index = buildChildIndex(join(root, "vbrief"));
    expect(childFromData({ plan: { id: "z" } }, "active", "z").story_id).toBe("z");
    expect(
      computeChildren(
        { plan: { references: [{ type: "x-vbrief/plan", uri: "active/c.vbrief.json" }] } },
        index,
      ).length,
    ).toBe(1);
    expect(
      parseCurrentShape(
        "## Current shape (as of pass-2)\nLast updated: t\nLast pass type: verify\nChild-count history: pass-1: 1, pass-2: 2",
      ).history,
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(
      renderUmbrellasReport({
        changed: [],
        unchanged: [],
        skipped_no_ref: [],
        errors: [{ story_id: "e", message: "m" }],
        dry_run: false,
      }),
    ).toContain("Errors");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("parseOverridesYaml edge cases", () => {
  it("coerces booleans and null", () => {
    const yaml = "overrides:\n  a:\n    drop: false\n  b:\n    drop: yes\n  c:\n    status: null\n";
    expect(parseOverridesYaml(yaml)).toEqual({
      a: { drop: false },
      b: { drop: true },
      c: { status: null },
    });
  });
});
