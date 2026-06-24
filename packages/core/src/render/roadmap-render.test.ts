import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDrift,
  main as roadmapRenderMain,
  renderRoadmap,
  renderRoadmapToBuffer,
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
    references: [
      { id: "#311" },
      { url: "https://github.com/deftai/directive/issues/309" },
    ],
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
});
