import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { RELEASE_CHECK_TIMEOUT_MINUTES } from "./constants.js";
import { NIGHTLY_COVERAGE_LANE_NAME, NIGHTLY_WINDOWS_LANE_NAME } from "./nightly-reuse.js";
import {
  ciReuseAtTip,
  formatReadiness,
  queueReport,
  type ReadinessInput,
  type ReadinessSeams,
  readinessCiLines,
  runReleaseReadiness,
  versionFileProblems,
} from "./run-readiness.js";
import type { ReleaseSeams, SpawnResult } from "./types.js";

const TIP = "a".repeat(40);
const TREE = "f".repeat(40);
const INPUT: ReadinessInput = {
  version: "1.2.0",
  repo: "o/r",
  baseBranch: "master",
  projectRoot: "/p",
  summary: null,
};

const ok = (stdout = ""): SpawnResult => ({ status: 0, stdout, stderr: "" });

function gitSeams(dirty = ""): ReleaseSeams {
  return {
    spawnText: (_cmd, args) => {
      if (args.includes("status")) return ok(dirty);
      if (args.includes("fetch")) return ok();
      if (args.includes("origin/master^{tree}")) return ok(`${TREE}\n`);
      if (args.includes("origin/master")) return ok(`${TIP}\n`);
      return ok();
    },
  };
}

function checkRuns(conclusion: string) {
  return JSON.stringify({
    total_count: 2,
    check_runs: [
      { id: 11, name: "TypeScript (build + lint)", status: "completed", conclusion },
      { id: 12, name: "Merge gate (task check)", status: "completed", conclusion: "success" },
    ],
  });
}

function fakeGh(
  opts: {
    conclusion?: string;
    rateLimit?: boolean;
    queued?: number[];
    /** #6849: Windows lane latest conclusion on the nightly run for TREE. */
    nightlyWindows?: string;
  } = {},
): RunGhFn {
  return (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("/actions/workflows/nightly.yml/runs")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 77,
              head_sha: TIP,
              head_commit: { tree_id: TREE },
              html_url: "https://github.com/o/r/actions/runs/77",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (joined.includes("/actions/runs/77/jobs")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          jobs: [
            { id: 1, name: NIGHTLY_COVERAGE_LANE_NAME, status: "completed", conclusion: "success" },
            {
              id: 2,
              name: NIGHTLY_WINDOWS_LANE_NAME,
              status: "completed",
              conclusion: opts.nightlyWindows ?? "success",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (joined.includes("rate_limit")) {
      return opts.rateLimit === false
        ? { returncode: 1, stdout: "", stderr: "HTTP 401" }
        : { returncode: 0, stdout: "{}", stderr: "" };
    }
    if (joined.includes("check-runs")) {
      return { returncode: 0, stdout: checkRuns(opts.conclusion ?? "success"), stderr: "" };
    }
    if (joined.includes("graphql")) {
      const nodes = (opts.queued ?? []).map((n) => ({ pullRequest: { number: n } }));
      return {
        returncode: 0,
        stdout: JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes } } } } }),
        stderr: "",
      };
    }
    if (joined.includes("/pulls?")) {
      // gh api --paginate --jq prints one armed PR number per line across pages.
      expect(cmd).toContain("--paginate");
      return { returncode: 0, stdout: "5\n105\n", stderr: "" };
    }
    return { returncode: 1, stdout: "", stderr: `unexpected ${joined}` };
  };
}

const MANIFESTS: Record<string, string> = {
  "/p/package.json": '{"version":"0.0.0"}',
  "/p/packages/core/package.json": '{"version":"0.0.0"}',
  "/p/CHANGELOG.md": "## [Unreleased]\n\n## [1.1.0] - 2026-11-01\n",
};

function readinessSeams(overrides: Partial<ReadinessSeams> = {}, dirty = ""): ReadinessSeams {
  return {
    release: gitSeams(dirty),
    dryRun: () => 0,
    tagFree: () => [true, "v1.2.0 not on origin"],
    readFile: (p) => {
      const key = p.replaceAll("\\", "/");
      const text = MANIFESTS[key];
      if (text === undefined) throw new Error(`missing ${key}`);
      return text;
    },
    listDir: () => ["core"],
    ...overrides,
  };
}

describe("release:run readiness (#6876 clause 2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes when every check passes and reports queued PRs and armed auto-merge without refusing", () => {
    const result = runReleaseReadiness(INPUT, readinessSeams(), fakeGh({ queued: [7] }));
    expect(result.ok).toBe(true);
    const queue = result.checks.find((c) => c.name.startsWith("Queued PRs"));
    expect(queue?.status).toBe("report");
    expect(queue?.detail).toContain("auto-merge armed on #5");
    expect(queue?.detail).toContain("auto-merge armed on #5, #105");
    expect(queue?.detail).toContain("queued: #7");
    expect(formatReadiness(result)).toContain("all checks passed; nothing written yet");
  });

  it("refuses when a Phase 1 check, the tag, the version files or the dry run fails", () => {
    const failing: Array<[string, ReadinessSeams, RunGhFn, string]> = [
      [
        "Phase 1: clean working tree",
        readinessSeams({}, " M x.ts"),
        fakeGh(),
        "readiness wrote nothing; working tree was dirty at readiness entry",
      ],
      [
        "Phase 1: GitHub usable",
        readinessSeams(),
        fakeGh({ rateLimit: false }),
        "refused: a readiness check failed; nothing was written",
      ],
      [
        "Tag v1.2.0 free",
        readinessSeams({ tagFree: () => [false, "tag on origin"] }),
        fakeGh(),
        "refused: a readiness check failed; nothing was written",
      ],
      [
        "Phase 2 dry run",
        readinessSeams({ dryRun: () => 1 }),
        fakeGh(),
        "refused: a readiness check failed; nothing was written",
      ],
      [
        "Consistent version files",
        readinessSeams({
          readFile: (p) =>
            p.endsWith("CHANGELOG.md") ? "## [1.2.0] - 2026-11-22\n" : '{"version":"0.0.0"}',
        }),
        fakeGh(),
        "refused: a readiness check failed; nothing was written",
      ],
    ];
    for (const [name, seams, gh, footer] of failing) {
      const result = runReleaseReadiness(INPUT, seams, gh);
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.name === name)?.status).toBe("fail");
      expect(formatReadiness(result)).toContain(footer);
    }
  });

  it("refuses with post-dry-run dirty wording when dry-run leaves porcelain (#7327)", () => {
    let statusCalls = 0;
    const seams = readinessSeams({
      release: {
        spawnText: (_cmd, args) => {
          if (args.includes("status")) {
            statusCalls += 1;
            // Entry clean; post-dry-run dirty (injected-dirt negative).
            return ok(statusCalls === 1 ? "" : " M .gitignore\n?? .deft/GENERATION.json\n");
          }
          if (args.includes("fetch")) return ok();
          if (args.includes("origin/master^{tree}")) return ok(`${TREE}\n`);
          if (args.includes("origin/master")) return ok(`${TIP}\n`);
          return ok();
        },
      },
      dryRun: () => 0,
    });
    const result = runReleaseReadiness(INPUT, seams, fakeGh());
    expect(result.ok).toBe(false);
    const post = result.checks.find((c) => c.name === "Phase 2: clean working tree after dry run");
    expect(post?.status).toBe("fail");
    expect(post?.detail).toContain("working tree is dirty after the dry-run");
    expect(post?.detail).toContain("M .gitignore");
    const formatted = formatReadiness(result);
    expect(formatted).toContain("working tree is dirty after the dry-run");
    expect(formatted).not.toContain("nothing was written");
  });

  it("finds differing workspace versions and an existing CHANGELOG section", () => {
    const files: Record<string, string> = {
      "/p/package.json": '{"version":"0.0.0"}',
      "/p/packages/a/package.json": '{"version":"0.1.0"}',
      "/p/packages/b/package.json": "not json",
      "/p/packages/c/package.json": "{}",
      "/p/CHANGELOG.md": "## [1.2.0] - 2026-11-22\n",
    };
    const read = (p: string) => {
      const text = files[p.replaceAll("\\", "/")];
      if (text === undefined) throw new Error("missing");
      return text;
    };
    const problems = versionFileProblems("/p", "1.2.0", read, () => ["a", "b", "c", "d"]);
    expect(problems.join("\n")).toContain("workspace package versions differ");
    expect(problems.join("\n")).toContain("packages/b/package.json is not JSON");
    expect(problems.join("\n")).toContain("packages/c/package.json has no version");
    expect(problems.join("\n")).toContain("already has a ## [1.2.0] section");
    expect(
      versionFileProblems(
        "/p",
        "1.2.0",
        () => {
          throw new Error("x");
        },
        () => [],
      ),
    ).toEqual(["package.json is unreadable", "CHANGELOG.md is unreadable"]);
  });
});

describe("release:run readiness CI lines (#6876 clause 13)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("always says reuse is provisional and how long the full check takes", () => {
    const reuse = runReleaseReadiness(INPUT, readinessSeams(), fakeGh());
    expect(reuse.ci.kind).toBe("reuse");
    const detail = reuse.checks.find((c) => c.name.startsWith("CI reuse"))?.detail ?? "";
    expect(detail).toContain("CI reuse is provisional");
    expect(detail).toContain(`up to ${RELEASE_CHECK_TIMEOUT_MINUTES} minutes`);
    expect(detail).toContain(TIP);
  });

  it("says before the mint that the full check will run when the latest attempt failed or is missing", () => {
    const failed = runReleaseReadiness(INPUT, readinessSeams(), fakeGh({ conclusion: "failure" }));
    expect(failed.ok).toBe(true);
    expect(failed.ci.kind).toBe("full");
    const lines = readinessCiLines(failed.ci).join("\n");
    expect(lines).toContain("CI reuse is provisional");
    expect(lines).toContain("the full local check will run at Step 5");
    const missing = readinessCiLines({
      kind: "full",
      reason: "required check 'x' is missing",
      tipSha: TIP,
    });
    expect(missing.join("\n")).toContain("the full local check will run at Step 5");
  });

  it("prints each nightly lane with status, run URL and head SHA (#6849 clause 6)", () => {
    const reuse = runReleaseReadiness(INPUT, readinessSeams(), fakeGh());
    expect(reuse.ci.kind).toBe("reuse");
    const detail = reuse.checks.find((c) => c.name.startsWith("CI reuse"))?.detail ?? "";
    expect(detail).toContain("Nightly coverage (Linux): reusable");
    expect(detail).toContain("Nightly full suite (Windows): reusable");
    expect(detail).toContain("https://github.com/o/r/actions/runs/77");
    expect(detail).toContain(`head ${TIP}`);
    expect(detail).not.toMatch(/gh workflow run/);
  });

  it("names a lane that is not reusable and why under tip-green smoke-only, and prints the dispatch command (#6849 / #7328)", () => {
    const red = runReleaseReadiness(
      INPUT,
      { ...readinessSeams(), platform: "win32" },
      fakeGh({ nightlyWindows: "failure" }),
    );
    expect(red.ok).toBe(true);
    expect(red.ci.kind).toBe("reuse");
    const detail = red.checks.find((c) => c.name.startsWith("CI reuse"))?.detail ?? "";
    expect(detail).toMatch(
      /Nightly full suite \(Windows\) not reusable \([^)]*concluded failure\): tip-green CI reuse continues with host smoke only/,
    );
    expect(detail).not.toMatch(/Nightly coverage \(Linux\) not reusable/);
    expect(detail).toContain("gh workflow run nightly.yml --repo o/r --ref master");
    expect(detail).toMatch(/Windows suite did not run for this release/);
    expect(detail).toMatch(/smoke-only tip-green reuse/);
  });

  it("says the Windows suite did not run on tip-green smoke-only independently of host OS (#7328)", () => {
    const red = runReleaseReadiness(
      INPUT,
      { ...readinessSeams(), platform: "linux" },
      fakeGh({ nightlyWindows: "failure" }),
    );
    const detail = red.checks.find((c) => c.name.startsWith("CI reuse"))?.detail ?? "";
    expect(detail).toMatch(/The Windows suite did not run for this release/);
    const unread = readinessCiLines(
      { kind: "full", reason: "offline", tipSha: null },
      { repo: "o/r", baseBranch: "master", platform: "darwin" },
    ).join("\n");
    expect(unread).toMatch(/Nightly lanes not reusable \(not read/);
    expect(unread).toContain("gh workflow run nightly.yml --repo o/r --ref master");
    expect(unread).toMatch(/runs on darwin, not Windows/);
    const seamed = ciReuseAtTip(INPUT, fakeGh(), gitSeams(), () => ({
      reusable: false,
      lanes: [],
    }));
    expect(seamed.kind).toBe("reuse");
  });

  it("falls back to the full check when the tip or its check runs cannot be read", () => {
    vi.stubEnv("DEFT_NO_NETWORK", "1");
    expect(ciReuseAtTip(INPUT, fakeGh(), gitSeams()).kind).toBe("full");
    vi.unstubAllEnvs();
    const badFetch: ReleaseSeams = {
      spawnText: () => ({ status: 1, stdout: "", stderr: "offline" }),
    };
    expect(ciReuseAtTip(INPUT, fakeGh(), badFetch)).toMatchObject({ kind: "full" });
    const noTip: ReleaseSeams = {
      spawnText: (_c, args) =>
        args.includes("fetch") ? ok() : { status: 1, stdout: "", stderr: "" },
    };
    expect(ciReuseAtTip(INPUT, fakeGh(), noTip)).toMatchObject({ kind: "full" });
    const ghDown: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "down" });
    expect(ciReuseAtTip(INPUT, ghDown, gitSeams())).toMatchObject({ kind: "full", tipSha: TIP });
  });
});

describe("release:run queue report (#6876)", () => {
  it("reports unreadable PR lists and merge queues instead of refusing", () => {
    const down: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "down" });
    expect(queueReport(INPUT, down)).toBe(
      "open PRs unreadable (down); merge queue unreadable (down)",
    );
    const garbage: RunGhFn = () => ({ returncode: 0, stdout: "nope", stderr: "" });
    expect(queueReport(INPUT, garbage)).toBe(
      "open PRs unreadable (unexpected output); merge queue unreadable (not JSON)",
    );
    const empty: RunGhFn = (cmd) => ({
      returncode: 0,
      stdout: cmd.join(" ").includes("graphql") ? JSON.stringify({ data: {} }) : "",
      stderr: "",
    });
    expect(queueReport(INPUT, empty)).toBe("no open PR has auto-merge armed; merge queue empty");
    const long: RunGhFn = (cmd) => ({
      returncode: 0,
      stdout: cmd.join(" ").includes("graphql")
        ? JSON.stringify({
            data: {
              repository: {
                mergeQueue: {
                  entries: { totalCount: 120, nodes: [{ pullRequest: { number: 9 } }] },
                },
              },
            },
          })
        : "",
      stderr: "",
    });
    expect(queueReport(INPUT, long)).toContain("queued: #9 (120 queued in all)");
  });
});
