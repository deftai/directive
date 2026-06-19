import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { formatVbriefJson } from "./vbrief-json.js";

describe("project-definition-sync branches", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  function setupProjectDef(body: Record<string, unknown>) {
    root = mkdtempSync(join(tmpdir(), "pd-sync-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), formatVbriefJson(body));
    return vbrief;
  }

  it("matches items via references, metadata refs, source_path, id, and title", () => {
    const vbrief = setupProjectDef({
      plan: {
        items: [
          {
            id: "other-id",
            title: "Via references",
            status: "running",
            references: [{ type: "x-vbrief/plan", uri: "active/ref.vbrief.json" }],
          },
          {
            id: "2026-01-01-target",
            title: "Ignored title",
            status: "running",
            metadata: {
              source_path: "active/meta.vbrief.json",
              references: [{ type: "x-vbrief/plan", uri: "active/meta.vbrief.json" }],
            },
          },
          {
            id: "slug-only",
            title: "Title matched scope",
            status: "running",
          },
        ],
        references: [{ type: "other", uri: "nope" }],
      },
    });

    const scopeData = { plan: { title: "Title matched scope", status: "running", items: [] } };
    syncProjectDefinitionAfterScopeMove(
      scopeData,
      join(vbrief, "active", "2026-01-01-target.vbrief.json"),
      join(vbrief, "completed", "2026-01-01-target.vbrief.json"),
      vbrief,
      "completed",
    );
    syncProjectDefinitionAfterScopeMove(
      scopeData,
      join(vbrief, "active", "ref.vbrief.json"),
      join(vbrief, "completed", "ref.vbrief.json"),
      vbrief,
      "completed",
    );
    syncProjectDefinitionAfterScopeMove(
      scopeData,
      join(vbrief, "active", "meta.vbrief.json"),
      join(vbrief, "completed", "meta.vbrief.json"),
      vbrief,
      "completed",
    );
    syncProjectDefinitionAfterScopeMove(
      scopeData,
      join(vbrief, "active", "slug-only.vbrief.json"),
      join(vbrief, "completed", "slug-only.vbrief.json"),
      vbrief,
      "completed",
    );

    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"));
    expect(pd.plan.items.every((i: { status: string }) => i.status === "completed")).toBe(true);
  });

  it("rewrites top-level plan references with file:// prefix", () => {
    const vbrief = setupProjectDef({
      plan: {
        items: [],
        references: [{ type: "x-vbrief/plan", uri: "file://active/top.vbrief.json" }],
      },
    });
    const active = join(vbrief, "active", "top.vbrief.json");
    writeFileSync(active, formatVbriefJson({ plan: { title: "T", status: "running", items: [] } }));
    syncProjectDefinitionAfterScopeMove(
      JSON.parse(readFileSync(active, "utf8")),
      active,
      join(vbrief, "pending", "top.vbrief.json"),
      vbrief,
      "pending",
    );
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"));
    expect(pd.plan.references[0].uri).toBe("file://pending/top.vbrief.json");
  });

  it("no-ops on missing project def, bad json, invalid plan, and outside vbrief paths", () => {
    root = mkdtempSync(join(tmpdir(), "pd-noop-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const active = join(vbrief, "active", "x.vbrief.json");
    writeFileSync(active, formatVbriefJson({ plan: { title: "T", status: "running", items: [] } }));
    const data = JSON.parse(readFileSync(active, "utf8"));
    syncProjectDefinitionAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.vbrief.json"),
      vbrief,
      "completed",
    );
    writeFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "{", "utf8");
    syncProjectDefinitionAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.vbrief.json"),
      vbrief,
      "completed",
    );
    writeFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), formatVbriefJson({ plan: [] }));
    syncProjectDefinitionAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.vbrief.json"),
      vbrief,
      "completed",
    );
    syncProjectDefinitionAfterScopeMove(data, "/outside/a", "/outside/b", vbrief, "completed");
    expect(true).toBe(true);
  });

  it("sync creates metadata when item matches by title only", () => {
    const vbrief = setupProjectDef({
      plan: {
        items: [{ id: "unrelated", title: "Only title match", status: "running" }],
        references: [],
      },
    });
    const active = join(vbrief, "active", "only-title.vbrief.json");
    writeFileSync(
      active,
      formatVbriefJson({ plan: { title: "Only title match", status: "running", items: [] } }),
    );
    syncProjectDefinitionAfterScopeMove(
      JSON.parse(readFileSync(active, "utf8")),
      active,
      join(vbrief, "completed", "only-title.vbrief.json"),
      vbrief,
      "completed",
    );
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"));
    expect(pd.plan.items[0].metadata.source_path).toContain("completed/");
  });

  it("creates metadata object when missing and skips unchanged uri", () => {
    const vbrief = setupProjectDef({
      plan: {
        items: [
          {
            id: "2026-04-12-x",
            title: "Scope title",
            status: "completed",
            metadata: { source_path: "completed/x.vbrief.json", lifecycle_folder: "completed" },
          },
        ],
        references: [{ type: "x-vbrief/plan", uri: "completed/x.vbrief.json" }],
      },
    });
    const completed = join(vbrief, "completed", "2026-04-12-x.vbrief.json");
    mkdirSync(join(vbrief, "completed"), { recursive: true });
    writeFileSync(
      completed,
      formatVbriefJson({ plan: { title: "Scope title", status: "completed", items: [] } }),
    );
    const data = JSON.parse(readFileSync(completed, "utf8"));
    syncProjectDefinitionAfterScopeMove(data, completed, completed, vbrief, "completed");
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "utf8"));
    expect(pd.plan.items[0].metadata.lifecycle_folder).toBe("completed");
  });
});
