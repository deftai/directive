import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDrift,
  generateRoadmapContent,
  renderRoadmap,
  renderRoadmapToBuffer,
  main as roadmapRenderMain,
} from "./roadmap-render.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): { pending: string; completed: string; outPath: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-roadmap-idem-"));
  temps.push(root);
  const pending = join(root, "vbrief", "pending");
  const completed = join(root, "vbrief", "completed");
  mkdirSync(pending, { recursive: true });
  mkdirSync(completed, { recursive: true });
  return { pending, completed, outPath: join(root, "ROADMAP.md") };
}

function writeVbrief(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(data), "utf8");
}

/** Scope with multiple GitHub issue references (flat phase-grouped model). */
const MULTI_REF_SCOPE_A = {
  vBRIEFInfo: { version: "0.6" },
  plan: {
    title: "Feature Work",
    status: "pending",
    metadata: { "x-migrator": { Phase: "Phase 1", PhaseDescription: "Foundation" } },
    references: [
      { uri: "https://github.com/deftai/directive/issues/311", type: "x-vbrief/github-issue" },
      { uri: "https://github.com/deftai/directive/issues/309", type: "x-vbrief/github-issue" },
    ],
  },
};

const MULTI_REF_SCOPE_B = {
  vBRIEFInfo: { version: "0.6" },
  plan: {
    title: "Second Scope",
    status: "running",
    metadata: { "x-migrator": { Phase: "Phase 2" } },
    references: [
      { id: "#100", type: "github-issue" },
      { id: "#101", type: "github-issue" },
      { url: "https://github.com/deftai/directive/issues/102" },
    ],
  },
};

/** Hierarchical scope listing multiple issue numbers in references[]. */
const HIERARCHICAL_MULTI_REF = {
  vBRIEFInfo: { version: "0.6" },
  plan: {
    title: "Dependency Test",
    status: "pending",
    references: [{ id: "#311" }, { url: "https://github.com/deftai/directive/issues/309" }],
    items: [
      {
        id: "phase-1",
        title: "Phase 1",
        status: "pending",
        subItems: [{ id: "task-a", title: "Task A", status: "pending" }],
      },
    ],
  },
};

describe("roadmap-render idempotency", () => {
  it("render then check exits 0 for flat scopes with multi-issue references[]", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.vbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(pending, "2026-02-01-b.vbrief.json", MULTI_REF_SCOPE_B);

    const [renderOk, renderMsg] = renderRoadmap(pending, outPath);
    expect(renderOk).toBe(true);
    expect(renderMsg).toContain("Rendered ROADMAP.md");

    const [checkOk, checkMsg] = checkDrift(pending, outPath);
    expect(checkOk).toBe(true);
    expect(checkMsg).toContain("up to date");
  });

  it("render then check exits 0 for hierarchical scopes with multi-issue references[]", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-deps.vbrief.json", HIERARCHICAL_MULTI_REF);

    const [renderOk] = renderRoadmap(pending, outPath);
    expect(renderOk).toBe(true);

    const [checkOk, checkMsg] = checkDrift(pending, outPath);
    expect(checkOk).toBe(true);
    expect(checkMsg).toContain("up to date");

    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("## Dependency Test");
    expect(content).toContain("#311");
    expect(content).toContain("#309");
  });

  it("--check compares on-disk bytes against renderRoadmapToBuffer output", () => {
    const { pending, completed, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.vbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(pending, "2026-02-01-b.vbrief.json", MULTI_REF_SCOPE_B);

    renderRoadmap(pending, outPath, completed);

    const onDisk = readFileSync(outPath, "utf8");
    const buffer = renderRoadmapToBuffer(pending, completed);
    expect(onDisk).toBe(buffer);

    const [checkOk] = checkDrift(pending, outPath, completed);
    expect(checkOk).toBe(true);
  });

  it("main CLI render then --check exits 0 with multi-issue references[]", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.vbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(pending, "2026-02-01-b.vbrief.json", MULTI_REF_SCOPE_B);

    expect(roadmapRenderMain([pending, outPath])).toBe(0);
    expect(roadmapRenderMain(["--check", pending, outPath])).toBe(0);
  });

  it("checkDrift detects stale ROADMAP.md content", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.vbrief.json", MULTI_REF_SCOPE_A);
    writeFileSync(outPath, "stale content\n", "utf8");
    const [ok, msg] = checkDrift(pending, outPath);
    expect(ok).toBe(false);
    expect(msg).toContain("drifted");
  });

  it("checkDrift accepts missing ROADMAP when no vBRIEFs exist", () => {
    const { pending, outPath } = makeFixture();
    const [ok, msg] = checkDrift(pending, outPath);
    expect(ok).toBe(true);
    expect(msg).toContain("No ROADMAP.md needed");
  });

  it("checkDrift rejects missing ROADMAP when pending vBRIEFs exist", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.vbrief.json", MULTI_REF_SCOPE_A);
    const [ok, msg] = checkDrift(pending, outPath);
    expect(ok).toBe(false);
    expect(msg).toContain("does not exist");
  });

  it("checkDrift rejects missing ROADMAP when only completed vBRIEFs exist", () => {
    const { pending, completed, outPath } = makeFixture();
    writeVbrief(completed, "2026-01-01-done.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Done scope",
        status: "completed",
        references: [{ id: "#50" }, { id: "#51" }],
      },
    });
    const [ok, msg] = checkDrift(pending, outPath);
    expect(ok).toBe(false);
    expect(msg).toContain("does not exist");
  });

  it("renderRoadmap returns false when output path is not writable", () => {
    const { pending } = makeFixture();
    const [ok, msg] = renderRoadmap(pending, "/nonexistent/subdir/ROADMAP.md");
    expect(ok).toBe(false);
    expect(msg).toContain("Failed");
  });

  it("generateRoadmapContent alias matches renderRoadmapToBuffer", () => {
    const { pending, completed } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.vbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(completed, "2026-01-01-done.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "Done", status: "completed", references: [{ id: "#99" }] },
    });
    expect(generateRoadmapContent(pending, completed)).toBe(
      renderRoadmapToBuffer(pending, completed),
    );
  });

  it("renders dependency ordering and completed section", () => {
    const { pending, completed, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-deps.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Dependency Test",
        status: "pending",
        edges: [{ from: "task-a", to: "task-b" }],
        items: [
          {
            id: "phase-1",
            title: "Phase 1",
            status: "pending",
            subItems: [
              { id: "task-b", title: "Task B", status: "pending" },
              { id: "task-a", title: "Task A", status: "pending" },
            ],
          },
        ],
      },
    });
    writeVbrief(completed, "2026-01-01-done.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Completed item",
        status: "completed",
        references: [{ id: "#50" }, { id: "#51" }],
      },
    });
    renderRoadmap(pending, outPath, completed);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("(depends on: task-a)");
    expect(content.indexOf("Task A")).toBeLessThan(content.indexOf("Task B"));
    expect(content).toContain("## Completed");
    expect(content).toContain("#50");
    expect(checkDrift(pending, outPath, completed)[0]).toBe(true);
  });

  it("main --check returns 1 when ROADMAP has drifted", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.vbrief.json", MULTI_REF_SCOPE_A);
    writeFileSync(outPath, "stale\n", "utf8");
    expect(roadmapRenderMain(["--check", pending, outPath])).toBe(1);
  });

  it("groups legacy narrative Phase labels and tier subgroups", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-tiered.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Tiered scope",
        status: "pending",
        narratives: { Phase: "Phase 1 -- Foundation", Tier: "Tier 1 -- Core" },
        references: [{ id: "#10" }, { uri: "https://github.com/o/r/issues/11" }],
      },
    });
    writeVbrief(pending, "2026-02-01-untiered.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Untiered scope",
        status: "pending",
        narratives: { Phase: "Phase 1 -- Foundation" },
        references: [{ url: "https://github.com/o/r/issues/12" }],
      },
    });
    writeFileSync(join(pending, "bad.vbrief.json"), "{not json", "utf8");
    renderRoadmap(pending, outPath);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("### Tier 1 -- Core");
    expect(content).toContain("Untiered scope");
    expect(content).toContain("**#10**");
    expect(checkDrift(pending, outPath)[0]).toBe(true);
  });

  it("orders ranked scopes and renders phase narratives", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-06-04-a.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Alpha",
        status: "pending",
        metadata: { rank: 3 },
        references: [{ id: "#1" }],
        items: [
          {
            id: "p1",
            title: "Phase",
            status: "running",
            narrative: { Description: "Phase narrative body", Acceptance: "hidden" },
          },
        ],
      },
    });
    writeVbrief(pending, "2026-06-04-b.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Bravo",
        status: "pending",
        metadata: { rank: 1 },
        references: [{ id: "#2" }],
        items: [],
      },
    });
    renderRoadmap(pending, outPath);
    const content = readFileSync(outPath, "utf8");
    expect(content.indexOf("Bravo")).toBeLessThan(content.indexOf("Alpha"));
    expect(content).toContain("Phase narrative body");
    expect(content).not.toContain("hidden");
    expect(checkDrift(pending, outPath)[0]).toBe(true);
  });

  it("covers rank parsing and numeric phase ordering branches", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-04-15-a-phase6.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Widget 6",
        status: "pending",
        metadata: { "x-migrator": { Phase: "Phase 6" }, rank: "-5" },
        references: [{ id: "#600" }],
      },
    });
    writeVbrief(pending, "2026-04-15-b-phase1.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Widget 1",
        status: "pending",
        metadata: { "x-migrator": { Phase: "Phase 1" }, rank: true },
        references: [{ id: "#100" }],
      },
    });
    renderRoadmap(pending, outPath);
    const content = readFileSync(outPath, "utf8");
    expect(content.indexOf("## Phase 1")).toBeLessThan(content.indexOf("## Phase 6"));
    expect(checkDrift(pending, outPath)[0]).toBe(true);
  });

  it("renders legacy source/target edges and phase headings without ids", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-04-15-c-hier.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Legacy edges",
        status: "pending",
        edges: [
          { source: "task-a", target: "task-b" },
          { from: "task-a", to: "task-c", source: "ignored", target: "ignored" },
        ],
        items: [
          {
            title: "Untitled Phase",
            status: "pending",
            subItems: [
              { id: "task-b", title: "Task B", status: "pending" },
              { id: "task-c", title: "Task C", status: "pending" },
              { id: "task-a", title: "Task A", status: "pending" },
            ],
          },
        ],
      },
    });
    renderRoadmap(pending, outPath);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("### Untitled Phase");
    expect(content).toContain("(depends on: task-a)");
    expect(checkDrift(pending, outPath)[0]).toBe(true);
  });
});
