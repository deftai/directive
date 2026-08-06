import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveClosedEntries,
  archivedEntryDir,
  DEFAULT_ARCHIVE_OLDER_THAN_DAYS,
  listArchivedEntries,
  openLifecycleReferencedIssueNumbers,
  resolveClosedAge,
  restoreFromArchive,
} from "./archive.js";
import { FixedClock } from "./test-helpers.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-archive-"));
  roots.push(root);
  return root;
}

function writeLiveEntry(
  cacheRoot: string,
  key: string,
  raw: Record<string, unknown>,
  metaExtra: Record<string, unknown> = {},
): string {
  const edir = join(cacheRoot, "github-issue", ...key.split("/"));
  mkdirSync(edir, { recursive: true });
  writeFileSync(join(edir, "raw.json"), `${JSON.stringify(raw)}\n`, "utf8");
  writeFileSync(join(edir, "content.md"), `# #${raw.number}\n`, "utf8");
  writeFileSync(
    join(edir, "meta.json"),
    `${JSON.stringify({
      source: "github-issue",
      key,
      fetched_at: metaExtra.fetched_at ?? "2026-01-01T00:00:00Z",
      ttl_seconds: 604800,
      expires_at: metaExtra.expires_at ?? "2026-01-08T00:00:00Z",
      scan_result: {
        passed: true,
        scanned_at: "2026-01-01T00:00:00Z",
        scanner_version: "1",
        flags: [],
      },
      size_bytes: 10,
      stale: false,
      ...metaExtra,
    })}\n`,
    "utf8",
  );
  return edir;
}

function writeScope(
  projectRoot: string,
  folder: "proposed" | "pending" | "active",
  issueNumber: number,
  filename: string,
): void {
  const dir = join(projectRoot, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: `scope for #${issueNumber}`,
        status: folder === "active" ? "running" : "proposed",
        references: [
          {
            type: "x-xbrief/github-issue",
            uri: `https://github.com/deftai/directive/issues/${issueNumber}`,
          },
        ],
      },
    })}\n`,
    "utf8",
  );
}

describe("resolveClosedAge", () => {
  it("prefers closed_at then fetched_at then mtime", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const withClosed = resolveClosedAge(
      { state: "closed", closed_at: "2026-06-01T00:00:00Z" },
      { fetched_at: "2026-07-01T00:00:00Z" },
      "/nope",
      now,
    );
    expect(withClosed.ageBasis).toBe("closed_at");
    expect(withClosed.ageMs).toBeGreaterThan(0);

    const withFetched = resolveClosedAge(
      { state: "closed" },
      { fetched_at: "2026-07-01T00:00:00Z" },
      "/nope",
      now,
    );
    expect(withFetched.ageBasis).toBe("fetched_at");
  });
});

describe("archiveClosedEntries", () => {
  it("dry-run reports eligible closed+aged entries without moving", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/100",
      {
        number: 100,
        title: "old closed",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/101",
      {
        number: 101,
        title: "open",
        body: "x",
        state: "open",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );

    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
      clock,
    });
    expect(result.archivedCount).toBe(1);
    expect(result.archived[0]?.key).toBe("deftai/directive/100");
    expect(
      result.skipped.some((s) => s.key === "deftai/directive/101" && s.reason === "not-closed"),
    ).toBe(true);
    expect(existsSync(join(cacheRoot, "github-issue/deftai/directive/100/raw.json"))).toBe(true);
    expect(existsSync(archivedEntryDir("github-issue", "deftai/directive/100", cacheRoot))).toBe(
      false,
    );
  });

  it("archives closed entry and writes archive-meta + audit", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/200",
      {
        number: 200,
        title: "archive me",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );

    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: DEFAULT_ARCHIVE_OLDER_THAN_DAYS,
      dryRun: false,
      clock,
    });
    expect(result.archivedCount).toBe(1);
    expect(existsSync(join(cacheRoot, "github-issue/deftai/directive/200"))).toBe(false);
    const arch = archivedEntryDir("github-issue", "deftai/directive/200", cacheRoot);
    expect(existsSync(join(arch, "raw.json"))).toBe(true);
    expect(existsSync(join(arch, "archive-meta.json"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(arch, "archive-meta.json"), "utf8")) as {
      reason: string;
      key: string;
    };
    expect(meta.key).toBe("deftai/directive/200");
    expect(meta.reason).toBe("closed-age-archive");
    const audit = readFileSync(join(cacheRoot, "quarantine-audit.jsonl"), "utf8");
    expect(audit).toContain("cache:archive");
  });

  it("skips open-lifecycle-scope referenced issues", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/300",
      {
        number: 300,
        title: "in flight",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );
    writeScope(projectRoot, "active", 300, "2026-08-01-300.xbrief.json");

    const protectedSet = openLifecycleReferencedIssueNumbers(projectRoot);
    expect(protectedSet.has(300)).toBe(true);

    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: false,
      clock,
    });
    expect(result.archivedCount).toBe(0);
    expect(
      result.skipped.some(
        (s) => s.key === "deftai/directive/300" && s.reason === "open-lifecycle-scope",
      ),
    ).toBe(true);
    expect(existsSync(join(cacheRoot, "github-issue/deftai/directive/300/raw.json"))).toBe(true);
  });

  it("skips too-recent closed entries", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/301",
      {
        number: 301,
        title: "just closed",
        body: "x",
        state: "closed",
        closed_at: "2026-07-20T00:00:00Z",
      },
      { fetched_at: "2026-07-20T00:00:00Z" },
    );

    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
      clock,
    });
    expect(result.archivedCount).toBe(0);
    expect(result.skipped.some((s) => s.reason === "too-recent")).toBe(true);
  });

  it("respects --repo filter", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/400",
      {
        number: 400,
        title: "a",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );
    writeLiveEntry(
      cacheRoot,
      "other/repo/401",
      {
        number: 401,
        title: "b",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );

    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      repo: "deftai/directive",
      dryRun: true,
      clock,
    });
    expect(result.archived.map((a) => a.key)).toEqual(["deftai/directive/400"]);
  });

  it("terminal-decision-only skips non-terminal latest decisions", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/500",
      {
        number: 500,
        title: "accepted closed",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );
    // candidates-log key form: repo\0issue
    const decisions = new Map<string, string>([["deftai/directive\u0000500", "accept"]]);
    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
      terminalDecisionOnly: true,
      latestDecisions: decisions,
      clock,
    });
    expect(result.archivedCount).toBe(0);
    expect(result.skipped.some((s) => s.reason === "non-terminal-decision")).toBe(true);
  });

  it("lifecycle protection is repo-scoped (multi-repo same number)", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeScope(projectRoot, "active", 300, "2026-08-01-300.xbrief.json");
    writeLiveEntry(
      cacheRoot,
      "other/repo/300",
      {
        number: 300,
        title: "other repo",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );
    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
      clock,
    });
    // other/repo/300 must NOT be blocked by deftai/directive#300 scope
    expect(result.archived.some((a) => a.key === "other/repo/300")).toBe(true);
  });

  it("rejects malformed --issue on restore CLI", async () => {
    const { main } = await import("./main.js");
    expect(main(["restore-from-archive", "--issue", "42abc", "--repo", "a/b"])).toBe(1);
  });
});

describe("listArchivedEntries / restoreFromArchive", () => {
  it("lists newest first and restores idempotently", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/600",
      {
        number: 600,
        title: "roundtrip",
        body: "x",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );
    archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      clock,
    });

    const listed = listArchivedEntries({ cacheRoot });
    expect(listed.count).toBe(1);
    expect(listed.entries[0]?.key).toBe("deftai/directive/600");

    const restored = restoreFromArchive({
      cacheRoot,
      issue: 600,
      repo: "deftai/directive",
      clock,
    });
    expect(restored.status).toBe("restored");
    expect(existsSync(join(cacheRoot, "github-issue/deftai/directive/600/raw.json"))).toBe(true);
    expect(existsSync(join(cacheRoot, "github-issue/deftai/directive/600/archive-meta.json"))).toBe(
      false,
    );

    // Idempotent when already live and archive gone
    const again = restoreFromArchive({
      cacheRoot,
      issue: 600,
      repo: "deftai/directive",
      clock,
    });
    expect(again.status).toBe("already-live");
  });

  it("reports missing entry", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    mkdirSync(cacheRoot, { recursive: true });
    const result = restoreFromArchive({
      cacheRoot,
      key: "deftai/directive/999",
    });
    expect(result.status).toBe("missing");
  });

  it("refuses conflict when live differs unless force", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/700",
      {
        number: 700,
        title: "orig",
        body: "orig",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );
    archiveClosedEntries({ cacheRoot, projectRoot, olderThanDays: 30, clock });
    // recreate different live
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/700",
      {
        number: 700,
        title: "different",
        body: "different",
        state: "closed",
        closed_at: "2026-01-01T00:00:00Z",
      },
      { fetched_at: "2026-01-01T00:00:00Z" },
    );

    const conflict = restoreFromArchive({
      cacheRoot,
      issue: 700,
      repo: "deftai/directive",
    });
    expect(conflict.status).toBe("conflict");

    const forced = restoreFromArchive({
      cacheRoot,
      issue: 700,
      repo: "deftai/directive",
      force: true,
      clock,
    });
    expect(forced.status).toBe("restored");
    const raw = JSON.parse(
      readFileSync(join(cacheRoot, "github-issue/deftai/directive/700/raw.json"), "utf8"),
    ) as { title: string };
    expect(raw.title).toBe("orig");
  });
});

describe("archive edge cases", () => {
  it("rejects negative older-than-days and bad source/repo", () => {
    expect(() => archiveClosedEntries({ olderThanDays: -1 })).toThrow(/older-than-days/);
    expect(() => archiveClosedEntries({ source: "url" })).toThrow(/not supported/);
    expect(() => archiveClosedEntries({ repo: "bad" })).toThrow(/invalid --repo/);
    expect(() => listArchivedEntries({ source: "url" })).toThrow(/not supported/);
    expect(() => listArchivedEntries({ repo: "bad" })).toThrow(/invalid --repo/);
    expect(() => restoreFromArchive({ source: "url", key: "a/b/1" })).toThrow(/not supported/);
    expect(() => restoreFromArchive({ issue: 1 })).toThrow(/--repo/);
  });

  it("no-ops on missing cache root and uses fetched_at age", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache-missing");
    const empty = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
    });
    expect(empty.archivedCount).toBe(0);

    const realCache = join(projectRoot, ".deft-cache");
    writeLiveEntry(
      realCache,
      "deftai/directive/901",
      {
        number: 901,
        title: "no closed_at",
        body: "x",
        state: "closed",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    const result = archiveClosedEntries({
      cacheRoot: realCache,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
      clock,
    });
    expect(result.archivedCount).toBe(1);
    expect(result.archived[0]?.ageBasis).toBe("fetched_at");
  });

  it("skips missing-raw and terminal-decision accepts reject", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    const edir = join(cacheRoot, "github-issue", "deftai", "directive", "902");
    mkdirSync(edir, { recursive: true });
    writeFileSync(
      join(edir, "meta.json"),
      JSON.stringify({
        source: "github-issue",
        key: "deftai/directive/902",
        fetched_at: "2020-01-01T00:00:00Z",
        ttl_seconds: 1,
        expires_at: "2020-01-02T00:00:00Z",
        scan_result: {
          passed: true,
          scanned_at: "2020-01-01T00:00:00Z",
          scanner_version: "1",
          flags: [],
        },
        size_bytes: 1,
        stale: false,
      }),
      "utf8",
    );

    writeLiveEntry(
      cacheRoot,
      "deftai/directive/903",
      {
        number: 903,
        title: "rejected",
        body: "x",
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );

    const result = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
      terminalDecisionOnly: true,
      latestDecisions: new Map([
        ["deftai/directive#903", "reject"],
        ["903", "reject"],
      ]),
      clock,
    });
    expect(result.skipped.some((s) => s.reason === "missing-raw")).toBe(true);
    expect(result.archived.some((a) => a.key === "deftai/directive/903")).toBe(true);
  });

  it("listArchivedEntries filters since/limit/repo and missing archive-meta", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/904",
      {
        number: 904,
        title: "a",
        body: "x",
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );
    archiveClosedEntries({ cacheRoot, projectRoot, olderThanDays: 30, clock });
    // strip archive-meta to exercise fallback
    const arch = archivedEntryDir("github-issue", "deftai/directive/904", cacheRoot);
    try {
      rmSync(join(arch, "archive-meta.json"), { force: true });
    } catch {
      /* ok */
    }

    const listed = listArchivedEntries({
      cacheRoot,
      repo: "deftai/directive",
      since: "2020-01-01T00:00:00Z",
      limit: 1,
    });
    expect(listed.count).toBe(1);

    const filteredOut = listArchivedEntries({
      cacheRoot,
      repo: "other/repo",
    });
    expect(filteredOut.count).toBe(0);
  });

  it("already-archived, identical restore, and mtime age basis", () => {
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));

    // mtime basis: closed, no closed_at, no usable fetched_at
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/906",
      {
        number: 906,
        title: "mtime",
        body: "x",
        state: "closed",
      },
      { fetched_at: "not-a-date" },
    );
    const age = resolveClosedAge(
      { state: "closed" },
      { fetched_at: "not-a-date" },
      join(cacheRoot, "github-issue/deftai/directive/906/meta.json"),
      clock.now(),
    );
    expect(age.ageBasis).toBe("mtime");

    // archive one entry then leave only archive (simulate already-archived scan)
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/907",
      {
        number: 907,
        title: "arch",
        body: "same",
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );
    archiveClosedEntries({ cacheRoot, projectRoot, olderThanDays: 30, clock });

    // Put a meta-only path under live that points at same key as archive? already-archived:
    // archive exists, live does not — walk only live tree so we need live meta walk empty for 907.
    // Instead create live+archive both: re-archive refuse
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/907",
      {
        number: 907,
        title: "arch",
        body: "same",
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );
    // archive still there from first pass
    const re = archiveClosedEntries({ cacheRoot, projectRoot, olderThanDays: 30, clock });
    expect(re.skipped.some((s) => s.reason === "already-archived")).toBe(true);

    // identical content restore
    const identical = restoreFromArchive({
      cacheRoot,
      issue: 907,
      repo: "deftai/directive",
      clock,
    });
    expect(identical.status).toBe("already-live");
    expect(identical.detail).toMatch(/matches/);

    // live present, archive gone after we remove archive
    rmSync(archivedEntryDir("github-issue", "deftai/directive/907", cacheRoot), {
      recursive: true,
      force: true,
    });
    const liveOnly = restoreFromArchive({
      cacheRoot,
      key: "deftai/directive/907",
    });
    expect(liveOnly.status).toBe("already-live");

    expect(() => restoreFromArchive({ cacheRoot })).toThrow(/--issue/);

    // unreadable raw
    const badDir = join(cacheRoot, "github-issue/deftai/directive/908");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "raw.json"), "not-json", "utf8");
    writeFileSync(
      join(badDir, "meta.json"),
      JSON.stringify({
        source: "github-issue",
        key: "deftai/directive/908",
        fetched_at: "2020-01-01T00:00:00Z",
        ttl_seconds: 1,
        expires_at: "2020-01-02T00:00:00Z",
        scan_result: {
          passed: true,
          scanned_at: "2020-01-01T00:00:00Z",
          scanner_version: "1",
          flags: [],
        },
        size_bytes: 1,
        stale: false,
      }),
      "utf8",
    );
    const badRaw = archiveClosedEntries({
      cacheRoot,
      projectRoot,
      olderThanDays: 30,
      dryRun: true,
      clock,
    });
    expect(badRaw.skipped.some((s) => s.reason === "missing-raw" && s.detail)).toBe(true);
  });

  it("CLI help and force restore paths", async () => {
    const { main } = await import("./main.js");
    expect(main(["archive-closed", "--help"])).toBe(0);
    expect(main(["archive-list", "--help"])).toBe(0);
    expect(main(["restore-from-archive", "--help"])).toBe(0);
    expect(main(["archive-closed", "--bogus"])).toBe(1);

    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/905",
      {
        number: 905,
        title: "cli-force",
        body: "orig",
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );
    expect(
      main([
        "archive-closed",
        "--older-than-days",
        "1",
        "--cache-root",
        cacheRoot,
        "--project-root",
        projectRoot,
      ]),
    ).toBe(0);
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/905",
      {
        number: 905,
        title: "conflict",
        body: "new",
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );
    expect(
      main([
        "restore-from-archive",
        "--issue",
        "905",
        "--repo",
        "deftai/directive",
        "--cache-root",
        cacheRoot,
      ]),
    ).toBe(1);
    expect(
      main([
        "restore-from-archive",
        "--issue",
        "905",
        "--repo",
        "deftai/directive",
        "--force",
        "--json",
        "--cache-root",
        cacheRoot,
      ]),
    ).toBe(0);
    expect(main(["archive-list", "--format", "text", "--cache-root", cacheRoot])).toBe(0);
  });
});

describe("CLI main archive surface", () => {
  it("archive-closed --dry-run and archive-list --format=json and restore", async () => {
    const { main } = await import("./main.js");
    const projectRoot = tempRoot();
    const cacheRoot = join(projectRoot, ".deft-cache");
    writeLiveEntry(
      cacheRoot,
      "deftai/directive/800",
      {
        number: 800,
        title: "cli",
        body: "x",
        state: "closed",
        closed_at: "2020-01-01T00:00:00Z",
      },
      { fetched_at: "2020-01-01T00:00:00Z" },
    );

    const prevCwd = process.cwd();
    try {
      process.chdir(projectRoot);
      expect(
        main([
          "archive-closed",
          "--dry-run",
          "--older-than-days",
          "30",
          "--project-root",
          projectRoot,
          "--cache-root",
          cacheRoot,
          "--json",
        ]),
      ).toBe(0);
      expect(
        main([
          "archive-closed",
          "--older-than-days",
          "30",
          "--project-root",
          projectRoot,
          "--cache-root",
          cacheRoot,
        ]),
      ).toBe(0);
      expect(main(["archive-list", "--format=json", "--cache-root", cacheRoot])).toBe(0);
      expect(
        main([
          "restore-from-archive",
          "--issue",
          "800",
          "--repo",
          "deftai/directive",
          "--cache-root",
          cacheRoot,
        ]),
      ).toBe(0);
      expect(
        main(["restore-from-archive", "--key", "deftai/directive/404", "--cache-root", cacheRoot]),
      ).toBe(1);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
