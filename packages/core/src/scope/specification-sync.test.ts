import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncSpecificationAfterScopeMove } from "./specification-sync.js";
import { runTransition } from "./transition.js";
import { formatVbriefJson } from "./vbrief-json.js";

describe("specification-sync branches", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function setupSpecification(body: Record<string, unknown>) {
    root = mkdtempSync(join(tmpdir(), "spec-sync-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(join(vbrief, "specification.xbrief.json"), formatVbriefJson(body));
    return vbrief;
  }

  it("matches items via references, metadata refs, source_path, id, and title", () => {
    const vbrief = setupSpecification({
      plan: {
        items: [
          {
            id: "other-id",
            title: "Via references",
            status: "proposed",
            references: [{ type: "x-vbrief/plan", uri: "active/ref.xbrief.json" }],
          },
          {
            id: "2026-01-01-target",
            title: "Ignored title",
            status: "proposed",
            metadata: {
              source_path: "active/meta.xbrief.json",
              references: [{ type: "x-vbrief/plan", uri: "active/meta.xbrief.json" }],
            },
          },
          {
            id: "slug-only",
            title: "Title matched scope",
            status: "proposed",
          },
        ],
        references: [{ type: "other", uri: "nope" }],
      },
    });

    const scopeData = { plan: { title: "Title matched scope", status: "running", items: [] } };
    syncSpecificationAfterScopeMove(
      scopeData,
      join(vbrief, "active", "2026-01-01-target.xbrief.json"),
      join(vbrief, "completed", "2026-01-01-target.xbrief.json"),
      vbrief,
      "completed",
    );
    syncSpecificationAfterScopeMove(
      scopeData,
      join(vbrief, "active", "ref.xbrief.json"),
      join(vbrief, "completed", "ref.xbrief.json"),
      vbrief,
      "completed",
    );
    syncSpecificationAfterScopeMove(
      scopeData,
      join(vbrief, "active", "meta.xbrief.json"),
      join(vbrief, "completed", "meta.xbrief.json"),
      vbrief,
      "completed",
    );
    syncSpecificationAfterScopeMove(
      scopeData,
      join(vbrief, "active", "slug-only.xbrief.json"),
      join(vbrief, "completed", "slug-only.xbrief.json"),
      vbrief,
      "completed",
    );

    const spec = JSON.parse(readFileSync(join(vbrief, "specification.xbrief.json"), "utf8"));
    expect(spec.plan.items.every((i: { status: string }) => i.status === "completed")).toBe(true);
  });

  it("rewrites top-level plan references with file:// prefix", () => {
    const vbrief = setupSpecification({
      plan: {
        items: [],
        references: [{ type: "x-vbrief/plan", uri: "file://active/top.xbrief.json" }],
      },
    });
    const active = join(vbrief, "active", "top.xbrief.json");
    writeFileSync(active, formatVbriefJson({ plan: { title: "T", status: "running", items: [] } }));
    syncSpecificationAfterScopeMove(
      JSON.parse(readFileSync(active, "utf8")),
      active,
      join(vbrief, "pending", "top.xbrief.json"),
      vbrief,
      "pending",
    );
    const spec = JSON.parse(readFileSync(join(vbrief, "specification.xbrief.json"), "utf8"));
    expect(spec.plan.references[0].uri).toBe("file://pending/top.xbrief.json");
  });

  it("no-ops on missing specification, bad json, invalid plan, and outside vbrief paths", () => {
    root = mkdtempSync(join(tmpdir(), "spec-noop-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const active = join(vbrief, "active", "x.xbrief.json");
    writeFileSync(active, formatVbriefJson({ plan: { title: "T", status: "running", items: [] } }));
    const data = JSON.parse(readFileSync(active, "utf8"));
    syncSpecificationAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.xbrief.json"),
      vbrief,
      "completed",
    );
    writeFileSync(join(vbrief, "specification.xbrief.json"), "{", "utf8");
    syncSpecificationAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.xbrief.json"),
      vbrief,
      "completed",
    );
    writeFileSync(join(vbrief, "specification.xbrief.json"), "null", "utf8");
    syncSpecificationAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.xbrief.json"),
      vbrief,
      "completed",
    );
    writeFileSync(join(vbrief, "specification.xbrief.json"), formatVbriefJson({ plan: [] }));
    syncSpecificationAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.xbrief.json"),
      vbrief,
      "completed",
    );
    syncSpecificationAfterScopeMove(data, "/outside/a", "/outside/b", vbrief, "completed");
    expect(true).toBe(true);
  });

  it("sync creates metadata when item matches by title only", () => {
    const vbrief = setupSpecification({
      plan: {
        items: [{ id: "unrelated", title: "Only title match", status: "proposed" }],
        references: [],
      },
    });
    const active = join(vbrief, "active", "only-title.xbrief.json");
    writeFileSync(
      active,
      formatVbriefJson({ plan: { title: "Only title match", status: "running", items: [] } }),
    );
    syncSpecificationAfterScopeMove(
      JSON.parse(readFileSync(active, "utf8")),
      active,
      join(vbrief, "completed", "only-title.xbrief.json"),
      vbrief,
      "completed",
    );
    const spec = JSON.parse(readFileSync(join(vbrief, "specification.xbrief.json"), "utf8"));
    expect(spec.plan.items[0].metadata.source_path).toContain("completed/");
  });

  it("updates matching item to failed on scope:fail and leaves unrelated items", () => {
    const vbrief = setupSpecification({
      plan: {
        items: [
          { id: "later-item", title: "Later roadmap item", status: "proposed" },
          { id: "2026-01-01-ship", title: "Ship feature", status: "proposed" },
        ],
        references: [],
      },
    });
    syncSpecificationAfterScopeMove(
      { plan: { title: "Ship feature", status: "running", items: [] } },
      join(vbrief, "active", "2026-01-01-ship.xbrief.json"),
      join(vbrief, "completed", "2026-01-01-ship.xbrief.json"),
      vbrief,
      "failed",
    );
    const spec = JSON.parse(readFileSync(join(vbrief, "specification.xbrief.json"), "utf8"));
    expect(spec.plan.items[0].status).toBe("proposed");
    expect(spec.plan.items[1].status).toBe("failed");
  });

  it("updates matching item to cancelled on scope:cancel", () => {
    const vbrief = setupSpecification({
      plan: {
        items: [{ id: "2026-01-01-drop", title: "Drop scope", status: "proposed" }],
        references: [],
      },
    });
    syncSpecificationAfterScopeMove(
      { plan: { title: "Drop scope", status: "running", items: [] } },
      join(vbrief, "active", "2026-01-01-drop.xbrief.json"),
      join(vbrief, "cancelled", "2026-01-01-drop.xbrief.json"),
      vbrief,
      "cancelled",
    );
    const spec = JSON.parse(readFileSync(join(vbrief, "specification.xbrief.json"), "utf8"));
    expect(spec.plan.items[0].status).toBe("cancelled");
    expect(spec.plan.items[0].metadata.lifecycle_folder).toBe("cancelled");
  });
});

describe("runTransition specification sync (#2566)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function makeRepoWithSpec(): string {
    root = mkdtempSync(join(tmpdir(), "spec-transition-"));
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      formatVbriefJson({
        plan: {
          title: "Roadmap",
          status: "approved",
          items: [
            { id: "later-a", title: "Later phase A", status: "proposed" },
            { id: "later-b", title: "Later phase B", status: "proposed" },
            { id: "2026-01-01-ship", title: "Ship now", status: "proposed" },
          ],
          references: [],
        },
      }),
    );
    return root;
  }

  it("completes active scope and syncs only the matching specification item", () => {
    root = makeRepoWithSpec();
    const active = join(root, "xbrief", "active", "2026-01-01-ship.xbrief.json");
    writeFileSync(
      active,
      formatVbriefJson({ plan: { title: "Ship now", status: "running", items: [] } }),
    );
    const result = runTransition("complete", active);
    expect(result.ok).toBe(true);
    const spec = JSON.parse(
      readFileSync(join(root, "xbrief", "specification.xbrief.json"), "utf8"),
    );
    expect(spec.plan.items[0].status).toBe("proposed");
    expect(spec.plan.items[1].status).toBe("proposed");
    expect(spec.plan.items[2].status).toBe("completed");
    expect(spec.plan.items[2].metadata.source_path).toBe("completed/2026-01-01-ship.xbrief.json");
  });

  it("fails active scope and syncs matching specification item to failed", () => {
    root = makeRepoWithSpec();
    const active = join(root, "xbrief", "active", "2026-01-01-ship.xbrief.json");
    writeFileSync(
      active,
      formatVbriefJson({ plan: { title: "Ship now", status: "running", items: [] } }),
    );
    const result = runTransition("fail", active);
    expect(result.ok).toBe(true);
    const spec = JSON.parse(
      readFileSync(join(root, "xbrief", "specification.xbrief.json"), "utf8"),
    );
    expect(spec.plan.items[2].status).toBe("failed");
  });
});
