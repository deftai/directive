import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateProjectInvariantsGate,
  PROJECT_INVARIANT_REMEDIATION,
  resolveProjectRootForInvariants,
} from "./project-invariants-gate.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "deft-inv-gate-"));
  roots.push(r);
  return r;
}

function writeProjectDef(
  projectRoot: string,
  policy: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): void {
  const dir = join(projectRoot, "xbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy, ...extras },
    }),
    "utf8",
  );
}

function story(
  fileScope: readonly string[],
  coverage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    plan: {
      status: "running",
      metadata: {
        swarm: { file_scope: [...fileScope] },
        ...(coverage !== undefined ? { coverage_map: coverage } : {}),
      },
    },
  };
}

describe("resolveProjectRootForInvariants", () => {
  it("prefers an explicit project root", () => {
    expect(resolveProjectRootForInvariants("/a/xbrief/active/s.json", "/explicit")).toBe(
      "/explicit",
    );
  });

  it("walks up from an xbrief artifact to the repo root", () => {
    const r = root();
    const path = join(r, "xbrief", "active", "s.xbrief.json");
    mkdirSync(join(r, "xbrief", "active"), { recursive: true });
    writeFileSync(path, "{}", "utf8");
    expect(resolveProjectRootForInvariants(path)).toBe(r);
  });

  it("returns undefined when there is no lifecycle folder", () => {
    expect(resolveProjectRootForInvariants(join(root(), "active", "s.json"))).toBeUndefined();
  });
});

describe("evaluateProjectInvariantsGate", () => {
  it("skips when asked", () => {
    const result = evaluateProjectInvariantsGate({}, { skip: true, projectRoot: root() });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/skipped/);
  });

  it("is a no-op without a project root", () => {
    const result = evaluateProjectInvariantsGate(story(["packages/core/src/preflight"]));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/N\/A/);
  });

  it("is a no-op when the authored list is empty or absent", () => {
    const r = root();
    writeProjectDef(r, {});
    const result = evaluateProjectInvariantsGate(story(["packages/core/src/preflight"]), {
      projectRoot: r,
    });
    expect(result.ok).toBe(true);
    expect(result.applicableIds).toEqual([]);
    expect(result.message).toMatch(/empty/);
  });

  it("fails closed and names the omitted applicable ID", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["packages/core/src/preflight/**"],
        },
      ],
    });
    const result = evaluateProjectInvariantsGate(story(["packages/core/src/preflight"]), {
      projectRoot: r,
    });
    expect(result.ok).toBe(false);
    expect(result.missingIds).toEqual(["host-load"]);
    expect(result.message).toContain("host-load");
    expect(result.message).toContain(PROJECT_INVARIANT_REMEDIATION);
  });

  it("passes when the applicable ID is covered", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["packages/core/src/preflight/**"],
        },
      ],
    });
    const result = evaluateProjectInvariantsGate(
      story(["packages/core/src/preflight"], { "host-load": { disposition: "covered" } }),
      { projectRoot: r },
    );
    expect(result.ok).toBe(true);
    expect(result.applicableIds).toEqual(["host-load"]);
    expect(result.missingIds).toEqual([]);
  });

  it("does not require a disposition when file_scope does not intersect", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["packages/core/src/preflight/**"],
        },
      ],
    });
    const result = evaluateProjectInvariantsGate(story(["content/docs"]), { projectRoot: r });
    expect(result.ok).toBe(true);
    expect(result.applicableIds).toEqual([]);
    expect(result.message).toMatch(/none applicable/);
  });

  it("treats an ID added after authoring as list-drift (fails closed)", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["packages/core/src/preflight/**"],
        },
        {
          id: "new-after-authoring",
          statement: "Added after the story was written.",
          paths: ["packages/core/src/preflight/**"],
        },
      ],
    });
    const result = evaluateProjectInvariantsGate(
      story(["packages/core/src/preflight"], { "host-load": { disposition: "covered" } }),
      { projectRoot: r },
    );
    expect(result.ok).toBe(false);
    expect(result.missingIds).toEqual(["new-after-authoring"]);
    expect(result.message).toContain("new-after-authoring");
  });

  it("reads coverage_map from parent_lineage the same as from metadata", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["packages/core/src/preflight/**"],
        },
      ],
    });
    const result = evaluateProjectInvariantsGate(
      {
        plan: {
          status: "running",
          metadata: {
            swarm: { file_scope: ["packages/core/src/preflight"] },
            parent_lineage: {
              coverage_map: { "host-load": { disposition: "covered" } },
            },
          },
        },
      },
      { projectRoot: r },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts parentLineage camelCase and nested coverage.coverage_map", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["packages/core/src/preflight/**"],
        },
      ],
    });
    const camel = evaluateProjectInvariantsGate(
      {
        plan: {
          status: "running",
          metadata: {
            swarm: { file_scope: ["packages/core/src/preflight"] },
            parentLineage: {
              coverage_map: { "host-load": { disposition: "covered" } },
            },
          },
        },
      },
      { projectRoot: r },
    );
    expect(camel.ok).toBe(true);

    const nested = evaluateProjectInvariantsGate(
      {
        plan: {
          status: "running",
          metadata: {
            swarm: { file_scope: ["packages/core/src/preflight"] },
            coverage: {
              coverage_map: { "host-load": { disposition: "covered" } },
            },
          },
        },
      },
      { projectRoot: r },
    );
    expect(nested.ok).toBe(true);
  });

  it("applies the same check to a slice-scoped story", () => {
    const r = root();
    writeProjectDef(r, {
      projectInvariants: [
        {
          id: "host-load",
          statement: "Do not break host load.",
          paths: ["packages/core/src/preflight/**"],
        },
      ],
    });
    const slice = evaluateProjectInvariantsGate(
      story(["packages/core/src/preflight/evaluate.ts"]),
      {
        projectRoot: r,
      },
    );
    expect(slice.ok).toBe(false);
    expect(slice.missingIds).toEqual(["host-load"]);
  });
});
