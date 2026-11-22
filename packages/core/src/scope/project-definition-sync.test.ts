import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncProjectDefinitionAfterScopeMove } from "./project-definition-sync.js";
import { syncRegistryArtifactAfterScopeMove } from "./registry-artifact-sync.js";
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

  it("matches rows by source_path or filename stem only; references and title never match", () => {
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
    // source_path row and filename-stem row are removed; the references-only row stays (#6648).
    expect(pd.plan.items.map((i: { id: string }) => i.id)).toEqual(["other-id"]);
    expect(pd.plan.items[0].status).toBe("running");
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

  it("a row that matches by title only is left alone", () => {
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
    expect(pd.plan.items).toHaveLength(1);
    expect(pd.plan.items[0].status).toBe("running");
    expect(pd.plan.items[0].metadata).toBeUndefined();
  });

  it("removes the row when a completed scope is synced again", () => {
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
    expect(pd.plan.items).toEqual([]);
  });
});

describe("project-definition-sync open-only rows (#6648)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  const row = (id: string, title: string, folder: string, file = `${id}.xbrief.json`) => ({
    id,
    title,
    status: folder === "proposed" ? "proposed" : "running",
    metadata: { source_path: `${folder}/${file}`, lifecycle_folder: folder },
  });

  function setup(items: unknown[], files: Array<[string, string, Record<string, unknown>]>) {
    root = mkdtempSync(join(tmpdir(), "pd-open-"));
    const vbrief = join(root, "xbrief");
    for (const f of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, f), { recursive: true });
    }
    for (const [folder, name, plan] of files) {
      writeFileSync(join(vbrief, folder, name), formatBriefJson({ plan }));
    }
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
      formatBriefJson({ plan: { title: "P", status: "running", items, references: [] } }),
    );
    return vbrief;
  }

  const readPd = (vbrief: string) =>
    JSON.parse(readFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8"));

  it("scope:complete removes only the moved scope's row", () => {
    const vbrief = setup(
      [row("2026-01-01-a", "A", "active"), row("2026-01-01-b", "B", "active")],
      [["completed", "2026-01-01-a.xbrief.json", { title: "A", status: "completed" }]],
    );
    const before = readPd(vbrief).plan.items[1];
    syncProjectDefinitionAfterScopeMove(
      { plan: { title: "A" } },
      join(vbrief, "active", "2026-01-01-a.xbrief.json"),
      join(vbrief, "completed", "2026-01-01-a.xbrief.json"),
      vbrief,
      "completed",
    );
    expect(readPd(vbrief).plan.items).toEqual([before]);
  });

  it("removes only the row for the moved file when two rows share a title", () => {
    for (const [folder, status] of [
      ["completed", "completed"],
      ["cancelled", "cancelled"],
    ] as const) {
      const vbrief = setup(
        [row("2026-01-01-one", "Same", "active"), row("2026-01-01-two", "Same", "active")],
        [[folder, "2026-01-01-one.xbrief.json", { title: "Same", status }]],
      );
      syncProjectDefinitionAfterScopeMove(
        { plan: { title: "Same" } },
        join(vbrief, "active", "2026-01-01-one.xbrief.json"),
        join(vbrief, folder, "2026-01-01-one.xbrief.json"),
        vbrief,
        status,
      );
      expect(readPd(vbrief).plan.items.map((i: { id: string }) => i.id)).toEqual([
        "2026-01-01-two",
      ]);
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
  });

  const readPdText = (vbrief: string) =>
    readFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "utf8");

  it("restore inserts no row (#6872)", () => {
    const vbrief = setup(
      [],
      [["proposed", "2026-01-01-r.xbrief.json", { title: "Restored", status: "proposed" }]],
    );
    const before = readPdText(vbrief);
    syncProjectDefinitionAfterScopeMove(
      { plan: { title: "Restored" } },
      join(vbrief, "cancelled", "2026-01-01-r.xbrief.json"),
      join(vbrief, "proposed", "2026-01-01-r.xbrief.json"),
      vbrief,
      "proposed",
    );
    expect(readPdText(vbrief)).toBe(before);
    expect(readPd(vbrief).plan.items).toEqual([]);
  });

  it("promote leaves the matched row unchanged (#6872)", () => {
    const vbrief = setup(
      [row("2026-01-01-p", "P", "proposed")],
      [["pending", "2026-01-01-p.xbrief.json", { title: "P", status: "pending" }]],
    );
    const before = readPdText(vbrief);
    syncProjectDefinitionAfterScopeMove(
      { plan: { title: "P" } },
      join(vbrief, "proposed", "2026-01-01-p.xbrief.json"),
      join(vbrief, "pending", "2026-01-01-p.xbrief.json"),
      vbrief,
      "pending",
    );
    expect(readPdText(vbrief)).toBe(before);
    expect(readPd(vbrief).plan.items).toEqual([row("2026-01-01-p", "P", "proposed")]);
  });

  it("promote and activate with no reference to the brief leave PROJECT-DEFINITION byte-identical (#6872)", () => {
    for (const items of [[], [row("2026-01-01-a", "A", "proposed")]]) {
      const vbrief = setup(items, [
        ["active", "2026-01-01-a.xbrief.json", { title: "A", status: "running" }],
      ]);
      const before = readPdText(vbrief);
      for (const [from, to, status] of [
        ["proposed", "pending", "pending"],
        ["pending", "active", "running"],
      ] as const) {
        expect(
          syncProjectDefinitionAfterScopeMove(
            { plan: { title: "A" } },
            join(vbrief, from, "2026-01-01-a.xbrief.json"),
            join(vbrief, to, "2026-01-01-a.xbrief.json"),
            vbrief,
            status,
          ),
        ).toBeNull();
        expect(readPdText(vbrief)).toBe(before);
      }
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
  });

  it("a top-level reference follows the brief through every move; the row goes at completion (#6872)", () => {
    for (const prefix of ["", "file://"]) {
      const vbrief = setup([row("2026-01-01-t", "T", "proposed")], []);
      const pdPath = join(vbrief, "PROJECT-DEFINITION.xbrief.json");
      const pd = readPd(vbrief);
      pd.plan.references = [
        { type: "x-vbrief/plan", uri: `${prefix}proposed/2026-01-01-t.xbrief.json` },
      ];
      writeFileSync(pdPath, formatBriefJson(pd));
      const steps = [
        ["proposed", "pending", "pending"],
        ["pending", "active", "running"],
        ["active", "completed", "completed"],
      ] as const;
      writeFileSync(
        join(vbrief, "proposed", "2026-01-01-t.xbrief.json"),
        formatBriefJson({ plan: { title: "T", status: "proposed" } }),
      );
      for (const [from, to, status] of steps) {
        // The transition moves the file before it syncs PROJECT-DEFINITION.
        writeFileSync(
          join(vbrief, to, "2026-01-01-t.xbrief.json"),
          formatBriefJson({ plan: { title: "T", status } }),
        );
        rmSync(join(vbrief, from, "2026-01-01-t.xbrief.json"));
        syncProjectDefinitionAfterScopeMove(
          { plan: { title: "T" } },
          join(vbrief, from, "2026-01-01-t.xbrief.json"),
          join(vbrief, to, "2026-01-01-t.xbrief.json"),
          vbrief,
          status,
        );
        const after = readPd(vbrief);
        expect(after.plan.references).toEqual([
          { type: "x-vbrief/plan", uri: `${prefix}${to}/2026-01-01-t.xbrief.json` },
        ]);
        // Open moves insert and patch no row; the terminal move removes it.
        expect(after.plan.items).toEqual(
          to === "completed" ? [] : [row("2026-01-01-t", "T", "proposed")],
        );
      }
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
  });

  it("does not remove a row whose id is the dateless remainder and has another source_path", () => {
    const vbrief = setup(
      [row("slug", "Other scope", "active", "2026-02-02-other.xbrief.json")],
      [["completed", "2026-01-01-slug.xbrief.json", { title: "Slug", status: "completed" }]],
    );
    syncProjectDefinitionAfterScopeMove(
      { plan: { title: "Slug" } },
      join(vbrief, "active", "2026-01-01-slug.xbrief.json"),
      join(vbrief, "completed", "2026-01-01-slug.xbrief.json"),
      vbrief,
      "completed",
    );
    expect(readPd(vbrief).plan.items.map((i: { id: string }) => i.id)).toEqual(["slug"]);
  });

  it("an open move with no matching row and no file on disk inserts nothing", () => {
    const vbrief = setup([], []);
    syncProjectDefinitionAfterScopeMove(
      { plan: { title: "Ghost" } },
      join(vbrief, "proposed", "ghost.xbrief.json"),
      join(vbrief, "pending", "ghost.xbrief.json"),
      vbrief,
      "pending",
    );
    expect(readPd(vbrief).plan.items).toEqual([]);
  });

  it("the specification registry sync still patches rows and never removes or inserts", () => {
    const vbrief = setup([], []);
    const specPath = join(vbrief, "specification.xbrief.json");
    const spec = {
      plan: {
        title: "S",
        items: [
          { id: "2026-01-01-s", title: "S", status: "running", metadata: {} },
          { id: "other", title: "Move me", status: "running" },
        ],
      },
    };
    writeFileSync(specPath, formatBriefJson(spec));
    syncRegistryArtifactAfterScopeMove(
      specPath,
      { plan: { title: "Move me" } },
      join(vbrief, "active", "2026-01-01-s.xbrief.json"),
      join(vbrief, "completed", "2026-01-01-s.xbrief.json"),
      vbrief,
      "completed",
    );
    const items = JSON.parse(readFileSync(specPath, "utf8")).plan.items;
    expect(items).toHaveLength(2);
    expect(items.map((i: { status: string }) => i.status)).toEqual(["completed", "completed"]);
  });
});
