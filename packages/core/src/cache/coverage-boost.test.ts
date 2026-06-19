import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GhRestError } from "../scm/gh-rest.js";
import {
  cacheFetchAll,
  detectRateLimit,
  restIssueListPaginated,
  setPaginatedLister,
} from "./fetch.js";
import { atomicWriteText } from "./io.js";
import { main } from "./main.js";
import { cachePut } from "./operations.js";
import { evictLru, scanUsage } from "./quota.js";

describe("main error handlers", () => {
  it("returns 2 for put usage and missing raw file path", () => {
    expect(main(["put"])).toBe(2);
    expect(main(["put", "github-issue", "deftai/directive/1", "--raw-file", "/nope"])).toBe(1);
  });

  it("returns 2 for get/invalidate/fetch-all usage", () => {
    expect(main(["get"])).toBe(2);
    expect(main(["invalidate"])).toBe(2);
    expect(main(["fetch-all"])).toBe(2);
  });

  it("returns 2 on schema error for corrupt meta via get", () => {
    const cwd = mkdtempSync(join(tmpdir(), "deft-cli-schema-"));
    const prev = process.cwd();
    process.chdir(cwd);
    const edir = join(cwd, ".deft-cache/github-issue/deftai/directive/55");
    mkdirSync(edir, { recursive: true });
    writeFileSync(join(edir, "meta.json"), "{}", "utf8");
    try {
      expect(main(["get", "github-issue", "deftai/directive/55"])).toBe(2);
    } finally {
      process.chdir(prev);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns 1 for invalid raw json on put", () => {
    const cwd = mkdtempSync(join(tmpdir(), "deft-cli-json-"));
    const prev = process.cwd();
    process.chdir(cwd);
    const rawPath = join(cwd, "bad.json");
    writeFileSync(rawPath, "not-json", "utf8");
    try {
      expect(main(["put", "github-issue", "deftai/directive/1", "--raw-file", rawPath])).toBe(1);
    } finally {
      process.chdir(prev);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns 3 on cap breach via CLI", () => {
    const cwd = mkdtempSync(join(tmpdir(), "deft-cli-cap-"));
    const prev = process.cwd();
    const prevMax = process.env.DEFT_CACHE_MAX_BYTES;
    process.env.DEFT_CACHE_MAX_BYTES = "10";
    process.chdir(cwd);
    const rawPath = join(cwd, "big.json");
    writeFileSync(
      rawPath,
      JSON.stringify({
        number: 1,
        title: "hello",
        body: "world",
        state: "open",
      }),
      "utf8",
    );
    try {
      expect(main(["put", "github-issue", "deftai/directive/1", "--raw-file", rawPath])).toBe(3);
    } finally {
      process.chdir(prev);
      if (prevMax === undefined) delete process.env.DEFT_CACHE_MAX_BYTES;
      else process.env.DEFT_CACHE_MAX_BYTES = prevMax;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("fetch rate limit", () => {
  it("retries on GhRestError 429", () => {
    let calls = 0;
    setPaginatedLister(() => {
      calls += 1;
      if (calls === 1) {
        throw new GhRestError({
          stderr: "HTTP 429 rate limit exceeded",
          exitCode: 0,
          endpoint: "repos/x/y/issues",
          payload: null,
        });
      }
      return [{ number: 1, title: "t", body: "b", state: "open" }];
    });
    const root = mkdtempSync(join(tmpdir(), "deft-429-"));
    try {
      cacheFetchAll({ source: "github-issue", repo: "deftai/directive", cacheRoot: root });
      expect(calls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("detectRateLimit handles invalid retry-after", () => {
    expect(detectRateLimit("HTTP 429 Retry-After: abc")[1]).toBe(60);
  });
});

describe("quota eviction branches", () => {
  it("evicts until caps satisfied", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-evict2-"));
    try {
      cachePut(
        "github-issue",
        "deftai/directive/1",
        { number: 1, title: "a", body: "b", state: "open" },
        { cacheRoot: root },
      );
      cachePut(
        "github-issue",
        "deftai/directive/2",
        { number: 2, title: "c", body: "d", state: "open" },
        { cacheRoot: root },
      );
      const evicted = evictLru(root, {
        caps: { maxBytes: 1, maxEntries: 1 },
        incomingBytes: 1000,
        incomingEntries: 1,
        onEvict: () => {},
      });
      expect(evicted.length).toBeGreaterThan(0);
      expect(scanUsage(root).totalEntries).toBeLessThan(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("io", () => {
  it("writes nested paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-io2-"));
    const path = join(dir, "a/b/c.txt");
    try {
      atomicWriteText(path, "data");
      expect(readFileSync(path, "utf8")).toBe("data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
