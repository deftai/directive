/**
 * #6849: the nightly reporter keeps one durable tracking issue per lane,
 * comments once per run id and attempt, writes missing values as unknown and
 * never mentions coverage debt.
 */
import { describe, expect, it } from "vitest";
import {
  buildComment,
  classifyLane,
  commentMarker,
  ISSUE_CREATOR,
  issueBody,
  issueMarker,
  issueTitle,
  LANES,
  parseCoverageTotals,
  parseVitestReport,
  runReport,
} from "../../../../../.github/scripts/nightly-report.mjs";

interface FakeIssue {
  number: number;
  state: string;
  body: string;
  assignees: { login: string }[];
  comments: string[];
}

/** In-memory GitHub for the gh argv the reporter sends. */
function fakeGitHub(initial: FakeIssue[] = []) {
  const issues = initial.map((i) => ({ ...i, comments: [...i.comments] }));
  const bodies = new Map<string, string>();
  const calls: string[][] = [];
  let next = 100;
  const byNumber = (n: string) => {
    const issue = issues.find((i) => i.number === Number(n));
    if (issue === undefined) throw new Error(`no issue ${n}`);
    return issue;
  };
  const gh = (args: string[]): string => {
    calls.push(args);
    const [verb, sub] = args;
    if (verb === "api") {
      const path = args[args.length - 1] as string;
      expect(args).toContain("--slurp");
      const comments = /issues\/(\d+)\/comments/.exec(path);
      if (comments) {
        return JSON.stringify([byNumber(comments[1] as string).comments.map((body) => ({ body }))]);
      }
      expect(path).toContain(`creator=${encodeURIComponent(ISSUE_CREATOR)}`);
      expect(path).toContain("state=all");
      return JSON.stringify([
        issues.map((i) => ({
          number: i.number,
          state: i.state,
          body: i.body,
          assignees: i.assignees,
        })),
      ]);
    }
    const bodyFile = () => {
      const at = args.indexOf("--body-file");
      expect(at).toBeGreaterThan(0);
      const text = bodies.get(args[at + 1] as string);
      expect(text).toBeDefined();
      return text as string;
    };
    if (verb === "issue" && sub === "create") {
      next += 1;
      const assignee = args.includes("--assignee") ? args[args.indexOf("--assignee") + 1] : null;
      issues.push({
        number: next,
        state: "open",
        body: bodyFile(),
        assignees: assignee ? [{ login: assignee }] : [],
        comments: [],
      });
      return `https://github.com/o/r/issues/${next}\n`;
    }
    const issue = byNumber(args[2] as string);
    if (sub === "comment") issue.comments.push(bodyFile());
    else if (sub === "reopen") issue.state = "open";
    else if (sub === "close") issue.state = "closed";
    else if (sub === "edit")
      issue.assignees.push({ login: args[args.indexOf("--add-assignee") + 1] as string });
    else throw new Error(`unexpected gh ${args.join(" ")}`);
    return "";
  };
  let fileNo = 0;
  const writeBody = (name: string, text: string): string => {
    fileNo += 1;
    const path = `/tmp/${fileNo}-${name}`;
    bodies.set(path, text);
    return path;
  };
  return { gh, writeBody, issues, calls };
}

const VITEST_FAIL = JSON.stringify({
  testResults: [
    {
      name: "/w/packages/core/src/a.test.ts",
      status: "failed",
      assertionResults: [
        { status: "failed", fullName: "a fails" },
        { status: "passed", fullName: "a passes" },
      ],
    },
    { name: "/w/packages/core/src/b.test.ts", status: "passed", assertionResults: [] },
  ],
});

const SUMMARY = JSON.stringify({
  total: {
    lines: { pct: 81.5 },
    statements: { pct: 80.1 },
    functions: { pct: 77 },
    branches: { pct: 74.9 },
  },
});

function env(needs: Record<string, unknown>, extra: Record<string, string> = {}) {
  return {
    REPO: "o/r",
    RUN_ID: "555",
    RUN_ATTEMPT: "1",
    HEAD_SHA: "c".repeat(40),
    SERVER_URL: "https://github.com",
    NIGHTLY_OWNER: "scott",
    ARTIFACT_DIR: "art",
    GITHUB_WORKSPACE: "/w",
    NEEDS_JSON: JSON.stringify(needs),
    ...extra,
  };
}

const RED = {
  coverage: { result: "failure", outputs: { setup: "ok", tests: "failure" } },
  windows: { result: "failure", outputs: { setup: "ok", tests: "failure" } },
};
const GREEN = {
  coverage: { result: "success", outputs: { setup: "ok", tests: "success" } },
  windows: { result: "success", outputs: { setup: "ok", tests: "success" } },
};

function files(map: Record<string, string>) {
  return (path: string): string | null => map[path.replaceAll("\\", "/")] ?? null;
}

const RED_FILES = files({
  "art/nightly-coverage/nightly-report/vitest.json": VITEST_FAIL,
  "art/nightly-coverage/coverage/coverage-summary.json": SUMMARY,
  "art/nightly-windows/vitest.json": VITEST_FAIL,
});

function deps(fake: ReturnType<typeof fakeGitHub>, readFile = RED_FILES) {
  const summaries: string[] = [];
  return {
    deps: {
      gh: fake.gh,
      writeBody: fake.writeBody,
      readFile,
      summary: (t: string) => summaries.push(t),
    },
    summaries,
  };
}

describe("lane classification (#6849 clause 5)", () => {
  it("maps job and step results to the five outcome classes", () => {
    expect(classifyLane({ result: "success" }, false)).toBe("passed");
    expect(classifyLane({ result: "cancelled" }, false)).toBe("timed-out-or-cancelled");
    expect(classifyLane({ result: "failure", outputs: {} }, false)).toBe("setup-failure");
    expect(
      classifyLane({ result: "failure", outputs: { setup: "ok", tests: "failure" } }, true),
    ).toBe("test-failure");
    expect(
      classifyLane({ result: "failure", outputs: { setup: "ok", tests: "failure" } }, false),
    ).toBe("report-unavailable");
    expect(classifyLane({ result: "failure", outputs: { setup: "ok", tests: "" } }, false)).toBe(
      "timed-out-or-cancelled",
    );
    expect(
      classifyLane({ result: "failure", outputs: { setup: "ok", tests: "cancelled" } }, false),
    ).toBe("timed-out-or-cancelled");
    expect(
      classifyLane({ result: "failure", outputs: { setup: "ok", tests: "success" } }, true),
    ).toBe("report-unavailable");
    expect(classifyLane({ result: "skipped" }, false)).toBe("report-unavailable");
    expect(classifyLane(undefined, false)).toBe("report-unavailable");
  });
});

describe("report parsing", () => {
  it("lists failing test files relative to the workspace, and null without a report", () => {
    expect(parseVitestReport(VITEST_FAIL, "/w")).toEqual([
      { file: "packages/core/src/a.test.ts", tests: ["a fails"] },
    ]);
    expect(parseVitestReport(null)).toBeNull();
    expect(parseVitestReport("not json")).toBeNull();
    expect(parseVitestReport("{}")).toBeNull();
  });

  it("reads the four totals and leaves a missing total null, never zero", () => {
    expect(parseCoverageTotals(SUMMARY)).toEqual({
      lines: 81.5,
      statements: 80.1,
      functions: 77,
      branches: 74.9,
    });
    expect(parseCoverageTotals(JSON.stringify({ total: { lines: { pct: 50 } } }))).toEqual({
      lines: 50,
      statements: null,
      functions: null,
      branches: null,
    });
    expect(parseCoverageTotals(null).lines).toBeNull();
    expect(parseCoverageTotals("x").branches).toBeNull();
  });
});

describe("tracking issues (#6849 clauses 13, 14, 16)", () => {
  it("creates one issue per red lane, assigned to NIGHTLY_OWNER, with no coverage-debt wording", () => {
    const fake = fakeGitHub();
    const { deps: d } = deps(fake);
    runReport(env(RED), d);
    expect(fake.issues).toHaveLength(2);
    for (const [i, lane] of LANES.entries()) {
      const issue = fake.issues[i] as FakeIssue;
      expect(issue.body).toContain(issueMarker(lane.id));
      expect(issue.assignees.map((a) => a.login)).toEqual(["scott"]);
      expect(issue.comments).toHaveLength(1);
      expect(`${issueTitle(lane)}\n${issue.body}\n${issue.comments[0]}`).not.toMatch(
        /coverage-debt/i,
      );
    }
    const created = fake.calls.filter((c) => c[0] === "issue" && c[1] === "create");
    expect(created).toHaveLength(2);
    expect(created.every((c) => c.includes("--body-file"))).toBe(true);
  });

  it("reopens a closed tracking issue and creates no second one", () => {
    const fake = fakeGitHub([
      {
        number: 7,
        state: "closed",
        body: issueBody(LANES[0]),
        assignees: [{ login: "scott" }],
        comments: [],
      },
    ]);
    runReport(env(RED), deps(fake).deps);
    const coverage = fake.issues.filter((i) => i.body.includes(issueMarker("coverage")));
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.state).toBe("open");
    expect(fake.calls.some((c) => c[1] === "reopen" && c[2] === "7")).toBe(true);
  });

  it("posts one comment when the reporter runs twice for the same run id and attempt", () => {
    const fake = fakeGitHub();
    runReport(env(RED), deps(fake).deps);
    runReport(env(RED), deps(fake).deps);
    for (const issue of fake.issues) expect(issue.comments).toHaveLength(1);
    runReport(env(RED, { RUN_ATTEMPT: "2" }), deps(fake).deps);
    for (const issue of fake.issues) expect(issue.comments).toHaveLength(2);
  });

  it("comments on and closes an open issue when the lane passes", () => {
    const fake = fakeGitHub([
      { number: 8, state: "open", body: issueBody(LANES[1]), assignees: [], comments: [] },
    ]);
    const { deps: d, summaries } = deps(fake, files({}));
    const lines = runReport(env(GREEN, { NIGHTLY_OWNER: "" }), d);
    const windows = fake.issues[0] as FakeIssue;
    expect(windows.state).toBe("closed");
    expect(windows.comments).toHaveLength(1);
    expect(windows.comments[0]).toContain("**Nightly full suite (Windows)**: passed");
    expect(lines.join("\n")).toContain("commented on and closed #8");
    expect(fake.calls.some((c) => c[1] === "create")).toBe(false);
    expect(summaries.join("")).toMatch(/NIGHTLY_OWNER is not set: no one was assigned/);
  });

  it("ignores issues without the lane marker and pull requests", () => {
    const fake = fakeGitHub([
      { number: 3, state: "open", body: "unrelated", assignees: [], comments: [] },
    ]);
    runReport(env(RED), deps(fake).deps);
    expect(fake.issues).toHaveLength(3);
  });

  it("adds the owner to an existing issue that lacks them", () => {
    const fake = fakeGitHub([
      { number: 9, state: "open", body: issueBody(LANES[0]), assignees: [], comments: [] },
    ]);
    runReport(env(RED), deps(fake).deps);
    expect(fake.calls.some((c) => c[1] === "edit" && c.includes("--add-assignee"))).toBe(true);
  });
});

describe("comment contents (#6849 clauses 5, 15)", () => {
  const base = {
    sha: "c".repeat(40),
    runId: "555",
    attempt: "2",
    runUrl: "https://github.com/o/r/actions/runs/555/attempts/2",
  };

  it("names the lane, outcome, SHA, run id, attempt, run URL, failing files and totals", () => {
    const body = buildComment({
      ...base,
      lane: LANES[0],
      outcome: "test-failure",
      failing: parseVitestReport(VITEST_FAIL, "/w"),
      totals: parseCoverageTotals(SUMMARY),
    });
    expect(body).toContain(commentMarker("coverage", "555", "2"));
    expect(body).toContain("**Nightly coverage (Linux)**: test-failure");
    expect(body).toContain(`SHA: ${"c".repeat(40)}`);
    expect(body).toContain("Run: 555 attempt 2");
    expect(body).toContain(base.runUrl);
    expect(body).toContain("`packages/core/src/a.test.ts`");
    expect(body).toContain("lines 81.5%, statements 80.1%, functions 77%, branches 74.9%");
  });

  it("names a timeout or setup failure and writes missing totals and files as unknown", () => {
    for (const outcome of ["timed-out-or-cancelled", "setup-failure"]) {
      const body = buildComment({ ...base, lane: LANES[0], outcome, failing: null, totals: null });
      expect(body).toContain(`: ${outcome}`);
      expect(body).toContain("Failing test files: unknown (no test report)");
      expect(body).toContain(
        "lines unknown, statements unknown, functions unknown, branches unknown",
      );
      expect(body).not.toMatch(/\b0%/);
    }
    const windows = buildComment({
      ...base,
      lane: LANES[1],
      outcome: "setup-failure",
      failing: null,
      totals: null,
    });
    expect(windows).not.toContain("Coverage totals");
  });

  it("classifies a timed-out lane from the run and reports it through the issue", () => {
    const fake = fakeGitHub();
    runReport(
      env({
        coverage: { result: "failure", outputs: { setup: "ok", tests: "" } },
        windows: { result: "failure", outputs: {} },
      }),
      deps(fake, files({})).deps,
    );
    expect(fake.issues[0]?.comments[0]).toContain(": timed-out-or-cancelled");
    expect(fake.issues[0]?.comments[0]).toContain("lines unknown");
    expect(fake.issues[1]?.comments[0]).toContain(": setup-failure");
  });

  it("fails loudly when REPO is missing or gh create returns no URL", () => {
    expect(() =>
      runReport({}, { gh: () => "[]", writeBody: () => "f", readFile: () => null }),
    ).toThrow(/REPO is not set/);
    const noUrl = (args: string[]) => (args[0] === "api" ? "[[]]" : "oops");
    expect(() =>
      runReport(env(RED), {
        gh: noUrl,
        writeBody: () => "f",
        readFile: () => null,
        summary: () => {},
      }),
    ).toThrow(/no issue URL/);
  });
});
