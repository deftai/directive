import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyIssueRefs,
  applyScalar,
  applySelect,
  applySince,
  applyTags,
  applyTriggers,
  collectTags,
  discoverPacks,
  formatListPacksText,
  formatListText,
  formatSliceText,
  getCloseMatches,
  isValidSince,
  listPacks,
  listSlices,
  loadDisplay,
  loadRegistry,
  loadSource,
  main,
  oneLine,
  PACK_REGISTRY,
  resolveDottedPath,
  resolvePack,
  sha256File,
  slicePack,
  UsageError,
} from "./packs-slice.js";

function writeFixturePack(root: string): [string, string] {
  const schema = {
    "x-sliceRegistry": {
      recent: {
        path: "lessons",
        filters: ["since"],
        description: "Lessons dated on or after --since.",
      },
      "by-tag": {
        path: "lessons",
        filters: ["tag"],
        description: "Lessons carrying any requested --tag.",
      },
    },
  };
  const source = {
    pack: "lessons-pack-0.1",
    version: "0.1",
    lessons: [
      {
        id: "old-windows",
        title: "Old Windows Lesson (2026-03)",
        date: "2026-03",
        issue_refs: [],
        tags: ["windows", "encoding"],
        source: "PR #1",
        body: "Body about cp1252.",
      },
      {
        id: "mid-swarm",
        title: "Mid Swarm Lesson (2026-05)",
        date: "2026-05",
        issue_refs: ["#42"],
        tags: ["swarm"],
        source: null,
        body: "Body about a swarm cohort.",
      },
      {
        id: "undated-debug",
        title: "Undated Debug Lesson (#99)",
        date: null,
        issue_refs: ["#99"],
        tags: ["debugging"],
        source: "issue #99",
        body: "Body about root-cause.",
      },
    ],
  };
  const schemaPath = join(root, "lessons-pack.schema.json");
  const sourcePath = join(root, "lessons-pack-0.1.json");
  writeFileSync(schemaPath, JSON.stringify(schema), "utf8");
  writeFileSync(sourcePath, JSON.stringify(source), "utf8");
  return [sourcePath, schemaPath];
}

function sliceLocal(sourcePath: string, schemaPath: string, name: string, options = {}) {
  const registry = loadRegistry(schemaPath);
  const data = loadSource(sourcePath);
  return slicePack(String(data.pack), name, registry, data, sourcePath, options);
}

describe("packsSlice filters", () => {
  it("filters recent by since", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const result = sliceLocal(sourcePath, schemaPath, "recent", { since: "2026-05" });
    expect(result.results.map((entry) => entry.id)).toEqual(["mid-swarm"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("excludes null-dated entries from recent", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-null-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const result = sliceLocal(sourcePath, schemaPath, "recent", { since: "2026-01" });
    const ids = result.results.map((entry) => entry.id);
    expect(ids).not.toContain("undated-debug");
    expect(ids).toEqual(["old-windows", "mid-swarm"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts full since date", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-date-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const result = sliceLocal(sourcePath, schemaPath, "recent", { since: "2026-05-15" });
    expect(result.results.map((entry) => entry.id)).toEqual(["mid-swarm"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects malformed since", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-bad-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    expect(() => sliceLocal(sourcePath, schemaPath, "recent", { since: "May2026" })).toThrow(
      UsageError,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("filters by tag", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-tag-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const result = sliceLocal(sourcePath, schemaPath, "by-tag", { tags: ["swarm"] });
    expect(result.results.map((entry) => entry.id)).toEqual(["mid-swarm"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("unions multiple tags", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-tags-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const result = sliceLocal(sourcePath, schemaPath, "by-tag", { tags: ["windows", "debugging"] });
    expect(new Set(result.results.map((entry) => entry.id))).toEqual(
      new Set(["old-windows", "undated-debug"]),
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("packsSlice formatting", () => {
  it("formats slice text with provenance header", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-fmt-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const result = sliceLocal(sourcePath, schemaPath, "by-tag", { tags: ["swarm"] });
    const text = formatSliceText(result);
    expect(text.startsWith("# pack: lessons-pack-0.1 | slice: by-tag |")).toBe(true);
    expect(text).toContain("## Mid Swarm Lesson (2026-05)");
    expect(text).toContain("Body about a swarm cohort.");
    rmSync(root, { recursive: true, force: true });
  });

  it("formats empty results", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-empty-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const result = sliceLocal(sourcePath, schemaPath, "by-tag", { tags: ["nonexistent-tag"] });
    expect(formatSliceText(result)).toContain("(no matching lessons)");
    rmSync(root, { recursive: true, force: true });
  });

  it("formats list text", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-list-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    const registry = loadRegistry(schemaPath);
    const payload = listSlices("lessons-pack-0.1", registry, sourcePath);
    const text = formatListText(payload);
    expect(text).toContain("by-tag");
    expect(text).toContain("[filters: since]");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("packsSlice helpers", () => {
  it("collectTags splits comma lists", () => {
    expect(collectTags(["windows,encoding", " swarm "])).toEqual(["windows", "encoding", "swarm"]);
    expect(collectTags([])).toEqual([]);
  });

  it("validates since linearly", () => {
    expect(isValidSince("2026-05")).toBe(true);
    expect(isValidSince("2026-05-15")).toBe(true);
    expect(isValidSince("May2026")).toBe(false);
    expect(isValidSince("202605")).toBe(false);
    expect(isValidSince("2026/05")).toBe(false);
    expect(isValidSince("2026-05-1")).toBe(false);
    expect(isValidSince("abcd-05")).toBe(false);
  });

  it("getCloseMatches suggests typos", () => {
    expect(getCloseMatches("recnt", ["recent", "by-tag"], 1)).toEqual(["recent"]);
    expect(getCloseMatches("lesson", ["lessons", "skills"], 1)).toEqual(["lessons"]);
  });

  it("resolveDottedPath guards missing segments", () => {
    const data = { a: { b: [1, 2, 3] } };
    expect(resolveDottedPath(data, "a.b")).toEqual([1, 2, 3]);
    expect(resolveDottedPath(data, "a.missing")).toBeNull();
    expect(resolveDottedPath(data, "a.b.c")).toBeNull();
  });

  it("sha256File hashes bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-sha-"));
    const path = join(root, "x.txt");
    writeFileSync(path, "hello", "utf8");
    expect(sha256File(path)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("applySince applyTags applyTriggers applyScalar", () => {
    expect(applySince([{ date: "2026-05" }, { date: null }], "2026-05")).toHaveLength(1);
    expect(applyTags([{ tags: ["a"] }, { tags: ["b"] }], ["a"])).toHaveLength(1);
    expect(applyTriggers([{ triggers: ["Build"] }], ["build"])).toHaveLength(1);
    expect(applyScalar([{ tier: "MUST" }, { tier: "must" }], "tier", ["MUST"])).toHaveLength(2);
  });

  it("applyIssueRefs normalizes hash prefix", () => {
    const entries = [
      { id: "a", issue_refs: ["#754"] },
      { id: "b", issue_refs: ["#810", "#42"] },
    ];
    expect(applyIssueRefs(entries, ["754"]).map((entry) => entry.id)).toEqual(["a"]);
    expect(applyIssueRefs(entries, ["#42"]).map((entry) => entry.id)).toEqual(["b"]);
  });

  it("applySelect handles tier_in and body_contains_any", () => {
    const entries = [
      { id: "a", tier: "MUST", body: "Anti-Pattern here" },
      { id: "b", tier: "MUST_NOT", body: "plain" },
    ];
    expect(applySelect(entries, { tier_in: ["MUST_NOT"] }).map((entry) => entry.id)).toEqual(["b"]);
    expect(
      applySelect(entries, { body_contains_any: ["anti-pattern"] }).map((entry) => entry.id),
    ).toEqual(["a"]);
    expect(applySelect(entries, {})).toEqual(entries);
  });

  it("oneLine collapses description", () => {
    expect(oneLine("First sentence. Second sentence.")).toBe("First sentence");
    expect(oneLine("  collapse   whitespace  ")).toBe("collapse whitespace");
    expect(oneLine("")).toBe("");
  });
});

describe("packsSlice discovery", () => {
  it("discovers fixture registry packs", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-disc-"));
    const packsDir = join(root, "packs");
    const schemasDir = join(root, "schemas");
    mkdirSync(join(packsDir, "lessons"), { recursive: true });
    mkdirSync(join(packsDir, "skills"), { recursive: true });
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(
      join(packsDir, "lessons", "lessons-pack-0.1.json"),
      JSON.stringify({ pack: "lessons-pack-0.1", version: "0.1", lessons: [] }),
      "utf8",
    );
    writeFileSync(
      join(schemasDir, "lessons-pack.schema.json"),
      JSON.stringify({ title: "Lessons Pack", description: "Captured lessons. More prose." }),
      "utf8",
    );
    writeFileSync(
      join(packsDir, "skills", "skills-pack-0.2.json"),
      JSON.stringify({ pack: "skills-pack-0.2", version: "0.2", skills: [] }),
      "utf8",
    );
    writeFileSync(
      join(schemasDir, "skills-pack.schema.json"),
      JSON.stringify({ title: "Skills Pack", description: "Reusable skills. Extra detail." }),
      "utf8",
    );
    const packs = discoverPacks(packsDir, schemasDir);
    expect(packs.map((pack) => pack.name)).toEqual(["lessons", "skills"]);
    const skills = packs.find((pack) => pack.name === "skills");
    expect(skills?.description).toBe("Reusable skills");
    const text = formatListPacksText(listPacks(packsDir, schemasDir));
    expect(text).toContain("Available content packs:");
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty list for missing dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-nodir-"));
    expect(discoverPacks(join(root, "nope"), join(root, "also-nope"))).toEqual([]);
    expect(formatListPacksText({ packs: [] })).toBe("No content packs found.\n");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("packsSlice errors", () => {
  it("unknown slice suggests correction", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-unk-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    try {
      sliceLocal(sourcePath, schemaPath, "recnt");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).suggestion).toBe("recent");
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unsupported filters", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-filter-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    expect(() => sliceLocal(sourcePath, schemaPath, "recent", { tags: ["swarm"] })).toThrow(
      /does not support/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("unknown pack suggests lessons", () => {
    expect(() => resolvePack("lesson")).toThrow(UsageError);
    try {
      resolvePack("lesson");
    } catch (error) {
      expect((error as UsageError).suggestion).toBe("lessons");
    }
  });

  it("loadRegistry and loadSource raise usage errors", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-load-"));
    expect(() => loadRegistry(join(root, "nope.json"))).toThrow(/schema not found/);
    expect(() => loadSource(join(root, "nope.json"))).toThrow(/source not found/);
    const schemaPath = join(root, "bad.schema.json");
    writeFileSync(schemaPath, JSON.stringify({}), "utf8");
    expect(() => loadRegistry(schemaPath)).toThrow(/x-sliceRegistry/);
    expect(loadDisplay(schemaPath)).toEqual(expect.objectContaining({ noun: "lessons" }));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("packsSlice main", () => {
  it("lists packs in text mode", () => {
    const stdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["--list-packs"])).toBe(0);
      expect(stdout.join("")).toContain("Available content packs:");
    } finally {
      process.stdout.write = original;
    }
  });

  it("requires pack name without list-packs", () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(main([])).toBe(2);
      expect(stderr.join("")).toContain("pack name is required");
    } finally {
      process.stderr.write = original;
    }
  });

  it("runs slice with patched registry", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-main-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    PACK_REGISTRY.lessons = { source: sourcePath, schema: schemaPath };
    const stdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["lessons", "recent", "--since", "2026-05"])).toBe(0);
      expect(stdout.join("")).toContain("Mid Swarm Lesson");
      expect(main(["lessons", "recnt"])).toBe(2);
    } finally {
      process.stdout.write = original;
      delete PACK_REGISTRY.lessons;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists slices for pack", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-listm-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    PACK_REGISTRY.lessons = { source: sourcePath, schema: schemaPath };
    const stdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["lessons", "--list"])).toBe(0);
      expect(stdout.join("")).toContain("recent");
    } finally {
      process.stdout.write = original;
      delete PACK_REGISTRY.lessons;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits json for list-packs, list, and slice", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-json-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    PACK_REGISTRY.lessons = { source: sourcePath, schema: schemaPath };
    const stdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["--list-packs", "--json"])).toBe(0);
      expect(JSON.parse(stdout.join(""))).toHaveProperty("packs");
      stdout.length = 0;
      expect(main(["lessons", "--list", "--format", "json"])).toBe(0);
      expect(JSON.parse(stdout.join(""))).toHaveProperty("slices");
      stdout.length = 0;
      expect(main(["lessons", "recent", "--since", "2026-05", "--json"])).toBe(0);
      expect(JSON.parse(stdout.join(""))).toHaveProperty("count", 1);
    } finally {
      process.stdout.write = original;
      delete PACK_REGISTRY.lessons;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces did-you-mean on unknown slice", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-suggest-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    PACK_REGISTRY.lessons = { source: sourcePath, schema: schemaPath };
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(main(["lessons", "recnt"])).toBe(2);
      expect(stderr.join("")).toContain("Did you mean 'recent'");
    } finally {
      process.stderr.write = original;
      delete PACK_REGISTRY.lessons;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported filters and bad since via main", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-filter-"));
    const [sourcePath, schemaPath] = writeFixturePack(root);
    PACK_REGISTRY.lessons = { source: sourcePath, schema: schemaPath };
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(main(["lessons", "recent", "--tag", "swarm"])).toBe(2);
      expect(stderr.join("")).toContain("does not support the --tag filter");
      stderr.length = 0;
      expect(main(["lessons", "recent", "--since", "May2026"])).toBe(2);
      expect(stderr.join("")).toContain("YYYY-MM");
    } finally {
      process.stderr.write = original;
      delete PACK_REGISTRY.lessons;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discoverPacks honors repoRoot for provenance paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pslice-disc-"));
    const packDir = join(root, "packs", "lessons");
    mkdirSync(join(root, "vbrief", "schemas"), { recursive: true });
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, "lessons-pack-0.1.json"),
      JSON.stringify({ pack: "lessons-pack-0.1", version: "0.1", lessons: [] }),
      "utf8",
    );
    writeFileSync(
      join(root, "vbrief", "schemas", "lessons-pack.schema.json"),
      JSON.stringify({ description: "Fixture pack." }),
      "utf8",
    );
    const packs = discoverPacks(join(root, "packs"), join(root, "vbrief", "schemas"), root);
    expect(packs[0]?.source).toBe("packs/lessons/lessons-pack-0.1.json");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("packsSlice real pack smoke", () => {
  it("reads committed lessons pack", () => {
    const [sourcePath, schemaPath] = resolvePack("lessons");
    expect(readFileSync(sourcePath, "utf8").length).toBeGreaterThan(0);
    const result = sliceLocal(sourcePath, schemaPath, "recent", { since: "2026-01" });
    expect(result.pack).toBe("lessons-pack-0.1");
    expect(result.count).toBeGreaterThan(0);
  });
});
