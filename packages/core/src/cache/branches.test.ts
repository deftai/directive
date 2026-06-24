import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CacheCapBreachedError,
  CacheError,
  CacheFetchError,
  CacheNotFoundError,
  CacheValidationError,
} from "./errors.js";
import { appendAudit, atomicWriteText, touchMtime } from "./io.js";
import { pythonJsonDump, pythonJsonLine, pythonJsonPretty, sortKeysDeep } from "./json.js";
import { cachePruneToCap } from "./operations.js";
import { auditPath, entryDir, validateKey } from "./paths.js";
import { capBreached, lruOrder, predictEvictionSet } from "./quota.js";

describe("paths", () => {
  it("validates github-issue keys", () => {
    expect(() => validateKey("github-issue", "bad")).toThrow(CacheError);
    expect(entryDir("github-issue", "deftai/directive/1", "/tmp/c")).toContain("deftai");
    expect(auditPath("/tmp/c")).toBe("/tmp/c/quarantine-audit.jsonl");
    expect(() => entryDir("unknown", "a/b/1", "/tmp")).toThrow(/unknown source/);
  });
});

describe("io", () => {
  it("writes atomically and appends audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-io-"));
    const path = join(dir, "sub", "file.txt");
    try {
      atomicWriteText(path, "hello");
      expect(readFileSync(path, "utf8")).toBe("hello");
      appendAudit({ event: "test" }, dir);
      expect(readFileSync(join(dir, "quarantine-audit.jsonl"), "utf8")).toContain("test");
      touchMtime(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("json helpers", () => {
  it("sorts keys recursively", () => {
    const sorted = sortKeysDeep({ b: 1, a: { d: 2, c: 3 } }) as Record<string, unknown>;
    expect(Object.keys(sorted)).toEqual(["a", "b"]);
    expect(pythonJsonLine({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(pythonJsonPretty({ z: 1, a: 2 })).toContain('"z": 1');
    expect(pythonJsonDump({ z: 1, a: 2 })).toContain('"a"');
  });
});

describe("errors", () => {
  it("formats cap breached message", () => {
    const err = new CacheCapBreachedError({
      reason: "size_cap",
      maxBytes: 100,
      maxEntries: 10,
      currentBytes: 90,
      currentEntries: 5,
      incomingBytes: 20,
    });
    expect(err.message).toContain("size_cap");
    expect(new CacheNotFoundError("miss").message).toBe('"miss"');
    expect(new CacheNotFoundError('say "hi"').message).toBe('"say \\"hi\\""');
    expect(new CacheNotFoundError("miss").name).toBe("CacheNotFoundError");
    expect(new CacheValidationError("bad").name).toBe("CacheValidationError");
    expect(new CacheFetchError("fail").name).toBe("CacheFetchError");
  });
});

describe("quota helpers", () => {
  it("capBreached detects overage", () => {
    expect(
      capBreached({ totalBytes: 10, totalEntries: 2, entries: [] }, { maxBytes: 5, maxEntries: 0 }),
    ).toBe(true);
    expect(lruOrder({ totalBytes: 0, totalEntries: 0, entries: [] })).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), "deft-cap2-"));
    try {
      expect(predictEvictionSet(root, { maxBytes: 0, maxEntries: 0 })).toEqual([]);
      expect(cachePruneToCap({ cacheRoot: root, dryRun: true })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
