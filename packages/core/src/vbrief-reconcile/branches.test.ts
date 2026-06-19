import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as graphMod from "./graph.js";
import * as labelsMod from "./labels.js";
import { cmdVbriefReconcile, run, runGraph, runLabels, runUmbrellas, usage } from "./main.js";
import { runParityScenario } from "./parity-scenarios.js";
import {
  detectStatusMarker,
  folderFromStatus,
  loadOverrides,
  parseOverridesYaml,
  reconcileScopeItems,
} from "./reconciliation.js";
import { asStrList, candidateFromPath } from "./swarm-deps.js";
import type { LabelClient, UmbrellaClient } from "./types.js";
import { classifyPassType, parseCurrentShape, reconcileUmbrellas } from "./umbrellas.js";

describe("branch coverage boost", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("detectStatusMarker wip/blocked/cancelled", () => {
    expect(detectStatusMarker("[wip] task")).toBe("running");
    expect(detectStatusMarker("[blocked]")).toBe("blocked");
    expect(detectStatusMarker("[cancelled]")).toBe("cancelled");
  });

  it("folderFromStatus unknown defaults pending", () => {
    expect(folderFromStatus("unknown")).toBe("pending");
  });

  it("parseOverridesYaml ignores non-overrides top level", () => {
    expect(parseOverridesYaml("other:\n  x: 1\n")).toEqual({});
  });

  it("reconcile with override status and spec body override", () => {
    const [items] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t1", title: "T", number: "", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: { plan: { items: [{ id: "t1", title: "T", status: "pending" }] } },
      overrides: { t1: { status: "completed", body_source: "spec" } },
    });
    expect(items[0]?.status).toBe("completed");
  });

  it("reconcile roadmap-only title", () => {
    const [items] = reconcileScopeItems({
      roadmapActive: [{ number: "42", title: "Only RM", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: null,
    });
    expect(items[0]?.title_source).toBe("");
  });

  it("loadOverrides missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-br-"));
    roots.push(root);
    expect(loadOverrides(join(root, "vbrief"))).toEqual({});
  });

  it("candidateFromPath invalid json", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cand-"));
    roots.push(root);
    const dir = join(root, "vbrief", "proposed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.vbrief.json"), "{bad\n");
    expect(candidateFromPath(join(dir, "bad.vbrief.json"), root)).toBeNull();
  });

  it("asStrList non-array", () => {
    expect(asStrList(null)).toEqual([]);
  });

  it("classifyPassType subtractive and refactor", () => {
    expect(classifyPassType(3, 2)).toBe("subtractive");
    expect(classifyPassType(2, 2)).toBe("refactor");
  });

  it("parseCurrentShape partial fields", () => {
    const parsed = parseCurrentShape("## Current shape (as of pass-1)\n");
    expect(parsed.passN).toBe(1);
    expect(parsed.history).toEqual([]);
  });

  it("labels fetch error increments errors", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lerr-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "x.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "x",
          metadata: { kind: "story", swarm: { depends_on: [] } },
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
        },
      })}\n`,
    );
    const client: LabelClient = {
      fetchLabels: () => {
        throw new labelsMod.ScmLabelError("fetch fail");
      },
      apply: () => {},
    };
    const [code, outcome] = labelsMod.reconcileLabels(root, { client });
    expect(code).toBe(1);
    expect(outcome.errors.length).toBe(1);
  });

  it("umbrellas skips duplicate issue key", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-udup-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    const ref = [
      { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/55" },
    ];
    for (const id of ["e1", "e2"]) {
      writeFileSync(
        join(active, `${id}.vbrief.json`),
        `${JSON.stringify({ plan: { id, metadata: { kind: "epic", swarm: { depends_on: [] } }, references: ref } })}\n`,
      );
    }
    const client: UmbrellaClient = {
      fetchComments: () => [],
      editComment: () => {},
      createComment: () => 1,
    };
    const [, outcome] = reconcileUmbrellas(root, { client, now: "2026-06-14T20:00:00Z" });
    expect(outcome.changed.length).toBe(1);
  });

  it("run throws on unknown scenario", () => {
    expect(() => runParityScenario("nope", { fixtureRoot: "/tmp" })).toThrow();
  });

  it("cmd catches run errors", () => {
    vi.spyOn(graphMod, "reconcileGraph").mockImplementation(() => {
      throw new Error("boom");
    });
    const root = mkdtempSync(join(tmpdir(), "deft-cmd-err-"));
    roots.push(root);
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    expect(cmdVbriefReconcile(["graph", "--project-root", root])).toBe(2);
  });

  it("run handles bad parity args", () => {
    expect(run(["parity"])).toBe(2);
    expect(() => run(["parity", "--scenario", "nope"])).toThrow();
    usage();
  });

  it("main json error paths", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-main-json-err-"));
    roots.push(root);
    expect(runGraph({ projectRoot: root, json: true })).toBe(2);
    expect(runLabels({ projectRoot: root, json: true })).toBe(2);
    expect(runUmbrellas({ projectRoot: root })).toBe(2);
  });

  it("umbrellas client error and skipped render", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-umb-err-"));
    roots.push(root);
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "no-ref.vbrief.json"),
      `${JSON.stringify({ plan: { id: "nr", metadata: { kind: "epic", swarm: { depends_on: [] } } } })}\n`,
    );
    writeFileSync(
      join(active, "boom.vbrief.json"),
      `${JSON.stringify({
        plan: {
          id: "boom",
          metadata: { kind: "epic", swarm: { depends_on: [] } },
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/9" }],
        },
      })}\n`,
    );
    const client: UmbrellaClient = {
      fetchComments: () => {
        throw new labelsMod.ScmLabelError("comments fail");
      },
      editComment: () => {},
      createComment: () => 1,
    };
    const [code, outcome] = reconcileUmbrellas(root, { client });
    expect(code).toBe(1);
    expect(outcome.skipped_no_ref).toContain("nr");
    const report = graphMod.renderGraphReport({
      promoted: [],
      deferredWip: [],
      waiting: [],
      cycles: [],
      errors: [],
      cap: 0,
      count: 0,
      dryRun: false,
      forced: false,
    });
    expect(report).toContain("- none");
  });

  it("parseCommon parity shorthand", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-parity-shorthand-"));
    roots.push(root);
    expect(run(["--scenario", "reconcile-overrides", "--fixture-root", root])).toBe(0);
  });
});
