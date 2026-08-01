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
    const buffer = renderRoadmapToBuffer(pending, completed);
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
    expect(generateRoadmapContent(pending, completed)).toBe(
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

    const content = renderRoadmapToBuffer(pending, completed);
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
    const content = renderRoadmapToBuffer(pending, completed);
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
    const content = renderRoadmapToBuffer(pending);
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
          references: [{ id: `#${i}` }],
        },
      });
    }
    const content = renderRoadmapToBuffer(pending, completed);
    expect(content).toContain("Showing 25 of 30 completed scopes");
    expect(content).toContain("Done 30");
    expect(content).toContain("Done 6"); // 30..6 = 25 newest by filename
    expect(content).not.toContain("Done 5");
    // empty-forward marker still present when no pending/proposed/active
    expect(content).toContain("## Forward plan");
  });

  it("banner names forward lifecycle sources (#2653)", () => {
    const { pending } = makeFixture();
    writeVbrief(pending, "2026-01-01-a.xbrief.json", MULTI_REF_SCOPE_A);
    const content = renderRoadmapToBuffer(pending);
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
    const content = renderRoadmapToBuffer(pending);
    expect(content).toContain("## Accepted plan");
    expect(content).toContain("Leaf");
    expect(content).toContain("## Proposed");
    expect(content).toContain("Later idea");
    expect(content).not.toContain("## Forward plan");
  });

  it("empty lifecycle emits no-pending message", () => {
    const { pending, completed } = makeFixture();
    const content = renderRoadmapToBuffer(pending, completed);
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
    const content = renderRoadmapToBuffer(pending);
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

  it("falls back to vbrief/pending/ via --project-root on legacy tree (#2139)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-roadmap-vbrief-"));
    tmpDirs.push(root);
    writePendingVbrief(root, "xbrief");
    const outPath = join(root, "ROADMAP.md");
    const exit = roadmapRenderMain(["--project-root", root, outPath]);
    expect(exit).toBe(0);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("Feature X");
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
