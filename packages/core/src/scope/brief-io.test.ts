import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cacheIo from "../cache/io.js";
import {
  atomicWriteBrief,
  formatBriefJson,
  readBriefForMutation,
  validateBriefForPersist,
} from "./brief-io.js";
import { minimalScopeBrief } from "./scope-test-fixtures.test.js";

function validBrief(status: string): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: { title: "T", status, items: [] },
  };
}

describe("brief-io", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    vi.restoreAllMocks();
  });

  it("minimalScopeBrief wraps plan with xBRIEFInfo 0.8", () => {
    const brief = minimalScopeBrief({ title: "T", status: "running", items: [] });
    expect(brief.xBRIEFInfo).toEqual({ version: "0.8" });
    expect((brief.plan as { title: string }).title).toBe("T");
  });

  it("readBriefForMutation parses a valid brief", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-read-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const path = join(root, "xbrief", "active", "story.xbrief.json");
    writeFileSync(path, formatBriefJson(validBrief("running")), "utf8");
    const result = readBriefForMutation(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data.plan as { status: string }).status).toBe("running");
    }
  });

  it("readBriefForMutation rejects missing files", () => {
    const result = readBriefForMutation(join(tmpdir(), "missing.xbrief.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/File not found/);
    }
  });

  it("readBriefForMutation rejects non-artifact filenames", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-suffix-"));
    const path = join(root, "not-a-brief.json");
    writeFileSync(path, "{}", "utf8");
    const result = readBriefForMutation(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Not a vBRIEF file/);
    }
  });

  it("readBriefForMutation rejects invalid JSON", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-json-"));
    const path = join(root, "story.xbrief.json");
    writeFileSync(path, "{not json", "utf8");
    const result = readBriefForMutation(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Invalid JSON/);
    }
  });

  it("readBriefForMutation rejects non-object top-level JSON", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-array-"));
    const path = join(root, "story.xbrief.json");
    writeFileSync(path, "[]", "utf8");
    const result = readBriefForMutation(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/not a JSON object/);
    }
  });

  it("validateBriefForPersist rejects schema-invalid briefs", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-invalid-"));
    const vbriefRoot = join(root, "xbrief");
    mkdirSync(join(vbriefRoot, "active"), { recursive: true });
    const path = join(vbriefRoot, "active", "bad.xbrief.json");
    const invalid = { plan: { title: "T", status: "running", items: [] } };
    const errors = validateBriefForPersist(path, invalid, vbriefRoot);
    expect(errors).not.toBeNull();
    expect(errors).toMatch(/missing required top-level key/);
  });

  it("validateBriefForPersist rejects folder/status mismatches", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-folder-"));
    const vbriefRoot = join(root, "xbrief");
    mkdirSync(join(vbriefRoot, "active"), { recursive: true });
    const path = join(vbriefRoot, "active", "mismatch.xbrief.json");
    const errors = validateBriefForPersist(path, validBrief("pending"), vbriefRoot);
    expect(errors).toMatch(/plan\.status is 'pending'/);
  });

  it("atomicWriteBrief refuses invalid briefs without touching the live file", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-refuse-"));
    const vbriefRoot = join(root, "xbrief");
    mkdirSync(join(vbriefRoot, "active"), { recursive: true });
    const path = join(vbriefRoot, "active", "keep.xbrief.json");
    const original = validBrief("running");
    writeFileSync(path, formatBriefJson(original), "utf8");
    const before = readFileSync(path, "utf8");

    const result = atomicWriteBrief(path, validBrief("pending"), vbriefRoot);
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("atomicWriteBrief writes via temp file + rename", () => {
    root = mkdtempSync(join(tmpdir(), "brief-io-atomic-"));
    const vbriefRoot = join(root, "xbrief");
    mkdirSync(join(vbriefRoot, "pending"), { recursive: true });
    const path = join(vbriefRoot, "pending", "story.xbrief.json");
    const spy = vi.spyOn(cacheIo, "atomicWriteText");

    const result = atomicWriteBrief(path, validBrief("pending"), vbriefRoot);
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf8")) as { plan: { status: string } };
    expect(data.plan.status).toBe("pending");
  });
});

describe("scope lifecycle brief-io boundary (#2131)", () => {
  const lifecycleSources = [
    "packages/core/src/scope/transition.ts",
    "packages/core/src/scope/project-definition-sync.ts",
    "packages/core/src/scope/registry-artifact-sync.ts",
  ] as const;

  it("lifecycle transition paths do not call writeFileSync on brief artifacts", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    for (const rel of lifecycleSources) {
      const source = readFileSync(join(repoRoot, rel), "utf8");
      expect(source, rel).not.toMatch(/\bwriteFileSync\s*\(/);
    }
  });
});
