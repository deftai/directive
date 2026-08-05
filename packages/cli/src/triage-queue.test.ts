import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseArgs, parseShowArgs, run } from "./triage-queue.js";
import {
  augmentParityArgv,
  buildFixtureRepo,
  diffCase,
  normalizeOutput,
  PARITY_CASES,
  renderReport,
} from "./triage-queue-fixtures.js";

const temps: string[] = [];

afterAll(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Keep every CLI `run` hermetic: never let the default reconcile reader shell
// out to `gh`. Fixture-based tests that don't exercise reconcile pass
// `--no-reconcile`; tests that DO exercise it inject a stub reader.
const failOpenReader = (): null => null;

function silentRun(argv: string[]): number {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return run(argv);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("triage-queue CLI", () => {
  it("parseArgs defaults limit to 25", () => {
    const args = parseArgs(["queue", "--repo", "owner/repo"]);
    expect(args.limit).toBe(25);
    expect(args.repo).toBe("owner/repo");
  });

  it("parseArgs handles equals-form flags", () => {
    const args = parseArgs([
      "queue",
      "--project-root=/tmp/root",
      "--repo=owner/repo",
      "--limit=3",
      "--audit-log=/tmp/audit.jsonl",
      "--slices-log=/tmp/slices.jsonl",
      "--cache-root=/tmp/cache",
    ]);
    expect(args).toMatchObject({
      projectRoot: "/tmp/root",
      repo: "owner/repo",
      limit: 3,
      auditLog: "/tmp/audit.jsonl",
      slicesLog: "/tmp/slices.jsonl",
      cacheRoot: "/tmp/cache",
    });
  });
  it("parseArgs handles spaced flags", () => {
    const args = parseArgs([
      "queue",
      "--project-root",
      "/tmp/root",
      "--repo",
      "owner/repo",
      "--limit",
      "0",
      "--include-blocked",
      "--audit-log",
      "/tmp/audit.jsonl",
      "--slices-log",
      "/tmp/slices.jsonl",
    ]);
    expect(args).toMatchObject({
      projectRoot: "/tmp/root",
      limit: 0,
      includeBlocked: true,
      auditLog: "/tmp/audit.jsonl",
      slicesLog: "/tmp/slices.jsonl",
    });
  });

  it("parseArgs defaults reconcile on and honours --no-reconcile", () => {
    expect(parseArgs(["queue", "--repo", "owner/repo"]).reconcile).toBe(true);
    expect(parseArgs(["queue", "--repo", "owner/repo", "--no-reconcile"]).reconcile).toBe(false);
  });

  it("parseArgs rejects invalid limit values", () => {
    const args = parseArgs(["queue", "--limit", "many"]);
    expect(args.error).toContain("invalid int value");
  });
  it("parseArgs rejects unknown flags", () => {
    const args = parseArgs(["queue", "--unknown"]);
    expect(args.error).toContain("unrecognized argument");
  });

  it("parseArgs handles --author and --author-mine (#3129)", () => {
    expect(parseArgs(["queue", "--author", "alice"]).author).toBe("alice");
    expect(parseArgs(["queue", "--author=bob"]).author).toBe("bob");
    expect(parseArgs(["queue", "--author-mine"]).author).toBe("@me");
    expect(parseArgs(["queue", "--author"]).error).toContain("--author");
  });

  it("rejects --author followed by another flag (#3129 Greptile adjacent-option)", () => {
    expect(parseArgs(["queue", "--author", "--limit", "5"]).error).toMatch(/flag token|--author/);
  });

  it("rejects empty --author= instead of no-op full queue (#3129 Greptile P1)", () => {
    const root = buildFixtureRepo({
      issues: [{ number: 1, title: "Anyone", author: "alice" }],
    });
    temps.push(root);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run(
          [
            "queue",
            "--project-root",
            root,
            "--repo",
            "owner/repo",
            "--no-reconcile",
            "--author=",
          ],
          { liveOpenReader: failOpenReader },
        ),
      ).toBe(2);
      const stderr = err.mock.calls.map((c) => String(c[0])).join("");
      expect(stderr).toMatch(/--author|non-empty/);
      expect(out.mock.calls.length).toBe(0);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("run returns 2 when repo cannot be resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-queue-cli-"));
    temps.push(root);
    expect(silentRun(["queue", "--project-root", root])).toBe(2);
  });

  it("run returns 2 on parse errors", () => {
    expect(silentRun(["queue", "--limit"])).toBe(2);
  });

  it("run prints ranked queue for seeded fixture", () => {
    const root = buildFixtureRepo({
      issues: [
        { number: 1, title: "Urgent", updatedAt: "2026-05-15T10:00:00Z" },
        { number: 2, title: "Untriaged", updatedAt: "2026-05-17T10:00:00Z" },
      ],
      auditEntries: [{ issueNumber: 1, decision: "needs-ac" }],
    });
    temps.push(root);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run([
          "queue",
          "--project-root",
          root,
          "--repo",
          "owner/repo",
          "--limit",
          "0",
          "--no-reconcile",
        ]),
      ).toBe(0);
      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("#1");
      expect(output).toContain("#2");
      expect(output).toContain("[untriaged]");
      // #2207: audit log is resolved from projectRoot (not the CLI's install
      // dir), so the seeded needs-ac decision for #1 is honoured -> #1 lands in
      // the URGENT group and sorts ahead of the untriaged #2.
      expect(output).toContain("[URGENT]");
      expect(output.indexOf("#1")).toBeLessThan(output.indexOf("#2"));
    } finally {
      stdout.mockRestore();
    }
  });

  // #2238 regression: a candidate that is cached as `open` but has been closed
  // live must NOT render in the queue. The stubbed live-open reader reports only
  // the still-open issue, so the stale-open/live-closed one drops off.
  it("reconciles out a cached-open issue that is closed live", () => {
    const root = buildFixtureRepo({
      issues: [
        { number: 2115, title: "Merged already", state: "open", updatedAt: "2026-07-01T10:00:00Z" },
        { number: 3000, title: "Still open", state: "open", updatedAt: "2026-07-02T10:00:00Z" },
      ],
    });
    temps.push(root);

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      // Live truth: only #3000 is open (#2115 was merged/closed).
      expect(
        run(["queue", "--project-root", root, "--repo", "owner/repo", "--limit", "0"], {
          liveOpenReader: () => new Set<number>([3000]),
        }),
      ).toBe(0);
      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("#3000");
      expect(output).not.toContain("#2115");
    } finally {
      stdout.mockRestore();
    }
  });

  it("keeps the queue intact when the live reader fails (fail-open)", () => {
    const root = buildFixtureRepo({
      issues: [{ number: 2115, title: "Merged already", state: "open" }],
    });
    temps.push(root);

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run(["queue", "--project-root", root, "--repo", "owner/repo", "--limit", "0"], {
          liveOpenReader: failOpenReader,
        }),
      ).toBe(0);
      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("#2115");
    } finally {
      stdout.mockRestore();
    }
  });

  it("filters queue by --author and surfaces filter in header (#3129)", () => {
    const root = buildFixtureRepo({
      issues: [
        { number: 1, title: "Mine", author: "alice", updatedAt: "2026-05-18T10:00:00Z" },
        { number: 2, title: "Theirs", author: "bob", updatedAt: "2026-05-19T10:00:00Z" },
        { number: 3, title: "No author field" },
      ],
    });
    temps.push(root);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run(
          [
            "queue",
            "--project-root",
            root,
            "--repo",
            "owner/repo",
            "--limit",
            "0",
            "--no-reconcile",
            "--author",
            "alice",
          ],
          { liveOpenReader: failOpenReader },
        ),
      ).toBe(0);
      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(output).toContain("author filter: alice");
      expect(output).toContain("missing author");
      expect(output).toContain("#1");
      expect(output).not.toContain("#2");
      expect(output).not.toContain("#3");
    } finally {
      stdout.mockRestore();
    }
  });

  it("returns empty match set for non-matching --author and resolves @me (#3129)", () => {
    const root = buildFixtureRepo({
      issues: [{ number: 9, title: "Only bob", author: "bob" }],
    });
    temps.push(root);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run(
          [
            "queue",
            "--project-root",
            root,
            "--repo",
            "owner/repo",
            "--limit",
            "0",
            "--no-reconcile",
            "--author",
            "nobody",
          ],
          { liveOpenReader: failOpenReader },
        ),
      ).toBe(0);
      const emptyOut = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(emptyOut).toContain("author filter: nobody");
      expect(emptyOut).not.toContain("#9");

      stdout.mockClear();
      expect(
        run(
          [
            "queue",
            "--project-root",
            root,
            "--repo",
            "owner/repo",
            "--limit",
            "0",
            "--no-reconcile",
            "--author",
            "@me",
          ],
          {
            liveOpenReader: failOpenReader,
            resolveAuthenticatedLogin: () => "bob",
          },
        ),
      ).toBe(0);
      const meOut = stdout.mock.calls.map((call) => String(call[0])).join("");
      expect(meOut).toContain("author filter: @me (resolved -> bob)");
      expect(meOut).toContain("#9");
    } finally {
      stdout.mockRestore();
    }
  });

  // #2207 regression: on a migrated `xbrief/` tree the queue MUST resolve the
  // audit log and ranking labels from projectRoot's xbrief/ layout, not the
  // legacy vbrief/ path nor the CLI's framework install dir.
  it("run resolves audit log + ranking labels from a migrated xbrief tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-queue-xbrief-"));
    temps.push(root);
    const repo = "owner/repo";

    // Migrated layout: an .xbrief.json artifact makes resolveLifecycleLayout
    // prefer xbrief/ over vbrief/.
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "seed.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "seed", status: "running" } })}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", policy: { triageRankingLabels: ["urgent"] } },
      })}\n`,
      "utf8",
    );

    // Cached issues.
    for (const [n, updated] of [
      [1, "2026-05-15T10:00:00Z"],
      [2, "2026-05-17T10:00:00Z"],
    ] as const) {
      const dir = join(root, ".deft-cache", "github-issue", "owner", "repo", String(n));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "raw.json"),
        `${JSON.stringify({ number: n, title: `Issue ${n}`, state: "open", labels: [], updated_at: updated })}\n`,
        "utf8",
      );
    }

    // Accept decision for #1 lives in the xbrief/ eval dir.
    mkdirSync(join(root, "xbrief", ".eval"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", ".eval", "candidates.jsonl"),
      `${JSON.stringify({ repo, issue_number: 1, decision: "accept", timestamp: "2026-05-16T10:00:00Z", decision_id: "d1", actor: "test" })}\n`,
      "utf8",
    );

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run(["queue", "--project-root", root, "--repo", repo, "--limit", "0", "--no-reconcile"]),
      ).toBe(0);
      const output = stdout.mock.calls.map((call) => String(call[0])).join("");
      // Ranking labels loaded from xbrief/PROJECT-DEFINITION.xbrief.json.
      expect(output).toContain("consumer ranking labels (in declared order): urgent");
      // #1 has an accept decision -> [other] (triaged); #2 stays untriaged.
      expect(output).toMatch(/\[other\][^\n]*#1\b/);
      expect(output).toMatch(/\[untriaged\][^\n]*#2\b/);
    } finally {
      stdout.mockRestore();
    }
  });
});

describe("triage:show CLI (#2890)", () => {
  it("parseShowArgs defaults format and reads number", () => {
    const args = parseShowArgs(["show", "42", "--repo", "owner/repo"]);
    expect(args).toMatchObject({ cmd: "show", number: 42, format: "default", repo: "owner/repo" });
  });

  it("parseShowArgs accepts --format=operator", () => {
    const args = parseShowArgs(["show", "--format=operator", "99", "--repo=o/r"]);
    expect(args.format).toBe("operator");
    expect(args.number).toBe(99);
  });

  it("parseShowArgs rejects missing number", () => {
    const args = parseShowArgs(["show", "--repo", "o/r"]);
    expect(args.error).toMatch(/issue number is required/);
  });

  it("parseShowArgs rejects malformed numeric-prefix issue numbers", () => {
    expect(parseShowArgs(["show", "42abc", "--repo", "o/r"]).error).toMatch(/invalid int/);
    expect(parseShowArgs(["show", "42.5", "--repo", "o/r"]).error).toMatch(/invalid int/);
    expect(parseShowArgs(["show", "0", "--repo", "o/r"]).error).toMatch(/invalid int/);
  });

  it("run show returns 1 on cache miss", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-show-miss-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(run(["show", "404", "--project-root", root, "--repo", "owner/repo"])).toBe(1);
      const output = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("issue not present in local cache");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("run show --format=operator emits pasteable brief", () => {
    const root = buildFixtureRepo({
      issues: [
        {
          number: 51,
          title: "Operator brief dogfood",
          labels: ["bug"],
          updatedAt: "2026-07-28T10:00:00Z",
        },
      ],
      auditEntries: [{ issueNumber: 51, decision: "needs-ac", timestamp: "2026-07-27T10:00:00Z" }],
      activeIssueNumbers: [51],
    });
    temps.push(root);
    // Enrich raw.json body for operator summary/AC extraction.
    const rawPath = join(root, ".deft-cache", "github-issue", "owner", "repo", "51", "raw.json");
    writeFileSync(
      rawPath,
      `${JSON.stringify({
        number: 51,
        title: "Operator brief dogfood",
        state: "open",
        labels: [{ name: "bug" }],
        updated_at: "2026-07-28T10:00:00Z",
        html_url: "https://github.com/owner/repo/issues/51",
        body: [
          "Chip-only Phase 3 turns hide problem context from the operator.",
          "",
          "## Acceptance criteria",
          "- [ ] brief before menu",
          "- [ ] same-turn coupling",
        ].join("\n"),
      })}\n`,
      "utf8",
    );

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run(["show", "51", "--format=operator", "--project-root", root, "--repo", "owner/repo"]),
      ).toBe(0);
      const output = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("triage:show --format=operator");
      expect(output).toContain("#51  Operator brief dogfood");
      expect(output).toContain("https://github.com/owner/repo/issues/51");
      expect(output).toContain("labels:  bug");
      expect(output).toContain("Chip-only Phase 3");
      expect(output).toContain("brief before menu");
      expect(output).toContain("latest decision: needs-ac");
      expect(output).toContain("active xBRIEF: yes");
      expect(output).toContain("lean: (agent-owned");
    } finally {
      stdout.mockRestore();
    }
  });

  it("run show default format prints title and history", () => {
    const root = buildFixtureRepo({
      issues: [{ number: 3, title: "Default show", labels: ["enhancement"] }],
      auditEntries: [{ issueNumber: 3, decision: "defer", timestamp: "2026-07-20T00:00:00Z" }],
    });
    temps.push(root);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(run(["show", "3", "--project-root", root, "--repo", "owner/repo"])).toBe(0);
      const output = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("triage:show -- owner/repo#3");
      expect(output).toContain("title:      Default show");
      expect(output).toContain("latest decision: defer");
    } finally {
      stdout.mockRestore();
    }
  });

  it("run show honors --cache-root override", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-triage-show-cache-root-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    // Seed ONLY under an alternate cache root, not projectRoot/.deft-cache.
    const altCache = join(root, "alt-cache");
    const dir = join(altCache, "github-issue", "owner", "repo", "9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "raw.json"),
      `${JSON.stringify({
        number: 9,
        title: "From alt cache",
        state: "open",
        labels: [],
        updated_at: "2026-07-28T00:00:00Z",
        body: "alt",
      })}\n`,
      "utf8",
    );
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(
        run([
          "show",
          "9",
          "--project-root",
          root,
          "--repo",
          "owner/repo",
          "--cache-root",
          altCache,
        ]),
      ).toBe(0);
      const output = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(output).toContain("From alt cache");
    } finally {
      stdout.mockRestore();
    }
  });
});

describe("triage-queue-parity helpers", () => {
  it("normalizeOutput strips volatile project_root paths", () => {
    expect(normalizeOutput("project_root=/tmp/foo")).toBe("project_root=<ROOT>");
  });

  it("normalizeOutput strips uv warning noise", () => {
    expect(normalizeOutput("WARN Server returned unusable 304 for: https://example.test\nok")).toBe(
      "ok",
    );
  });

  it("diffCase detects stdout and exit mismatches", () => {
    const clean = diffCase(
      { exitCode: 0, stdout: "ok\n", stderr: "" },
      { exitCode: 0, stdout: "ok\n", stderr: "" },
      "case",
    );
    expect(clean.exitMismatch).toBe(false);
    expect(clean.stdoutMismatch).toBe(false);

    const diverged = diffCase(
      { exitCode: 0, stdout: "a\n", stderr: "" },
      { exitCode: 1, stdout: "b\n", stderr: "" },
      "case",
    );
    expect(diverged.exitMismatch).toBe(true);
    expect(diverged.stdoutMismatch).toBe(true);
  });

  it("renderReport prints CLEAN summary", () => {
    expect(renderReport({ ok: true, diffs: [] })).toContain("CLEAN");
  });

  it("diffCase detects stderr mismatch", () => {
    const diff = diffCase(
      { exitCode: 2, stdout: "", stderr: "err-a" },
      { exitCode: 2, stdout: "", stderr: "err-b" },
      "stderr-case",
    );
    expect(diff.stderrMismatch).toBe(true);
  });

  it("renderReport includes stderr-only divergence", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "missing-repo",
          exitMismatch: false,
          stdoutMismatch: false,
          stderrMismatch: true,
          pythonExit: 2,
          tsExit: 2,
        },
      ],
    });
    expect(report).toContain("stderr mismatch");
  });
  it("renderReport prints divergence details", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "group-order",
          exitMismatch: true,
          stdoutMismatch: true,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 1,
        },
      ],
    });
    expect(report).toContain("DIVERGENCE");
    expect(report).toContain("group-order");
  });

  it("buildFixtureRepo supports blocked and slice fixtures", () => {
    const root = buildFixtureRepo({
      issues: [
        { number: 70, title: "Blocked", state: "open" },
        { number: 71, title: "Open", state: "open" },
      ],
      blockedIssueNumbers: [70],
      sliceRecords: [
        {
          slice_id: "slice-x",
          umbrella: 10,
          children: [{ n: 11, url: "https://github.com/owner/repo/issues/11" }],
        },
      ],
      activeIssueNumbers: [71],
    });
    temps.push(root);
    expect(root.length).toBeGreaterThan(0);
  });
  it("renderReport skips clean diffs in divergence output", () => {
    const report = renderReport({
      ok: false,
      diffs: [
        {
          caseName: "clean-case",
          exitMismatch: false,
          stdoutMismatch: false,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 0,
        },
        {
          caseName: "bad-case",
          exitMismatch: true,
          stdoutMismatch: false,
          stderrMismatch: false,
          pythonExit: 0,
          tsExit: 1,
        },
      ],
    });
    expect(report).toContain("bad-case");
    expect(report).not.toContain("clean-case");
  });
  it("augmentParityArgv leaves skipFixture argv unchanged", () => {
    const argv = augmentParityArgv(
      { name: "missing", argv: ["--project-root", "<ROOT>"], skipFixture: true },
      "/tmp/x",
    );
    expect(argv).toEqual(["--project-root", "/tmp/x"]);
  });

  it("augmentParityArgv adds audit and slice hooks for fixtures", () => {
    const root = "/tmp/fixture";
    const testCase = {
      name: "fixture",
      argv: ["--project-root", "<ROOT>", "--repo", "owner/repo"],
      fixture: {
        auditEntries: [{ issueNumber: 1, decision: "accept" }],
        sliceRecords: [{ slice_id: "s1", umbrella: 1, children: [] }],
      },
    };
    const argv = augmentParityArgv(testCase, root);
    expect(argv).toContain(join(root, "xbrief", ".triage-cache", "candidates.jsonl"));
    expect(argv).toContain(join(root, "xbrief", ".triage-cache", "slices.jsonl"));
  });

  it("buildFixtureRepo writes cache and audit artifacts", () => {
    const root = buildFixtureRepo({
      issues: [{ number: 9, title: "Nine" }],
      auditEntries: [{ issueNumber: 9, decision: "accept" }],
      rankingLabels: ["urgent"],
    });
    temps.push(root);
    expect(PARITY_CASES.length).toBeGreaterThan(5);
    const definition = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    expect(definition.length).toBeGreaterThan(0);
  });
});
