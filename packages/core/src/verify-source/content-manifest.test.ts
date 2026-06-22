import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateContentManifest,
  lintManifest,
  listTrackedTopLevel,
  loadManifest,
} from "./content-manifest.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

function makeManifest(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    version: 1,
    buckets: [
      { id: "content", label: "Content", description: "ships" },
      { id: "engine", label: "Engine", description: "runtime" },
      { id: "harness", label: "Harness", description: "build" },
      { id: "repo-dev", label: "Repo-dev", description: "maintainer" },
    ],
    entries,
  });
}

describe("evaluateContentManifest", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 when every top-level entry is classified", () => {
    root = mkdtempSync(join(tmpdir(), "cm-clean-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "skills", bucket: "content", note: "skills" },
        { path: "packages", bucket: "engine", note: "engine" },
        { path: "tests", bucket: "harness", note: "tests", straddle: false },
      ]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      topLevelEntries: ["packages", "skills", "tests"],
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("clean");
    expect(result.message).toContain("3 top-level");
  });

  it("exits 1 on an unclassified top-level entry", () => {
    root = mkdtempSync(join(tmpdir(), "cm-unclassified-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "skills", bucket: "content", note: "skills" }]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      topLevelEntries: ["skills", "brand-new-dir"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("unclassified top-level entry 'brand-new-dir'");
  });

  it("exits 1 on a stale classified entry", () => {
    root = mkdtempSync(join(tmpdir(), "cm-stale-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "skills", bucket: "content", note: "skills" },
        { path: "deleted-dir", bucket: "content", note: "gone" },
      ]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      topLevelEntries: ["skills"],
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("stale classified entry 'deleted-dir'");
  });

  it("exits 2 when the manifest is missing", () => {
    root = mkdtempSync(join(tmpdir(), "cm-missing-"));
    const result = evaluateContentManifest(root, {
      manifestPath: join(root, "nope.json"),
      root,
      topLevelEntries: ["skills"],
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("not found");
  });

  it("exits 2 on an entry referencing an unknown bucket", () => {
    root = mkdtempSync(join(tmpdir(), "cm-bad-bucket-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([{ path: "skills", bucket: "nonsense", note: "x" }]),
      "utf8",
    );
    const result = evaluateContentManifest(root, {
      manifestPath,
      root,
      topLevelEntries: ["skills"],
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
    writeFileSync(manifestPath, makeManifest([{ path: "skills", bucket: "content" }]), "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(/field 'note'/);
  });

  it("throws on a duplicate entry path", () => {
    root = mkdtempSync(join(tmpdir(), "cm-dup-"));
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      makeManifest([
        { path: "skills", bucket: "content", note: "a" },
        { path: "skills", bucket: "engine", note: "b" },
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
      makeManifest([{ path: "skills", bucket: "content", note: "a", straddle: "yes" }]),
      "utf8",
    );
    expect(() => loadManifest(manifestPath)).toThrow(/'straddle' must be a boolean/);
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

describe("listTrackedTopLevel", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("throws when run outside a git repository", () => {
    root = mkdtempSync(join(tmpdir(), "cm-nogit-"));
    expect(() => listTrackedTopLevel(root as string)).toThrow(/git ls-files failed/);
  });
});

describe("lintManifest", () => {
  it("returns [] when manifest and tree agree", () => {
    const manifest = {
      version: 1,
      buckets: [{ id: "content", label: "Content", description: "d" }],
      entries: [{ path: "skills", bucket: "content", note: "n" }],
    };
    expect(lintManifest(manifest, ["skills"])).toEqual([]);
  });
});

describe("content-manifest self-test (real tree)", () => {
  it("the committed manifest classifies every real top-level entry", () => {
    const tracked = listTrackedTopLevel(REPO_ROOT);
    expect(tracked.length).toBeGreaterThan(0);
    const result = evaluateContentManifest(REPO_ROOT, { root: REPO_ROOT });
    expect(result.code).toBe(0);
  });
});
