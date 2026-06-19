import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restIssueView } from "../scm/gh-rest.js";
import { restIssueListPaginated, setPaginatedLister, setSingleIssueFetcher } from "./fetch.js";
import { main } from "./main.js";

describe("main CLI branches", () => {
  let cwd: string;
  const prevCwd = process.cwd();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "deft-cache-cli-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("put/get roundtrip via CLI", () => {
    const rawPath = join(cwd, "raw.json");
    writeFileSync(
      rawPath,
      JSON.stringify({ number: 7, title: "t", body: "b", state: "open" }),
      "utf8",
    );
    expect(
      main([
        "put",
        "github-issue",
        "deftai/directive/7",
        "--raw-file",
        rawPath,
        "--ttl-seconds",
        "3600",
      ]),
    ).toBe(0);
    expect(main(["get", "github-issue", "deftai/directive/7"])).toBe(0);
  });

  it("put hard-fail exits 2", () => {
    const rawPath = join(cwd, "bad.json");
    writeFileSync(
      rawPath,
      JSON.stringify({ number: 8, title: "t", body: `AKIA${"A".repeat(16)}`, state: "open" }),
      "utf8",
    );
    expect(main(["put", "github-issue", "deftai/directive/8", "--raw-file", rawPath])).toBe(2);
  });

  it("prune and invalidate succeed", () => {
    expect(main(["invalidate", "github-issue", "deftai/directive/1", "--reason", "test"])).toBe(0);
    expect(main(["invalidate", "github-issue", "deftai/directive/2"])).toBe(0);
    expect(main(["prune", "--dry-run"])).toBe(0);
    expect(main(["prune", "--to-cap", "--dry-run"])).toBe(0);
  });

  it("fetch-all validation errors", () => {
    expect(main(["fetch-all", "--source", "github-issue", "--repo", "bad"])).toBe(1);
    expect(
      main([
        "fetch-all",
        "--source",
        "github-issue",
        "--repo",
        "deftai/directive",
        "--batch-size",
        "0",
      ]),
    ).toBe(1);
  });

  it("unknown cmd exits 2", () => {
    expect(main(["nope"])).toBe(2);
  });

  it("fetch-all via CLI with mocked lister and refresh-closed", () => {
    setPaginatedLister(() => [{ number: 12, title: "t", body: "b", state: "open" }]);
    setSingleIssueFetcher(() => ({ number: 12, state: "closed", title: "t", body: "b" }));
    try {
      expect(
        main([
          "fetch-all",
          "--source",
          "github-issue",
          "--repo",
          "deftai/directive",
          "--limit",
          "1",
          "--refresh-closed",
        ]),
      ).toBe(0);
    } finally {
      setPaginatedLister(restIssueListPaginated);
      setSingleIssueFetcher(restIssueView);
    }
  });

  it("prune with source filter", () => {
    expect(main(["prune", "--source", "github-issue", "--older-than-days", "0"])).toBe(0);
  });

  it("put rejects invalid source, array payload, and extra args", () => {
    const rawPath = join(cwd, "arr.json");
    writeFileSync(rawPath, "[]", "utf8");
    expect(main(["put", "nope", "deftai/directive/1", "--raw-file", rawPath])).toBe(2);
    expect(main(["put", "other", "deftai/directive/1", "--raw-file", rawPath])).toBe(2);
    expect(main(["put", "github-issue", "deftai/directive/1", "--raw-file", rawPath])).toBe(1);
    const objPath = join(cwd, "obj.json");
    writeFileSync(objPath, JSON.stringify({ number: 1, title: "t", body: "b" }), "utf8");
    expect(
      main(["put", "github-issue", "deftai/directive/1", "--raw-file", objPath, "extra"]),
    ).toBe(1);
  });

  it("get --no-stale returns miss for expired entry", () => {
    const rawPath = join(cwd, "exp.json");
    writeFileSync(
      rawPath,
      JSON.stringify({ number: 20, title: "t", body: "b", state: "open" }),
      "utf8",
    );
    expect(
      main([
        "put",
        "github-issue",
        "deftai/directive/20",
        "--raw-file",
        rawPath,
        "--ttl-seconds",
        "3600",
      ]),
    ).toBe(0);
    const metaPath = join(cwd, ".deft-cache/github-issue/deftai/directive/20/meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta.expires_at = "2020-01-01T00:00:00Z";
    writeFileSync(metaPath, JSON.stringify(meta), "utf8");
    expect(main(["get", "github-issue", "deftai/directive/20", "--no-stale"])).toBe(1);
  });

  it("fetch-all passes labels author ttl and fails when issues fail", () => {
    setPaginatedLister(() => [{ number: "bad", title: "t", body: "b", state: "open" }]);
    try {
      expect(
        main([
          "fetch-all",
          "--source",
          "github-issue",
          "--repo",
          "deftai/directive",
          "--label",
          "bug,enhancement",
          "--author",
          "alice",
          "--ttl-seconds",
          "120",
          "--state",
          "closed",
          "--limit",
          "5",
          "--delay-ms",
          "0",
          "--batch-size",
          "1",
        ]),
      ).toBe(1);
    } finally {
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("fetch-all refresh-closed failure sets exit 1", () => {
    setPaginatedLister(() => []);
    setSingleIssueFetcher(() => {
      throw new Error("refresh fetch fail");
    });
    const base = join(cwd, ".deft-cache/github-issue/deftai/directive/21");
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "raw.json"),
      JSON.stringify({ number: 21, state: "open", title: "t", body: "b" }),
      "utf8",
    );
    try {
      expect(
        main([
          "fetch-all",
          "--source",
          "github-issue",
          "--repo",
          "deftai/directive",
          "--refresh-closed",
        ]),
      ).toBe(1);
    } finally {
      setPaginatedLister(restIssueListPaginated);
      setSingleIssueFetcher(restIssueView);
    }
  });
});
