import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { formatBriefJson } from "./vbrief-json.js";

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
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), formatBriefJson(body));
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
            references: [{ type: "x-vbrief/plan", uri: "active/ref.xbrief.json" }],
          },
          {
            id: "2026-01-01-target",
            title: "Ignored title",
            status: "running",
            metadata: {
              source_path: "active/meta.xbrief.json",
              references: [{ type: "x-vbrief/plan", uri: "active/meta.xbrief.json" }],
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
      join(vbrief, "active", "2026-01-01-target.xbrief.json"),
      join(vbrief, "completed", "2026-01-01-target.xbrief.json"),
      vbrief,
      "completed",
    );
    syncProjectDefinitionAfterScopeMove(
      scopeData,
      join(vbrief, "active", "ref.xbrief.json"),
      join(vbrief, "completed", "ref.xbrief.json"),
      vbrief,
      "completed",
    );
    syncProjectDefinitionAfterScopeMove(
      scopeData,
      join(vbrief, "active", "meta.xbrief.json"),
      join(vbrief, "completed", "meta.xbrief.json"),
      vbrief,
      "completed",
    );
    syncProjectDefinitionAfterScopeMove(
      scopeData,
      join(vbrief, "active", "slug-only.xbrief.json"),
      join(vbrief, "completed", "slug-only.xbrief.json"),
      vbrief,
      "completed",
    );

    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8"));
    expect(pd.plan.items.every((i: { status: string }) => i.status === "completed")).toBe(true);
  });

  // #2213: on a migrated xbrief/ tree the sync MUST resolve PROJECT-DEFINITION
  // via the layout-aware path so references/items rewrite after scope moves.
  it("rewrites plan references on a migrated xbrief tree (#2213)", () => {
    root = mkdtempSync(join(tmpdir(), "pd-sync-xbrief-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });
    writeFileSync(
      join(xbrief, "active", "seed.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "s", status: "running" } }),
      "utf8",
    );
    writeFileSync(
      join(xbrief, "PROJECT-DEFINITION.xbrief.json"),
      formatBriefJson({
        plan: {
          items: [],
          references: [{ type: "x-vbrief/plan", uri: "file://active/top.xbrief.json" }],
        },
      }),
      "utf8",
    );
    const active = join(xbrief, "active", "top.xbrief.json");
    mkdirSync(join(xbrief, "pending"), { recursive: true });
    writeFileSync(active, formatBriefJson({ plan: { title: "T", status: "running", items: [] } }));
    syncProjectDefinitionAfterScopeMove(
      JSON.parse(readFileSync(active, "utf8")),
      active,
      join(xbrief, "pending", "top.xbrief.json"),
      xbrief,
      "pending",
    );
    const pd = JSON.parse(
      readFileSync(join(xbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as unknown;
    if (pd === null || typeof pd !== "object") {
      throw new Error("expected object PROJECT-DEFINITION");
    }
    expect((pd as { plan: { references: Array<{ uri: string }> } }).plan.references[0].uri).toBe(
      "file://pending/top.xbrief.json",
    );
  });

  it("rewrites top-level plan references with file:// prefix", () => {
    const vbrief = setupProjectDef({
      plan: {
        items: [],
        references: [{ type: "x-vbrief/plan", uri: "file://active/top.xbrief.json" }],
      },
    });
    const active = join(vbrief, "active", "top.xbrief.json");
    writeFileSync(active, formatBriefJson({ plan: { title: "T", status: "running", items: [] } }));
    syncProjectDefinitionAfterScopeMove(
      JSON.parse(readFileSync(active, "utf8")),
      active,
      join(vbrief, "pending", "top.xbrief.json"),
      vbrief,
      "pending",
    );
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8"));
    expect(pd.plan.references[0].uri).toBe("file://pending/top.xbrief.json");
  });

  it("returns error when PROJECT-DEFINITION exists but is invalid JSON", () => {
    root = mkdtempSync(join(tmpdir(), "pd-noop-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    const active = join(vbrief, "active", "x.xbrief.json");
    writeFileSync(active, formatBriefJson({ plan: { title: "T", status: "running", items: [] } }));
    const data = JSON.parse(readFileSync(active, "utf8"));
    expect(
      syncProjectDefinitionAfterScopeMove(
        data,
        active,
        join(vbrief, "completed", "x.xbrief.json"),
        vbrief,
        "completed",
      ),
    ).toBeNull();

    writeFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "{", "utf8");
    const badJson = syncProjectDefinitionAfterScopeMove(
      data,
      active,
      join(vbrief, "completed", "x.xbrief.json"),
      vbrief,
      "completed",
    );
    expect(badJson).toMatch(/not valid JSON/);

    writeFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), formatBriefJson({ plan: [] }));
    expect(
      syncProjectDefinitionAfterScopeMove(
        data,
        active,
        join(vbrief, "completed", "x.xbrief.json"),
        vbrief,
        "completed",
      ),
    ).toBeNull();
    expect(
      syncProjectDefinitionAfterScopeMove(data, "/outside/a", "/outside/b", vbrief, "completed"),
    ).toBeNull();
  });

  it("sync creates metadata when item matches by title only", () => {
    const vbrief = setupProjectDef({
      plan: {
        items: [{ id: "unrelated", title: "Only title match", status: "running" }],
        references: [],
      },
    });
    const active = join(vbrief, "active", "only-title.xbrief.json");
    writeFileSync(
      active,
      formatBriefJson({ plan: { title: "Only title match", status: "running", items: [] } }),
    );
    syncProjectDefinitionAfterScopeMove(
      JSON.parse(readFileSync(active, "utf8")),
      active,
      join(vbrief, "completed", "only-title.xbrief.json"),
      vbrief,
      "completed",
    );
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8"));
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
            metadata: { source_path: "completed/x.xbrief.json", lifecycle_folder: "completed" },
          },
        ],
        references: [{ type: "x-vbrief/plan", uri: "completed/x.xbrief.json" }],
      },
    });
    const completed = join(vbrief, "completed", "2026-04-12-x.xbrief.json");
    mkdirSync(join(vbrief, "completed"), { recursive: true });
    writeFileSync(
      completed,
      formatBriefJson({ plan: { title: "Scope title", status: "completed", items: [] } }),
    );
    const data = JSON.parse(readFileSync(completed, "utf8"));
    syncProjectDefinitionAfterScopeMove(data, completed, completed, vbrief, "completed");
    const pd = JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8"));
    expect(pd.plan.items[0].metadata.lifecycle_folder).toBe("completed");
  });
});
