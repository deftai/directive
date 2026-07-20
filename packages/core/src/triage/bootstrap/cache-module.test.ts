import { describe, expect, it } from "vitest";
import { bootstrapCacheModule, loadDefaultCacheModule } from "./cache-module.js";

describe("bootstrap cache-module (#2684)", () => {
  it("loadDefaultCacheModule always returns a module (no Python gate)", () => {
    expect(loadDefaultCacheModule()).not.toBeNull();
  });

  it("forwards bootstrap kwargs into cacheFetchAll", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const mod = bootstrapCacheModule((options) => {
      seen.push({ ...options });
      return {
        issuesWritten: 1,
        issuesFailed: 0,
        alreadyFresh: 0,
        summaryLine: () => "ok",
      } as ReturnType<typeof import("../../cache/fetch.js").cacheFetchAll>;
    });
    const report = await mod.cacheFetchAll({
      source: "github-issue",
      repo: "deftai/directive",
      cacheRoot: "/tmp/cache",
      batchSize: 5,
      delayMs: 1,
      state: "open",
      limit: 3,
      labels: ["triage"],
      author: "bob",
    });
    expect(report.succeeded).toBe(1);
    expect(seen[0]).toMatchObject({
      source: "github-issue",
      repo: "deftai/directive",
      cacheRoot: "/tmp/cache",
      force: true,
      batchSize: 5,
      delayMs: 1,
      state: "open",
      limit: 3,
      labels: ["triage"],
      author: "bob",
    });
  });
});
