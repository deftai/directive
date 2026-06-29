import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  listSlices,
  main,
  oneLine,
  resolveDottedPath,
  slicePack,
  UsageError,
} from "./packs-slice.js";

// Branch-coverage sweep for the pure helpers and CLI paths of packs-slice (#2083 follow-up:
// restore the vitest branch threshold to 85 after the parity-harness denominator shift).

describe("packs-slice isValidSince branches", () => {
  it("accepts YYYY-MM and YYYY-MM-DD, rejects malformed and wrong-length", () => {
    expect(isValidSince("2026-06")).toBe(true);
    expect(isValidSince("2026-06-29")).toBe(true);
    expect(isValidSince("2026/06")).toBe(false);
    expect(isValidSince("20260629")).toBe(false);
    expect(isValidSince("2026-6")).toBe(false);
    expect(isValidSince("2026-06-2x")).toBe(false);
    expect(isValidSince("202x-06")).toBe(false);
  });
});

describe("packs-slice getCloseMatches branches", () => {
  it("returns empty when nothing clears the cutoff", () => {
    expect(getCloseMatches("zzzzz", ["alpha", "beta"], 1, 0.6)).toEqual([]);
  });
  it("treats two empty strings as a perfect match", () => {
    expect(getCloseMatches("", [""], 1, 0.6)).toEqual([""]);
  });
  it("ranks the closest candidate first", () => {
    expect(getCloseMatches("recent", ["recents", "tagged"], 1)).toEqual(["recents"]);
  });
});

describe("packs-slice resolveDottedPath branches", () => {
  it("returns null when a segment is missing", () => {
    expect(resolveDottedPath({ a: { b: 1 } }, "a.c")).toBeNull();
  });
  it("returns null when descending into a non-object", () => {
    expect(resolveDottedPath({ a: 5 }, "a.b")).toBeNull();
    expect(resolveDottedPath([1, 2], "0.x")).toBeNull();
  });
  it("resolves a nested value", () => {
    expect(resolveDottedPath({ a: { b: 7 } }, "a.b")).toBe(7);
  });
});

describe("packs-slice filter helpers non-array + match branches", () => {
  it("applySince keeps entries on or after the month", () => {
    const rows = [{ date: "2026-06-01" }, { date: "2026-05-01" }, { date: "" }, { other: 1 }];
    expect(applySince(rows, "2026-06-15")).toEqual([{ date: "2026-06-01" }]);
  });
  it("applyTags drops non-array tags and keeps matches", () => {
    const rows = [{ tags: ["a"] }, { tags: "a" }, { tags: ["b"] }];
    expect(applyTags(rows, ["a"])).toEqual([{ tags: ["a"] }]);
  });
  it("applyTriggers is case-insensitive and drops non-array triggers", () => {
    const rows = [{ triggers: ["Foo"] }, { triggers: null }, { triggers: ["bar"] }];
    expect(applyTriggers(rows, ["foo"])).toEqual([{ triggers: ["Foo"] }]);
  });
  it("applyScalar matches a scalar field case-insensitively", () => {
    const rows = [{ tier: "T1" }, { tier: "t2" }, {}];
    expect(applyScalar(rows, "tier", ["t1"])).toEqual([{ tier: "T1" }]);
  });
  it("applyIssueRefs normalizes # and drops non-array refs", () => {
    const rows = [{ issue_refs: ["#42"] }, { issue_refs: 42 }, { issue_refs: ["7"] }];
    expect(applyIssueRefs(rows, ["42"])).toEqual([{ issue_refs: ["#42"] }]);
  });
});

describe("packs-slice applySelect branches", () => {
  it("filters by tier_in", () => {
    const rows = [{ tier: "a" }, { tier: "b" }];
    expect(applySelect(rows, { tier_in: ["a"] })).toEqual([{ tier: "a" }]);
  });
  it("filters by body_contains_any", () => {
    const rows = [{ body: "hello world" }, { body: "goodbye" }];
    expect(applySelect(rows, { body_contains_any: ["WORLD"] })).toEqual([{ body: "hello world" }]);
  });
  it("ignores empty/absent select clauses", () => {
    const rows = [{ tier: "a" }];
    expect(applySelect(rows, { tier_in: [], body_contains_any: [] })).toEqual(rows);
    expect(applySelect(rows, {})).toEqual(rows);
  });
});

describe("packs-slice slicePack branches", () => {
  let srcPath: string;
  let srcDir: string;
  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), "deft-packs-slice-"));
    srcPath = join(srcDir, "src.json");
    writeFileSync(srcPath, JSON.stringify({ pack: "lessons" }));
  });
  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
  });
  const registry = {
    recent: {
      path: "items",
      filters: ["since", "tag", "trigger", "tier", "domain", "issue", "id"],
    },
    plain: { path: "items", filters: [] },
    selected: { path: "items", filters: [], select: { tier_in: ["x"] } },
    nofilters: { path: "items" },
  };
  const source = {
    items: [
      {
        date: "2026-06-01",
        tags: ["t"],
        triggers: ["go"],
        tier: "x",
        domain: "d",
        issue_refs: ["#1"],
        id: "id1",
      },
    ],
  };

  it("throws on an unknown slice with a suggestion", () => {
    try {
      slicePack("lessons", "recnt", registry, source, "/tmp/src.json");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).suggestion).toBe("recent");
    }
  });

  it("rejects an unsupported filter for the slice", () => {
    expect(() =>
      slicePack("lessons", "plain", registry, source, "/tmp/src.json", { tags: ["t"] }),
    ).toThrow(/does not support the --tag filter/);
  });

  it("rejects a malformed --since", () => {
    expect(() =>
      slicePack("lessons", "recent", registry, source, "/tmp/src.json", { since: "bad" }),
    ).toThrow(/--since must be YYYY-MM/);
  });

  it("applies every filter and a select clause", () => {
    const result = slicePack("lessons", "recent", registry, source, srcPath, {
      since: "2026-06",
      tags: ["t"],
      triggers: ["go"],
      tiers: ["x"],
      domains: ["d"],
      issues: ["1"],
      ids: ["id1"],
    });
    expect(result.count).toBe(1);
    expect(result.slice).toBe("recent");
  });

  it("treats a non-array path result and missing filters spec as empty defaults", () => {
    const result = slicePack("lessons", "selected", registry, { items: "nope" }, srcPath);
    expect(result.count).toBe(0);
  });

  it("handles a slice whose filters key is absent", () => {
    const result = slicePack("lessons", "nofilters", registry, source, srcPath);
    expect(result.count).toBe(1);
  });
});

describe("packs-slice formatting branches", () => {
  it("formatListPacksText handles the empty case", () => {
    expect(formatListPacksText({ packs: [] })).toBe("No content packs found.\n");
    expect(formatListPacksText({})).toBe("No content packs found.\n");
  });

  it("formatSliceText renders no-results, fields, and bodies", () => {
    const empty = formatSliceText({
      pack: "p",
      slice: "s",
      source: "src",
      source_sha: "sha",
      count: 0,
      results: [],
    });
    expect(empty).toContain("(no matching");

    const rendered = formatSliceText(
      {
        pack: "p",
        slice: "s",
        source: "src",
        source_sha: "sha",
        count: 1,
        results: [{ title: "T", tags: ["a", "b"], skipMe: "", empty: [], body: "B" }],
      },
      { heading: "title", fields: ["tags", "skipMe", "empty"], body: "body", noun: "items" },
    );
    expect(rendered).toContain("- tags: a, b");
    expect(rendered).not.toContain("skipMe");
    expect(rendered).toContain("\nB\n");
  });

  it("formatSliceText with a null body field and no display fields", () => {
    const rendered = formatSliceText(
      {
        pack: "p",
        slice: "s",
        source: "src",
        source_sha: "sha",
        count: 1,
        results: [{ title: "T" }],
      },
      { heading: "title", fields: [], body: null, noun: "items" },
    );
    expect(rendered).toContain("## T");
  });

  it("formatListText handles empty and populated slice lists", () => {
    expect(formatListText({ pack: "p", source: "src", slices: [] })).toContain("Slices for pack p");
    const withSlices = formatListText({
      pack: "p",
      source: "src",
      slices: [
        { name: "a", description: "d", filters: ["since"] },
        { name: "bb", description: "e", filters: [] },
      ],
    });
    expect(withSlices).toContain("[filters: since]");
    expect(withSlices).toContain("[filters: none]");
  });
});

describe("packs-slice oneLine + collectTags branches", () => {
  it("oneLine folds whitespace and trims a trailing period", () => {
    expect(oneLine("Hello   world. Extra.")).toBe("Hello world");
    expect(oneLine("   ")).toBe("");
  });
  it("collectTags splits, trims, lowercases, and drops empties", () => {
    expect(collectTags(["A, b", " ,c ", ""])).toEqual(["a", "b", "c"]);
  });
});

describe("packs-slice discoverPacks branches", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deft-packs-branch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when the packs dir is missing", () => {
    expect(discoverPacks(join(root, "absent"), join(root, "schemas"))).toEqual([]);
  });

  it("skips non-directories, json-less dirs, and unparseable sources", () => {
    const packsDir = join(root, "packs");
    const schemasDir = join(root, "schemas");
    mkdirSync(packsDir, { recursive: true });
    mkdirSync(schemasDir, { recursive: true });
    writeFileSync(join(packsDir, "loose.txt"), "x"); // non-directory entry
    mkdirSync(join(packsDir, "empty")); // no json
    mkdirSync(join(packsDir, "broken"));
    writeFileSync(join(packsDir, "broken", "p.json"), "{not json"); // parse failure
    mkdirSync(join(packsDir, "good"));
    writeFileSync(
      join(packsDir, "good", "p.json"),
      JSON.stringify({ pack: "goodpack", version: "1.0" }),
    );
    writeFileSync(
      join(schemasDir, "good-pack.schema.json"),
      JSON.stringify({ title: "Good. Pack." }),
    );
    mkdirSync(join(packsDir, "badschema"));
    writeFileSync(join(packsDir, "badschema", "p.json"), JSON.stringify({ pack: "bs" }));
    writeFileSync(join(schemasDir, "badschema-pack.schema.json"), "{nope");

    const packs = discoverPacks(packsDir, schemasDir, root);
    const names = packs.map((p) => p.name);
    expect(names).toContain("good");
    expect(names).toContain("badschema");
    expect(names).not.toContain("empty");
    expect(names).not.toContain("broken");
    const good = packs.find((p) => p.name === "good");
    expect(good?.description).toBe("Good");
    const bad = packs.find((p) => p.name === "badschema");
    expect(bad?.description).toBe("");
  });
});

describe("packs-slice listSlices defaults", () => {
  it("falls back to empty description/filters", () => {
    const payload = listSlices("lessons", { a: {} }, PACK_SOURCE);
    const slices = payload.slices as Array<Record<string, unknown>>;
    expect(slices[0]).toMatchObject({ name: "a", description: "", filters: [] });
  });
});

const PACK_SOURCE = join(mkdtempSync(join(tmpdir(), "deft-packs-src-")), "src.json");
writeFileSync(PACK_SOURCE, JSON.stringify({ pack: "lessons" }));

describe("packs-slice main CLI branches", () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("lists packs as text and json", () => {
    expect(main(["--list-packs"])).toBe(0);
    expect(main(["--list-packs", "--json"])).toBe(0);
  });

  it("errors with exit 2 when no pack is given", () => {
    expect(main([])).toBe(2);
    expect(errSpy).toHaveBeenCalled();
  });

  it("errors with a did-you-mean suggestion for an unknown pack", () => {
    expect(main(["lesson"])).toBe(2);
    const msg = String(outSpy.mock.calls.concat(errSpy.mock.calls).flat().join(""));
    expect(msg).toContain("Did you mean");
  });

  it("lists slices for the real lessons pack as text and json", () => {
    expect(main(["lessons", "--list"])).toBe(0);
    expect(main(["lessons", "--list", "--json"])).toBe(0);
  });

  it("errors with exit 2 when a slice name is missing", () => {
    expect(main(["lessons"])).toBe(2);
  });
});

describe("packs-slice parseCliArgs via main flag coverage", () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("accepts both space and = forms of every flag without throwing", () => {
    // An unknown pack short-circuits before slicing, but parseCliArgs still walks every branch.
    const argvForms = [
      ["nope", "--since", "2026-06", "--tag", "a", "--trigger", "b", "--tier", "c"],
      ["nope", "--domain", "d", "--issue", "1", "--id", "x", "--format", "json"],
      [
        "nope",
        "--since=2026-06",
        "--tag=a",
        "--trigger=b",
        "--tier=c",
        "--domain=d",
        "--issue=1",
        "--id=x",
        "--format=text",
      ],
    ];
    for (const argv of argvForms) {
      expect(main(argv)).toBe(2);
    }
  });
});
