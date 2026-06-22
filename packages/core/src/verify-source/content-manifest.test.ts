import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateContentManifest,
  lintManifest,
  listTrackedContentChildren,
  loadManifest,
} from "./content-manifest.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

function makeManifest(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    version: 2,
    buckets: [
      { id: "content", label: "Content", description: "ships" },
      { id: "engine", label: "Engine", description: "runtime" },
      { id: "harness", label: "Harness", description: "build" },
      { id: "repo-dev", label: "Repo-dev", description: "maintainer" },
    ],
    entries,
  });
}

describe("evaluateContentManifest (location invariant, #1875)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 when the location invariant holds (content under content/, harness exception at root)", () => {
    root = mkdtempSync(join(tmpdir(), "cm-clean-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "content/skills", bucket: "content", note: "skills" },
        { path: "content/LICENSE.md", bucket: "content", note: "license", straddle: true },
        { path: "AGENTS.md", bucket: "content", note: "harness", harnessEntry: true },
        { path: "packages", bucket: "engine", note: "engine" },
      ]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: ["content/LICENSE.md", "content/skills"],
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("location invariant holds");
    expect(result.message).toContain("2 content/ child(ren)");
  });

  it("exits 1 on a content entry that is NOT under content/", () => {
    root = mkdtempSync(join(tmpdir(), "cm-notcontent-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "skills", bucket: "content", note: "skills" }]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: [],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("content entry 'skills' must live under content/");
  });

  it("exits 1 on a non-content entry that lives UNDER content/", () => {
    root = mkdtempSync(join(tmpdir(), "cm-noncontent-under-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "content/skills", bucket: "content", note: "skills" },
        { path: "content/packages", bucket: "engine", note: "misplaced engine" },
      ]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: ["content/skills"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("non-content entry 'content/packages'");
    expect(result.message).toContain("must not live under content/");
  });

  it("exits 1 on an unclassified content/ child", () => {
    root = mkdtempSync(join(tmpdir(), "cm-unclassified-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "content/skills", bucket: "content", note: "skills" }]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: ["content/skills", "content/brand-new-dir"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("unclassified content/ child 'content/brand-new-dir'");
  });

  it("exits 1 on a stale content entry pointing at a removed content/ child", () => {
    root = mkdtempSync(join(tmpdir(), "cm-stale-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "content/skills", bucket: "content", note: "skills" },
        { path: "content/gone", bucket: "content", note: "removed" },
      ]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: ["content/skills"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("stale content entry 'content/gone'");
  });

  it("treats harness-entry exceptions as clean even with no content/ child for them", () => {
    root = mkdtempSync(join(tmpdir(), "cm-harness-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "AGENTS.md", bucket: "content", note: "harness", harnessEntry: true },
        { path: "main.md", bucket: "content", note: "harness", harnessEntry: true },
        { path: "SKILL.md", bucket: "content", note: "harness", harnessEntry: true },
        { path: "content/skills", bucket: "content", note: "skills" },
      ]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: ["content/skills"],
    });
    expect(result.code).toBe(0);
  });

  it("exits 1 when a harness-entry exception is (wrongly) placed under content/", () => {
    root = mkdtempSync(join(tmpdir(), "cm-harness-under-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "content/AGENTS.md", bucket: "content", note: "harness", harnessEntry: true },
        { path: "content/skills", bucket: "content", note: "skills" },
      ]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: ["content/skills", "content/AGENTS.md"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("harness-entry exception 'content/AGENTS.md'");
  });

  it("exits 2 when the manifest is missing", () => {
    root = mkdtempSync(join(tmpdir(), "cm-missing-"));
    const result = evaluateContentManifest(root, {
      manifestPath: join(root, "nope.json"),
      root,
      contentChildren: ["content/skills"],
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("not found");
  });

  it("exits 2 on an entry referencing an unknown bucket", () => {
    root = mkdtempSync(join(tmpdir(), "cm-bad-bucket-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "content/skills", bucket: "nonsense", note: "x" }]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      contentChildren: ["content/skills"],
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("unknown bucket 'nonsense'");
  });
});

describe("loadManifest", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("throws on malformed JSON", () => {
    root = mkdtempSync(join(tmpdir(), "cm-json-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, "{ not json", "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(/Malformed JSON/);
  });

  it("throws on a missing required entry field", () => {
    root = mkdtempSync(join(tmpdir(), "cm-field-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "content/skills", bucket: "content" }]),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/field 'note'/);
  });

  it("throws on a duplicate entry path", () => {
    root = mkdtempSync(join(tmpdir(), "cm-dup-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "content/skills", bucket: "content", note: "a" },
        { path: "content/skills", bucket: "engine", note: "b" },
      ]),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/Duplicate content manifest entry path/);
  });

  it("throws when straddle is not a boolean", () => {
    root = mkdtempSync(join(tmpdir(), "cm-straddle-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "content/skills", bucket: "content", note: "a", straddle: "yes" }]),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/'straddle' must be a boolean/);
  });

  it("throws when harnessEntry is not a boolean", () => {
    root = mkdtempSync(join(tmpdir(), "cm-harnessentry-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "AGENTS.md", bucket: "content", note: "a", harnessEntry: "yes" }]),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/'harnessEntry' must be a boolean/);
  });

  it("throws when harnessEntry is set on a non-content entry", () => {
    root = mkdtempSync(join(tmpdir(), "cm-harnessentry-bucket-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "Taskfile.yml", bucket: "engine", note: "a", harnessEntry: true }]),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/only 'content' entries may be harness-entry/);
  });

  it("throws when the top-level payload is not an object", () => {
    root = mkdtempSync(join(tmpdir(), "cm-nonobj-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, "42", "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(/must contain a JSON object/);
  });

  it("throws when version is not numeric", () => {
    root = mkdtempSync(join(tmpdir(), "cm-version-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ buckets: [], entries: [] }), "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(/numeric 'version'/);
  });

  it("throws when buckets is not an array", () => {
    root = mkdtempSync(join(tmpdir(), "cm-buckets-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [] }), "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(/'buckets' array/);
  });

  it("throws when a bucket is missing a required field", () => {
    root = mkdtempSync(join(tmpdir(), "cm-bucketfield-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, buckets: [{ id: "content", label: "C" }], entries: [] }),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/field 'description'/);
  });

  it("throws on a duplicate bucket id", () => {
    root = mkdtempSync(join(tmpdir(), "cm-dupbucket-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        buckets: [
          { id: "content", label: "C", description: "d" },
          { id: "content", label: "C2", description: "d2" },
        ],
        entries: [],
      }),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/Duplicate content manifest bucket id/);
  });

  it("throws when entries is not an array", () => {
    root = mkdtempSync(join(tmpdir(), "cm-entries-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, buckets: [{ id: "content", label: "C", description: "d" }] }),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/'entries' array/);
  });
});

describe("listTrackedContentChildren", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("throws when run outside a git repository", () => {
    root = mkdtempSync(join(tmpdir(), "cm-nogit-"));
    expect(() => listTrackedContentChildren(root as string)).toThrow(/git ls-files failed/);
  });
});

describe("lintManifest", () => {
  it("returns [] when the location invariant holds", () => {
    const manifest = {
      version: 2,
      buckets: [{ id: "content", label: "Content", description: "d" }],
      entries: [{ path: "content/skills", bucket: "content", note: "n" }],
    };
    expect(lintManifest(manifest, ["content/skills"])).toEqual([]);
  });
});

describe("content-manifest self-test (real tree)", () => {
  it("the committed manifest satisfies the location invariant for the real content/ tree", () => {
    const children = listTrackedContentChildren(REPO_ROOT);
    expect(children.length).toBeGreaterThan(0);
    const result = evaluateContentManifest(REPO_ROOT, { root: REPO_ROOT });
    expect(result.code).toBe(0);
  });
});
