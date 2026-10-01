import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { exportSpec, parseExportSpecArgv } from "./export-spec.js";
import { generateRoadmapContent } from "./roadmap-render.js";
import {
  parseIncludeScopesFlag,
  renderImplementationPlanLines,
  renderSpecMarkdown,
  resolveItemDepthCap,
  tryParseItemDepthCap,
} from "./spec-render.js";
import {
  listNestedPlanItems,
  PLAN_ITEM_NESTED_KEYS,
  validateSpec,
  walkNestedPlanItems,
} from "./spec-validate.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const MAKE_SPEC_PATH = join(REPO_ROOT, "content", "templates", "make-spec.md");

type JsonObject = Record<string, unknown>;

function loadPinnedMakeSpecExample(): JsonObject {
  const text = readFileSync(MAKE_SPEC_PATH, "utf8");
  const fence = text.indexOf("```json");
  expect(fence).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("```", fence + 7);
  expect(end).toBeGreaterThan(fence);
  return JSON.parse(text.slice(fence + 7, end)) as JsonObject;
}

function renderablePinnedExample(): JsonObject {
  const spec = structuredClone(loadPinnedMakeSpecExample());
  const plan = spec.plan as JsonObject;
  plan.status = "approved";
  return spec;
}

function writeTempSpec(spec: unknown): { dir: string; specPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "deft-4511-"));
  temps.push(dir);
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec), "utf8");
  return { dir, specPath };
}

function nestedLeaf(spec: JsonObject): JsonObject {
  const plan = spec.plan as JsonObject;
  const phase = (plan.items as JsonObject[])[0] as JsonObject;
  const sub = (phase.items as JsonObject[])[0] as JsonObject;
  return (sub.items as JsonObject[])[0] as JsonObject;
}

describe("shared dual-key walker (#4511)", () => {
  it("exports items then subItems as the nested key pair", () => {
    expect([...PLAN_ITEM_NESTED_KEYS]).toEqual(["items", "subItems"]);
  });

  it("treats subItems as a fallback alias so both keys do not duplicate children", () => {
    const both: JsonObject = {
      items: [{ id: "preferred" }, "skip", null],
      subItems: [{ id: "legacy" }, 2],
    };
    expect(listNestedPlanItems(both).map((child) => String(child.id ?? ""))).toEqual(["preferred"]);
    expect(
      listNestedPlanItems({ subItems: [{ id: "legacy" }, 2] }).map((child) =>
        String(child.id ?? ""),
      ),
    ).toEqual(["legacy"]);
  });

  it("reports invalid collections to the validator callback", () => {
    const invalid: string[] = [];
    walkNestedPlanItems(
      { items: { not: "array" } },
      {
        onItem: () => {
          throw new Error("should not visit");
        },
        onInvalidCollection: (key) => invalid.push(key),
      },
    );
    expect(invalid).toEqual(["items"]);
  });

  it("reports invalid child entries", () => {
    const invalid: Array<readonly [string, number]> = [];
    walkNestedPlanItems(
      { items: ["nope"] },
      {
        onItem: () => {
          throw new Error("should not visit");
        },
        onInvalidEntry: (key, index) => invalid.push([key, index]),
      },
    );
    expect(invalid).toEqual([["items", 0]]);
  });
});

describe("pinned make-spec nested plan.items (#4511)", () => {
  it("renders Implementation Plan, ### phase, #### subphase, task bullet, Traces, and Acceptance", () => {
    const { specPath } = writeTempSpec(renderablePinnedExample());
    const result = renderSpecMarkdown(specPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const md = result.markdown;
    expect(md).toContain("## Implementation Plan");
    expect(md).toMatch(/^### Phase 1: Foundation/m);
    expect(md).toMatch(/^#### Subphase 1.1: Setup/m);
    expect(md).toMatch(/^- 1\.1\.1: Task description/m);
    expect(md).toContain("**Traces**: FR-1");
    expect(md).toMatch(/^\s*- \.\.\./m);
    expect(md.indexOf("## Implementation Plan")).toBeLessThan(
      md.indexOf("### Phase 1: Foundation"),
    );
    expect(md.indexOf("### Phase 1: Foundation")).toBeLessThan(
      md.indexOf("#### Subphase 1.1: Setup"),
    );
    expect(md.indexOf("#### Subphase 1.1: Setup")).toBeLessThan(
      md.indexOf("1.1.1: Task description"),
    );
  });

  it("keeps Depends on on the nested leaf alongside Traces and Acceptance", () => {
    const spec = renderablePinnedExample();
    nestedLeaf(spec).metadata = { dependencies: ["1.1"] };
    const { specPath } = writeTempSpec(spec);
    const result = renderSpecMarkdown(specPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("**Depends on**: 1.1");
    expect(result.markdown).toContain("**Traces**: FR-1");
    expect(result.markdown).toMatch(/^\s*- \.\.\./m);
  });

  it("fails closed when a parent declares both items and subItems", () => {
    const spec = renderablePinnedExample();
    const plan = spec.plan as JsonObject;
    const phase = (plan.items as JsonObject[])[0] as JsonObject;
    const sub = (phase.items as JsonObject[])[0] as JsonObject;
    sub.subItems = sub.items;
    const { specPath } = writeTempSpec(spec);
    const [ok, msg] = validateSpec(specPath);
    expect(ok).toBe(false);
    expect(msg).toMatch(/both items and subItems/);
    const rendered = renderSpecMarkdown(specPath);
    expect(rendered.ok).toBe(false);
  });

  it("walks deprecated subItems so the pinned leaf still survives", () => {
    const spec = renderablePinnedExample();
    const plan = spec.plan as JsonObject;
    const phase = (plan.items as JsonObject[])[0] as JsonObject;
    const sub = (phase.items as JsonObject[])[0] as JsonObject;
    const tasks = sub.items;
    delete sub.items;
    sub.subItems = tasks;
    const { specPath } = writeTempSpec(spec);
    const result = renderSpecMarkdown(specPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("1.1.1: Task description");
    expect(result.markdown).toContain("**Traces**: FR-1");
  });
});

describe("item-depth cap (#4511)", () => {
  it("defaults to 3 and rejects unknown tokens", () => {
    expect(tryParseItemDepthCap("3")).toBe(3);
    expect(tryParseItemDepthCap("off")).toBeUndefined();
    expect(tryParseItemDepthCap("0")).toBeUndefined();
    expect(tryParseItemDepthCap("all")).toBeUndefined();
    expect(resolveItemDepthCap(undefined).ok).toBe(true);
    expect(resolveItemDepthCap(3)).toEqual({ ok: true, cap: 3 });
    expect(resolveItemDepthCap(0).ok).toBe(false);
    expect(resolveItemDepthCap("2")).toEqual({ ok: true, cap: 2 });
    expect(parseIncludeScopesFlag(["spec.json"]).itemDepthCap).toBe(3);
    expect(parseIncludeScopesFlag(["--item-depth=4", "spec.json"]).itemDepthCap).toBe(4);
    const missing = parseIncludeScopesFlag(["--item-depth", "spec.json"]);
    expect(missing.errors.some((e) => e.includes("Missing --item-depth"))).toBe(true);
    const bad = parseIncludeScopesFlag(["--item-depth=off", "spec.json"]);
    expect(bad.errors.some((e) => e.includes("Invalid --item-depth=off"))).toBe(true);
    const exportBad = parseExportSpecArgv(["--item-depth=nope"]);
    expect(exportBad.errors.some((e) => e.includes("Invalid --item-depth=nope"))).toBe(true);
    expect(
      parseExportSpecArgv(["--item-depth"]).errors.some((e) => e.includes("Missing --item-depth")),
    ).toBe(true);
    expect(renderImplementationPlanLines("not-array", 3)).toEqual([]);
  });

  it("announces truncation instead of silently dropping deeper items", () => {
    const spec = renderablePinnedExample();
    nestedLeaf(spec).items = [{ id: "1.1.1.1", title: "Too deep", status: "pending" }];
    const { specPath } = writeTempSpec(spec);
    const result = renderSpecMarkdown(specPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("1.1.1: Task description");
    expect(result.markdown).not.toContain("Too deep");
    expect(result.markdown).toMatch(/truncated at depth 3 \(phase, subphase, task\)/i);
  });

  it("returns a fail-closed error for an unknown cap on the render path", () => {
    const { specPath } = writeTempSpec(renderablePinnedExample());
    const result = renderSpecMarkdown(specPath, { itemDepthCap: "off" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/item-depth/i);
  });

  it("announces a non-default cap without the phase/subphase/task gloss", () => {
    const spec = renderablePinnedExample();
    const { specPath } = writeTempSpec(spec);
    const result = renderSpecMarkdown(specPath, { itemDepthCap: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("#### Subphase 1.1: Setup");
    expect(result.markdown).not.toContain("1.1.1: Task description");
    expect(result.markdown).toMatch(/truncated at depth 2/);
    expect(result.markdown).not.toMatch(/phase, subphase, task/);
  });

  it("renders array and string narrative plus a leaf without id", () => {
    const lines = renderImplementationPlanLines(
      [
        {
          id: "p",
          title: "Phase",
          status: "pending",
          items: [
            {
              title: "No id task",
              status: "pending",
              items: [
                { title: "Leaf", status: "pending", narrative: ["one", "two"] },
                { title: "Prose", status: "pending", narrative: "plain\nbreak" },
                {
                  title: "Other key",
                  status: "pending",
                  narrative: { Notes: "keep" },
                  dependencies: ["p"],
                },
              ],
            },
          ],
        },
      ],
      3,
    );
    const md = lines.join("\n");
    expect(md).toContain("- Leaf");
    expect(md).toContain("- one");
    expect(md).toContain("plain break");
    expect(md).not.toMatch(/plain\nbreak/);
    expect(md).toContain("keep");
    expect(md).toContain("**Depends on**: p");
  });
});

describe("exportSpec nested-on default (#4511)", () => {
  it("fails closed on an unknown item-depth token before export", () => {
    const [ok, msg] = exportSpec({ itemDepthCap: "off" });
    expect(ok).toBe(false);
    expect(msg).toMatch(/item-depth/i);
  });

  it("emits the pinned tree on the no-flag full-spec path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4511-export-"));
    temps.push(root);
    const vbrief = join(root, "xbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "PD overview" },
          items: [],
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify(renderablePinnedExample()),
      "utf8",
    );
    const out = join(root, "SPECIFICATION.md");
    const [ok, msg] = exportSpec({ projectRoot: root, outPath: out });
    expect(ok).toBe(true);
    expect(msg).toContain("Exported spec");
    expect(existsSync(out)).toBe(true);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("## Implementation Plan");
    expect(md).toMatch(/^### Phase 1: Foundation/m);
    expect(md).toMatch(/^#### Subphase 1.1: Setup/m);
    expect(md).toContain("1.1.1: Task description");
    expect(md).toContain("**Traces**: FR-1");
  });
});

describe("roadmap-render consumes the dual-key walker (#4511)", () => {
  it("renders nested children authored with preferred items", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-4511-roadmap-"));
    temps.push(root);
    const pending = join(root, "xbrief", "pending");
    mkdirSync(pending, { recursive: true });
    mkdirSync(join(root, "xbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(pending, "2026-01-01-nested.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Nested items scope",
          status: "pending",
          items: [
            {
              id: "phase-1",
              title: "Phase 1",
              status: "pending",
              items: [{ id: "task-a", title: "Preferred nested task", status: "pending" }],
            },
          ],
        },
      }),
      "utf8",
    );
    const md = generateRoadmapContent(pending);
    expect(md).toContain("Preferred nested task");
  });
});
