import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDrift,
  generateRoadmapContent,
  renderRoadmap,
  renderRoadmapToBuffer,
  renderRoadmapToBufferResult,
  main as roadmapRenderMain,
} from "./roadmap-render.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectRoadmapBuffer(pendingDir: string, completedDir?: string): string {
  const [ok, value] = renderRoadmapToBufferResult(pendingDir, completedDir);
  expect(ok).toBe(true);
  return value;
}

function makeFixture(): {
  root: string;
  pending: string;
  proposed: string;
  active: string;
  completed: string;
  outPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "deft-roadmap-idem-"));
  temps.push(root);
  const pending = join(root, "xbrief", "pending");
  const proposed = join(root, "xbrief", "proposed");
  const active = join(root, "xbrief", "active");
  const completed = join(root, "xbrief", "completed");
  mkdirSync(pending, { recursive: true });
  mkdirSync(proposed, { recursive: true });
  mkdirSync(active, { recursive: true });
  mkdirSync(completed, { recursive: true });
  return { root, pending, proposed, active, completed, outPath: join(root, "ROADMAP.md") };
}

function writeVbrief(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(data), "utf8");
}

/** Scope with multiple GitHub issue references (flat phase-grouped model). */
const MULTI_REF_SCOPE_A = {
  xBRIEFInfo: { version: "0.8" },
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
  xBRIEFInfo: { version: "0.8" },
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
  xBRIEFInfo: { version: "0.8" },
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
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(pending, "2026-02-01-b.xbrief.json", MULTI_REF_SCOPE_B);

    const [renderOk, renderMsg] = renderRoadmap(pending, outPath);
    expect(renderOk).toBe(true);
    expect(renderMsg).toContain("Rendered ROADMAP.md");

    const [checkOk, checkMsg] = checkDrift(pending, outPath);
    expect(checkOk).toBe(true);
    expect(checkMsg).toContain("up to date");
  });

  it("render then check exits 0 for hierarchical scopes with multi-issue references[]", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-deps.xbrief.json", HIERARCHICAL_MULTI_REF);

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
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(pending, "2026-02-01-b.xbrief.json", MULTI_REF_SCOPE_B);

    renderRoadmap(pending, outPath, completed);

    const onDisk = readFileSync(outPath, "utf8");
    const buffer = expectRoadmapBuffer(pending, completed);
    expect(onDisk).toBe(buffer);

    const [checkOk] = checkDrift(pending, outPath, completed);
    expect(checkOk).toBe(true);
  });

  it("main CLI render then --check exits 0 with multi-issue references[]", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(pending, "2026-02-01-b.xbrief.json", MULTI_REF_SCOPE_B);

    expect(roadmapRenderMain([pending, outPath])).toBe(0);
    expect(roadmapRenderMain(["--check", pending, outPath])).toBe(0);
  });

  it("checkDrift detects stale ROADMAP.md content", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
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
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    const [ok, msg] = checkDrift(pending, outPath);
    expect(ok).toBe(false);
    expect(msg).toContain("does not exist");
  });

  it("checkDrift rejects missing ROADMAP when only completed vBRIEFs exist", () => {
    const { pending, completed, outPath } = makeFixture();
    writeVbrief(completed, "2026-01-01-done.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
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
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    writeVbrief(completed, "2026-01-01-done.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Done", status: "completed", references: [{ id: "#99" }] },
    });
    expect(generateRoadmapContent(pending, completed)).toEqual(
      renderRoadmapToBuffer(pending, completed),
    );
  });

  it("renders dependency ordering and completed section", () => {
    const { pending, completed, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-deps.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
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
    writeVbrief(completed, "2026-01-01-done.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
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
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    writeFileSync(outPath, "stale\n", "utf8");
    expect(roadmapRenderMain(["--check", pending, outPath])).toBe(1);
  });

  it("groups legacy narrative Phase labels and tier subgroups", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-01-01-tiered.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Tiered scope",
        status: "pending",
        narratives: { Phase: "Phase 1 -- Foundation", Tier: "Tier 1 -- Core" },
        references: [{ id: "#10" }, { uri: "https://github.com/o/r/issues/11" }],
      },
    });
    writeVbrief(pending, "2026-02-01-untiered.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Untiered scope",
        status: "pending",
        narratives: { Phase: "Phase 1 -- Foundation" },
        references: [{ url: "https://github.com/o/r/issues/12" }],
      },
    });
    writeFileSync(join(pending, "bad.xbrief.json"), "{not json", "utf8");
    renderRoadmap(pending, outPath);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("### Tier 1 -- Core");
    expect(content).toContain("Untiered scope");
    expect(content).toContain("**#10**");
    expect(checkDrift(pending, outPath)[0]).toBe(true);
  });

  it("orders ranked scopes and renders phase narratives", () => {
    const { pending, outPath } = makeFixture();
    writeVbrief(pending, "2026-06-04-a.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
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
    writeVbrief(pending, "2026-06-04-b.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
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
    writeVbrief(pending, "2026-04-15-a-phase6.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Widget 6",
        status: "pending",
        metadata: { "x-migrator": { Phase: "Phase 6" }, rank: "-5" },
        references: [{ id: "#600" }],
      },
    });
    writeVbrief(pending, "2026-04-15-b-phase1.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
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
    writeVbrief(pending, "2026-04-15-c-hier.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
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

describe("roadmap-render forward projection (#2653)", () => {
  it("empty pending + non-empty proposed is not Completed-only", () => {
    const { pending, proposed, completed, outPath } = makeFixture();
    writeVbrief(proposed, "2026-07-01-100-forward.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Proposed forward work",
        status: "proposed",
        references: [{ id: "#100" }],
      },
    });
    writeVbrief(completed, "2026-01-01-done.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Already shipped",
        status: "completed",
        references: [{ id: "#50" }],
      },
    });

    const content = expectRoadmapBuffer(pending, completed);
    expect(content).toContain("## Proposed");
    expect(content).toContain("Proposed forward work");
    expect(content).toContain("## Completed");
    expect(content).toContain("Already shipped");
    // Must not be Completed-only: Proposed appears before Completed
    expect(content.indexOf("## Proposed")).toBeLessThan(content.indexOf("## Completed"));
    expect(content).not.toMatch(/^# Roadmap\s+## Completed/m);

    renderRoadmap(pending, outPath, completed);
    expect(checkDrift(pending, outPath, completed)[0]).toBe(true);
  });

  it("empty forward + completed emits explicit empty-forward marker", () => {
    const { pending, completed } = makeFixture();
    writeVbrief(completed, "2026-01-01-done.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Done only",
        status: "completed",
        references: [{ id: "#1" }],
      },
    });
    const content = expectRoadmapBuffer(pending, completed);
    expect(content).toContain("## Forward plan");
    expect(content).toContain("No open work in `pending/`");
    expect(content).toContain("## Completed");
    expect(content).toContain("Done only");
  });

  it("projects active scopes under ## Active", () => {
    const { pending, active } = makeFixture();
    writeVbrief(active, "2026-07-01-200-running.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "In flight",
        status: "running",
        references: [{ id: "#200" }],
      },
    });
    const content = expectRoadmapBuffer(pending);
    expect(content).toContain("## Active");
    expect(content).toContain("In flight");
    expect(content).toContain("`[running]`");
  });

  it("caps unbounded completed dump and notes omitted count", () => {
    const { pending, completed } = makeFixture();
    // ROADMAP_COMPLETED_CAP is 25 — write 30 completed scopes
    for (let i = 1; i <= 30; i += 1) {
      const day = String(i).padStart(2, "0");
      writeVbrief(completed, `2026-01-${day}-done-${i}.xbrief.json`, {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: `Done ${i}`,
          status: "completed",
          // completion stamps drive recency (not creation-dated filenames)
          metadata: { completedAt: `2026-03-${day}T12:00:00Z` },
          references: [{ id: `#${i}` }],
        },
      });
    }
    const content = expectRoadmapBuffer(pending, completed);
    expect(content).toContain("Showing 25 of 30 completed scopes");
    expect(content).toContain("Done 30");
    expect(content).toContain("Done 6"); // 30..6 = 25 newest by completedAt
    expect(content).not.toContain("Done 5");
    // empty-forward marker still present when no pending/proposed/active
    expect(content).toContain("## Forward plan");
  });

  it("completed cap prefers completedAt over creation-dated filename (Greptile P1)", () => {
    const { pending, completed } = makeFixture();
    // Old filename but recent completion
    writeVbrief(completed, "2025-01-01-old-name-recent-complete.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Recently finished old scope",
        status: "completed",
        metadata: { completedAt: "2026-07-30T18:00:00Z" },
        references: [{ id: "#900" }],
      },
    });
    // Newer filename but earlier completion
    writeVbrief(completed, "2026-07-01-new-name-early-complete.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Early finished new name",
        status: "completed",
        metadata: { completedAt: "2026-02-01T12:00:00Z" },
        references: [{ id: "#901" }],
      },
    });
    // 24 filler so only 1 slot remains after cap prefers recent
    for (let i = 1; i <= 24; i += 1) {
      writeVbrief(completed, `2026-04-${String(i).padStart(2, "0")}-filler.xbrief.json`, {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: `Filler ${i}`,
          status: "completed",
          metadata: { completedAt: `2026-04-${String(i).padStart(2, "0")}T00:00:00Z` },
          references: [{ id: `#${1000 + i}` }],
        },
      });
    }
    const content = expectRoadmapBuffer(pending, completed);
    // 26 total → cap 25; earliest completedAt (2026-02) must drop
    expect(content).toContain("Recently finished old scope");
    expect(content).not.toContain("Early finished new name");
    expect(content).toContain("Showing 25 of 26 completed scopes");
  });

  it("banner names forward lifecycle sources (#2653)", () => {
    const { pending } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    const content = expectRoadmapBuffer(pending);
    expect(content).toContain("pending/ + proposed/ + active/");
    expect(content).toContain("completed/ capped");
    expect(content).not.toMatch(/Source of truth: vbrief\/pending\/ \(scope vBRIEFs\)/);
  });

  it("checkDrift requires ROADMAP when only proposed scopes exist", () => {
    const { pending, proposed, outPath } = makeFixture();
    writeVbrief(proposed, "2026-07-01-proposed.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Only proposed", status: "proposed", references: [{ id: "#9" }] },
    });
    const [ok, msg] = checkDrift(pending, outPath);
    expect(ok).toBe(false);
    expect(msg).toContain("does not exist");
  });

  it("renders pending hierarchical body alongside proposed without empty-forward marker", () => {
    const { pending, proposed } = makeFixture();
    writeVbrief(pending, "2026-01-01-deps.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Accepted plan",
        status: "pending",
        references: [{ id: "#10" }],
        items: [
          {
            id: "p1",
            title: "Phase",
            status: "pending",
            subItems: [
              {
                id: "task-a",
                title: "Task A",
                status: "pending",
                subItems: [{ id: "leaf", title: "Leaf", status: "pending" }, "skip-string", null],
              },
            ],
          },
        ],
      },
    });
    writeVbrief(proposed, "2026-07-01-later.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Later idea", status: "proposed", references: [{ id: "#11" }] },
    });
    const content = expectRoadmapBuffer(pending);
    expect(content).toContain("## Accepted plan");
    expect(content).toContain("Leaf");
    expect(content).toContain("## Proposed");
    expect(content).toContain("Later idea");
    expect(content).not.toContain("## Forward plan");
  });

  it("empty lifecycle emits no-pending message", () => {
    const { pending, completed } = makeFixture();
    const content = expectRoadmapBuffer(pending, completed);
    expect(content).toContain("No pending work items.");
    expect(content).not.toContain("## Completed");
  });

  it("hierarchical pending renders Overview narrative under plan title", () => {
    const { pending } = makeFixture();
    writeVbrief(pending, "2026-01-01-overview.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "With overview",
        status: "pending",
        narratives: { Overview: "Why this work matters." },
        references: [{ id: "#42" }],
        items: [{ id: "p1", title: "Only phase", status: "pending", subItems: [] }],
      },
    });
    const content = expectRoadmapBuffer(pending);
    expect(content).toContain("## With overview (#42)");
    expect(content).toContain("Why this work matters.");
  });

  it("main accepts --project-root=equals form (#2653 CLI branch)", () => {
    const { root, pending } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    const outPath = join(root, "ROADMAP.md");
    expect(roadmapRenderMain([`--project-root=${root}`, outPath])).toBe(0);
    expect(readFileSync(outPath, "utf8")).toContain("Feature Work");
  });
});

describe("roadmap-render main() --project-root layout resolver (#2139)", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writePendingVbrief(root: string, layoutDir: string): void {
    const pending = join(root, layoutDir, "pending");
    mkdirSync(pending, { recursive: true });
    const suffix = layoutDir === "xbrief" ? ".xbrief.json" : ".xbrief.json";
    writeFileSync(
      join(pending, `2026-01-01-feature${suffix}`),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Feature X",
          status: "pending",
          references: [{ id: "#7", type: "github-issue" }],
        },
      }),
      "utf8",
    );
  }

  it("resolves xbrief/pending/ via --project-root on migrated tree (#2139)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-xbrief-"));
    tmpDirs.push(root);
    writePendingVbrief(root, "xbrief");
    const outPath = join(root, "ROADMAP.md");
    const exit = roadmapRenderMain(["--project-root", root, outPath]);
    expect(exit).toBe(0);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("Feature X");
  });

  it("refuses vbrief-only trees via --project-root with migrate hint (#4756 R5)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-vbrief-only-"));
    tmpDirs.push(root);
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(
      join(pending, "2026-01-01-feature.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "Legacy", status: "pending", items: [] },
      }),
      "utf8",
    );
    const outPath = join(root, "ROADMAP.md");
    const exit = roadmapRenderMain(["--project-root", root, outPath]);
    expect(exit).toBe(2);
    expect(existsSync(outPath)).toBe(false);
  });

  it("refuses empty xbrief that would hide legacy vbrief scopes (#4756 Greptile P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-empty-xbrief-legacy-"));
    tmpDirs.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(
      join(pending, "2026-01-01-feature.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "Legacy still here", status: "pending", items: [] },
      }),
      "utf8",
    );
    const outPath = join(root, "ROADMAP.md");
    const exit = roadmapRenderMain(["--project-root", root, outPath]);
    expect(exit).toBe(2);
    expect(existsSync(outPath)).toBe(false);
  });

  it("keeps canonical xbrief fallback for empty --project-root (#4756 R5)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-empty-root-"));
    tmpDirs.push(root);
    const outPath = join(root, "ROADMAP.md");
    const exit = roadmapRenderMain(["--project-root", root, outPath]);
    expect(exit).toBe(0);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("No pending work items.");
  });

  it("--check mode resolves xbrief/pending/ via --project-root (#2139)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-check-"));
    tmpDirs.push(root);
    writePendingVbrief(root, "xbrief");
    const outPath = join(root, "ROADMAP.md");
    roadmapRenderMain(["--project-root", root, outPath]);
    const exit = roadmapRenderMain(["--project-root", root, outPath, "--check"]);
    expect(exit).toBe(0);
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("roadmap-render projection containment (#2839)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshEscape(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  itSymlink("renderRoadmap refuses when ROADMAP.md is a symlink outside the project", () => {
    const { pending, outPath } = makeFixture();
    const escapeDir = freshEscape("roadmap-escape-");
    const escapeFile = join(escapeDir, "stolen-roadmap.md");
    writeFileSync(escapeFile, "victim\n", "utf8");
    symlinkSync(escapeFile, outPath);
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);

    const [ok, msg] = renderRoadmap(pending, outPath);
    expect(ok).toBe(false);
    expect(msg).toContain("Failed");
    expect(readFileSync(escapeFile, "utf8")).toBe("victim\n");
  });

  itSymlink(
    "renderRoadmap refuses when ROADMAP parent dir is a symlink outside the project",
    () => {
      const root = mkdtempSync(join(tmpdir(), "deft-roadmap-parent-"));
      created.push(root);
      const pending = join(root, "xbrief", "pending");
      mkdirSync(pending, { recursive: true });
      writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);

      const escapeDir = freshEscape("roadmap-parent-escape-");
      const outParent = join(root, "docs-out");
      symlinkSync(escapeDir, outParent);
      const outPath = join(outParent, "ROADMAP.md");

      // Containment must use project root, not dirname(outPath) (which realpaths to escapeDir).
      const [ok, msg] = renderRoadmap(pending, outPath, { projectRoot: root });
      expect(ok).toBe(false);
      expect(msg).toContain("Failed");
      expect(existsSync(join(escapeDir, "ROADMAP.md"))).toBe(false);
    },
  );
});

describe("roadmap-render main() Prefer-A #4756 false-empty boundary", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function validProjectDefinition(): unknown {
    return {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Roadmap Fixture",
        status: "running",
        items: [],
        narratives: {
          Overview: "Fixture project for roadmap:render.",
          "Tech Stack": "TypeScript",
        },
      },
    };
  }

  function schemaOnlyProjectDefinition(): unknown {
    return {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "Schema only",
        status: "running",
        items: [],
      },
    };
  }

  function writeActiveStory(activeDir: string, name: string, title: string): void {
    writeFileSync(
      join(activeDir, name),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title,
          status: "running",
          items: [],
          references: [{ id: "#4756", type: "github-issue" }],
        },
      }),
      "utf8",
    );
  }

  function withCwd<T>(dir: string, fn: () => T): T {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  }

  it("main([]) lists active work on xbrief-only tree with valid PROJECT-DEFINITION", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-active-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story-a.xbrief.json", "Active Story A");
    writeActiveStory(active, "2026-01-01-story-b.xbrief.json", "Active Story B");

    const exit = withCwd(root, () => roadmapRenderMain([]));
    expect(exit).toBe(0);
    const content = readFileSync(join(root, "ROADMAP.md"), "utf8");
    expect(content).toContain("## Active");
    expect(content).toContain("Active Story A");
    expect(content).toContain("Active Story B");
    expect(content).not.toContain("No pending work items.");
  });

  it("main([--check]) accepts active projection and refuses false-empty ROADMAP", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-check-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Active Story");

    expect(withCwd(root, () => roadmapRenderMain([]))).toBe(0);
    expect(withCwd(root, () => roadmapRenderMain(["--check"]))).toBe(0);

    writeFileSync(
      join(root, "ROADMAP.md"),
      "<!-- AUTO-GENERATED -->\n# Roadmap\n\nNo pending work items.\n\n",
      "utf8",
    );
    expect(withCwd(root, () => roadmapRenderMain(["--check"]))).not.toBe(0);
  });

  it("no-flag cwd without local layout refuses without writing child ROADMAP", () => {
    const parent = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-parent-"));
    tmpDirs.push(parent);
    const xbrief = join(parent, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Parent Active");
    const child = join(parent, "child");
    mkdirSync(child);

    const exit = withCwd(child, () => roadmapRenderMain([]));
    expect(exit).toBe(2);
    expect(existsSync(join(child, "ROADMAP.md"))).toBe(false);
    expect(withCwd(child, () => roadmapRenderMain(["--check"]))).toBe(2);
  });

  it("empty child xbrief/ refuses no-flag render and check", () => {
    const parent = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-empty-child-"));
    tmpDirs.push(parent);
    const xbrief = join(parent, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Parent Active");
    const child = join(parent, "pkg");
    mkdirSync(join(child, "xbrief"), { recursive: true });

    expect(withCwd(child, () => roadmapRenderMain([]))).toBe(2);
    expect(existsSync(join(child, "ROADMAP.md"))).toBe(false);
    expect(withCwd(child, () => roadmapRenderMain(["--check"]))).toBe(2);
  });

  it("nested-only .eval scratch under child xbrief refuses no-flag path", () => {
    const parent = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-eval-child-"));
    tmpDirs.push(parent);
    const xbrief = join(parent, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Parent Active");
    const child = join(parent, "nested");
    const evalDir = join(child, "xbrief", ".eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(join(evalDir, "scratch.xbrief.json"), JSON.stringify({ note: true }), "utf8");

    expect(withCwd(child, () => roadmapRenderMain([]))).toBe(2);
    expect(existsSync(join(child, "ROADMAP.md"))).toBe(false);
  });

  it("child {} PROJECT-DEFINITION stub refuses no-flag render and check", () => {
    const parent = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-stub-"));
    tmpDirs.push(parent);
    const xbrief = join(parent, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Parent Active");
    const child = join(parent, "child");
    mkdirSync(join(child, "xbrief"), { recursive: true });
    writeFileSync(join(child, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}\n", "utf8");

    expect(withCwd(child, () => roadmapRenderMain([]))).toBe(2);
    expect(existsSync(join(child, "ROADMAP.md"))).toBe(false);
    expect(withCwd(child, () => roadmapRenderMain(["--check"]))).toBe(2);
  });

  it("invalid JSON / schema-valid project-invalid / non-file marker refuse", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-markers-"));
    tmpDirs.push(root);

    const badJson = join(root, "bad-json");
    mkdirSync(join(badJson, "xbrief"), { recursive: true });
    writeFileSync(join(badJson, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{not-json", "utf8");
    expect(withCwd(badJson, () => roadmapRenderMain([]))).toBe(2);

    const schemaOnly = join(root, "schema-only");
    mkdirSync(join(schemaOnly, "xbrief"), { recursive: true });
    writeFileSync(
      join(schemaOnly, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(schemaOnlyProjectDefinition()),
      "utf8",
    );
    expect(withCwd(schemaOnly, () => roadmapRenderMain([]))).toBe(2);

    const nonFile = join(root, "non-file");
    mkdirSync(join(nonFile, "xbrief", "PROJECT-DEFINITION.xbrief.json"), { recursive: true });
    expect(withCwd(nonFile, () => roadmapRenderMain([]))).toBe(2);
  });

  it("non-directory active folder refuses empty claim render and check", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-active-file-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    mkdirSync(xbrief, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeFileSync(join(xbrief, "active"), "not-a-directory", "utf8");

    expect(withCwd(root, () => roadmapRenderMain([]))).not.toBe(0);
    expect(existsSync(join(root, "ROADMAP.md"))).toBe(false);
    expect(withCwd(root, () => roadmapRenderMain(["--check"]))).not.toBe(0);
  });

  it("corrupt active-only file refuses all-empty claim", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-corrupt-only-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeFileSync(join(active, "broken.xbrief.json"), "{broken", "utf8");

    expect(withCwd(root, () => roadmapRenderMain([]))).not.toBe(0);
    expect(existsSync(join(root, "ROADMAP.md"))).toBe(false);
    expect(withCwd(root, () => roadmapRenderMain(["--check"]))).not.toBe(0);
  });

  it("buffer/result path refuses corrupt-only empty claim (release gate) (#4756 Greptile P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-buffer-corrupt-"));
    tmpDirs.push(root);
    const pending = join(root, "xbrief", "pending");
    const active = join(root, "xbrief", "active");
    mkdirSync(pending, { recursive: true });
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "broken.xbrief.json"), "{broken", "utf8");

    const [ok, msg] = renderRoadmapToBufferResult(pending);
    expect(ok).toBe(false);
    expect(msg).toMatch(/Unreadable lifecycle file/i);
    expect(renderRoadmapToBuffer(pending)).toEqual([false, msg]);
  });

  it("corrupt active beside completed history refuses completed-only marker", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-4756-corrupt-completed-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    const active = join(xbrief, "active");
    const completed = join(xbrief, "completed");
    mkdirSync(active, { recursive: true });
    mkdirSync(completed, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeFileSync(join(active, "broken.xbrief.json"), "{broken", "utf8");
    writeFileSync(
      join(completed, "2026-01-01-done.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "Done", status: "completed", items: [] },
      }),
      "utf8",
    );

    expect(withCwd(root, () => roadmapRenderMain([]))).not.toBe(0);
    expect(existsSync(join(root, "ROADMAP.md"))).toBe(false);
    expect(withCwd(root, () => roadmapRenderMain(["--check"]))).not.toBe(0);
  });

  it("main([--, --project-root, root]) ignores bare -- and writes ROADMAP.md (#5251)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-5251-sep-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Active Story");

    const exit = withCwd(root, () => roadmapRenderMain(["--", "--project-root", root]));
    expect(exit).toBe(0);
    const content = readFileSync(join(root, "ROADMAP.md"), "utf8");
    expect(content).toContain("## Active");
    expect(content).toContain("Active Story");
    expect(existsSync(join(root, "--"))).toBe(false);
  });

  it("main([--]) refuses identity like main([]) without local PROJECT-DEFINITION (#5251)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-5251-bare-"));
    tmpDirs.push(root);
    mkdirSync(root, { recursive: true });

    const emptyExit = withCwd(root, () => roadmapRenderMain([]));
    const bareExit = withCwd(root, () => roadmapRenderMain(["--"]));
    expect(emptyExit).toBe(2);
    expect(bareExit).toBe(2);
    expect(existsSync(join(root, "ROADMAP.md"))).toBe(false);
    expect(existsSync(join(root, "--"))).toBe(false);
  });

  it("main([--help]) exits 0 without overwriting ROADMAP.md (#5251)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-5251-help-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Active Story");
    const roadmapPath = join(root, "ROADMAP.md");
    const sentinel = "SENTINEL-ROADMAP-CONTENT\n";
    writeFileSync(roadmapPath, sentinel, "utf8");

    const outChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      outChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (origWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    let exit: number;
    try {
      exit = withCwd(root, () => roadmapRenderMain(["--help"]));
    } finally {
      process.stdout.write = origWrite;
    }
    expect(exit).toBe(0);
    expect(readFileSync(roadmapPath, "utf8")).toBe(sentinel);
    const help = outChunks.join("");
    expect(help).toContain("[--project-root <dir>] [outPath]");
    expect(help).toContain("<pendingDir> [outPath]");
    expect(help).toContain("not end-of-options");
  });

  it("main([--bogus]) exits 2 without writing ROADMAP.md (#5251)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-5251-bogus-"));
    tmpDirs.push(root);
    const xbrief = join(root, "xbrief");
    const active = join(xbrief, "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(validProjectDefinition()),
      "utf8",
    );
    writeActiveStory(active, "2026-01-01-story.xbrief.json", "Active Story");

    const exit = withCwd(root, () => roadmapRenderMain(["--bogus"]));
    expect(exit).toBe(2);
    expect(existsSync(join(root, "ROADMAP.md"))).toBe(false);
  });
});

describe("ROADMAP producer stays off complete/finalize (#4316)", () => {
  it("does not export syncRoadmapAfterCompletedSetChange or --sync-if-stale", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./roadmap-render.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("syncRoadmapAfterCompletedSetChange");
    expect(src).not.toContain("--sync-if-stale");
    expect(src).not.toContain("syncIfStale");
  });

  it("tasks/roadmap.yml has render and check only (no sync-if-stale)", () => {
    const roadmapTasks = readFileSync(
      fileURLToPath(new URL("../../../../tasks/roadmap.yml", import.meta.url)),
      "utf8",
    );
    expect(roadmapTasks).not.toContain("sync-if-stale");
    expect(roadmapTasks).not.toContain("--sync-if-stale");
    expect(roadmapTasks).toContain("render:");
    expect(roadmapTasks).toContain("check:");
  });
});
