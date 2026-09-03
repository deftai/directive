import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodebaseMap } from "./default-extractor.js";
import { expandModuleGlobs } from "./glob-files.js";

function dogfoodRecord(): Record<string, unknown> {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "xbrief/PROJECT-DEFINITION.xbrief.json"), "utf8"),
  ) as Record<string, unknown>;
  const plan = raw.plan as Record<string, unknown>;
  const architecture = plan.architecture as Record<string, unknown>;
  return architecture.codeStructure as Record<string, unknown>;
}

function moduleById(record: Record<string, unknown>, id: string): Record<string, unknown> {
  const modules = record.modules as Record<string, unknown>[];
  const found = modules.find((mod) => mod.id === id);
  if (found === undefined) {
    throw new Error(`missing module ${id}`);
  }
  return found;
}

describe("default extractor content-module membership (#4088)", () => {
  const root = process.cwd();
  const record = dogfoodRecord();

  it("framework-content covers content/ guidance stems and not root repo-dev trees", () => {
    const globs = moduleById(record, "framework-content").pathGlobs as string[];
    const files = new Set(expandModuleGlobs(root, globs).files);
    expect(files.has("content/skills/deft-directive-build/SKILL.md")).toBe(true);
    expect(files.has("content/coding/coding.md")).toBe(true);
    expect(files.has("content/docs/getting-started.md")).toBe(true);
    expect(files.has("content/QUICK-START.md")).toBe(true);
    expect(files.has("AGENTS.md")).toBe(true);
    expect(files.has("docs/ARCHITECTURE.md")).toBe(false);
    expect(files.has("meta/ideas.md")).toBe(false);
    expect([...files].some((path) => path.startsWith("incidents/"))).toBe(false);
    expect([...files].some((path) => path.startsWith("content/.agents/"))).toBe(false);
    expect([...files].some((path) => path.startsWith("content/packs/"))).toBe(false);
    expect(globs.some((glob) => glob.startsWith("docs/"))).toBe(false);
    expect(globs.some((glob) => glob.startsWith("meta/"))).toBe(false);
    expect(globs.some((glob) => glob.startsWith("incidents/"))).toBe(false);
  });

  it("content-packs matches tracked JSON under content/packs only", () => {
    const globs = moduleById(record, "content-packs").pathGlobs as string[];
    expect(globs).toEqual(["content/packs/**/*.json"]);
    const files = expandModuleGlobs(root, globs).files;
    expect(files.some((path) => path.startsWith("content/packs/") && path.endsWith(".json"))).toBe(
      true,
    );
    expect(files.some((path) => path.endsWith(".md"))).toBe(false);
  });

  it("MAP extractor and expander agree on module membership", () => {
    const artifact = buildCodebaseMap(root);
    const modules = artifact.modules as Record<string, unknown>[];
    const packs = modules.find((mod) => mod.id === "content-packs");
    const guidance = modules.find((mod) => mod.id === "framework-content");
    if (packs === undefined || guidance === undefined) {
      throw new Error("expected dogfood modules");
    }
    const packFiles = expandModuleGlobs(
      root,
      moduleById(record, "content-packs").pathGlobs as string[],
    ).files;
    const guidanceFiles = expandModuleGlobs(
      root,
      moduleById(record, "framework-content").pathGlobs as string[],
    ).files;
    expect(packs.fileCount).toBe(packFiles.length);
    expect(guidance.fileCount).toBe(guidanceFiles.length);
    expect(packFiles.length).toBeGreaterThan(0);
    expect(guidanceFiles.length).toBeGreaterThan(0);
  });
});
