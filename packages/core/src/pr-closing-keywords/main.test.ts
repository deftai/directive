import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { mintOnePrUnitGrant } from "../one-pr-unit/mint.js";
import { DirectiveGitHubAppStore } from "../one-pr-unit/store.js";
import { deriveUnmarkedFinalizeAdmit } from "../orphan-active/evaluate.js";
import {
  isProductPullRequestUnset,
  productPullRequestFromPlan,
  stampProductPullRequestOntoPlan,
} from "../orphan-active/running-briefs.js";
import { bindUnmarkedFinalizePair } from "../swarm/finalize-owed.js";
import { ENV_TRIAGE_REPO } from "../triage/queue/constants.js";
import { EXIT_CONFIG_ERROR, EXIT_HITS_FOUND, EXIT_OK } from "./constants.js";
import {
  briefHasMatchingProductPr,
  cmdPrCheckClosingKeywords,
  evaluateFullStoryMarkAdmission,
  evaluateStoryLineRequirement,
  findStoryLineConflicts,
  findUnparseableDeftStoryPartLines,
  fullStoryCloseIntentFromBody,
  isBriefLandShapedDiff,
  isLeftoverShapedDiff,
  isProductShapedDiff,
  isSkipActiveDeliveryShape,
  landsWithProductIssues,
  parseAllDeftStoryMarks,
  parseAllDeftStoryPartLines,
  parseAllowList,
  parseArgs,
  parseDeftStoryMark,
  parseStoryRefIssues,
  run,
  storyIssuesForBranch,
  storyLineAdvice,
  writeStoryLineToBodyFile,
} from "./main.js";
import type { ReadMergeBaseFileFn, RunGhFn } from "./types.js";

/** Empty merge-base stdout → collectLocalDiffFiles returns null → skip offline admission (#5736). */
const emptyGit: RunGhFn = () => ({ returncode: 0, stdout: "", stderr: "" });

describe("parseAllowList", () => {
  it("parses comma-separated and hash-prefixed tokens", () => {
    expect(parseAllowList(["100,200", "#300"])).toEqual(new Set([100, 200, 300]));
  });

  it("throws on invalid token", () => {
    expect(() => parseAllowList(["abc"])).toThrow(/Invalid issue number/);
  });
});

describe("parseArgs", () => {
  it("parses offline flags", () => {
    expect(
      parseArgs([
        "--body-file",
        "body.md",
        "--commits-file",
        "commits.txt",
        "--allow-known-false-positives",
        "1,2",
        "--allow-close",
        "9,10",
        "--mode",
        "intent",
        "--repo",
        "deftai/directive",
      ]),
    ).toMatchObject({
      bodyFile: "body.md",
      commitsFile: "commits.txt",
      repo: "deftai/directive",
      allowKnownFalsePositives: ["1,2"],
      allowClose: ["9,10"],
      mode: "intent",
    });
  });

  it("defaults mode to both", () => {
    expect(parseArgs(["--body-file", "b.md"]).mode).toBe("both");
  });

  it("rejects invalid mode", () => {
    expect(parseArgs(["--mode", "all"]).error).toMatch(/invalid --mode/);
  });

  it("errors on missing input source at run time", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run([])).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.mock.calls.join("")).toContain("must specify --pr OR");
    stderr.mockRestore();
  });

  it("parses --from-git-range (#3969)", () => {
    expect(parseArgs(["--from-git-range", "origin/master..HEAD"]).fromGitRange).toBe(
      "origin/master..HEAD",
    );
  });
});

describe("run CLI offline", () => {
  it("FP mode flags a negated Closes from --from-git-range (#3969)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["--mode", "fp", "--from-git-range", "origin/master..HEAD"], {
      runGit: () => ({
        returncode: 0,
        stdout: "Does not close #3899\n--END--\n",
        stderr: "",
      }),
    });
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(stderr.mock.calls.join("")).toContain("negation");
    stderr.mockRestore();
  });

  it("fails closed when git log for --from-git-range fails", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(["--mode", "fp", "--from-git-range", "origin/master..HEAD"], {
        runGit: () => ({ returncode: 128, stdout: "", stderr: "unknown revision" }),
      }),
    ).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.mock.calls.join("")).toContain("git fetch origin master");
    stderr.mockRestore();
  });

  it("FP mode is clean when --from-git-range has no commits", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(["--mode", "fp", "--from-git-range", "origin/master..HEAD"], {
        runGit: () => ({ returncode: 0, stdout: "", stderr: "" }),
      }),
    ).toBe(EXIT_OK);
    stderr.mockRestore();
  });

  // #5736: isolate Refs-only body-file from Path B local merge-base..HEAD via empty runGit.
  it("exits zero for clean body with only Refs (both modes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: lint introduction.\n\nRefs #1234\n", "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_OK);
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FP-only mode still accepts bare Closes as true-positive control (#737)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: lint introduction.\n\nCloses #1234\n", "utf8");
      expect(run(["--body-file", body, "--mode", "fp"], { runGit: emptyGit })).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default both mode fails bare Closes without allowlist (#3015)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: lint introduction.\n\nCloses #1234\n", "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_HITS_FOUND);
      expect(stderr.mock.calls.join("")).toMatch(/intent mode|#3015/);
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enterprize PR#30 body fails intent, passes FP-only (#3015 class D)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(
        body,
        [
          "## Summary",
          "",
          "Closes #29 Phase A intake only if you want intake closed on merge — otherwise leave #29 open for Phase B/C distill.",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(run(["--body-file", body, "--mode", "fp"], { runGit: emptyGit })).toBe(EXIT_OK);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body, "--mode", "intent"], { runGit: emptyGit })).toBe(
        EXIT_HITS_FOUND,
      );
      expect(run(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_HITS_FOUND);
      expect(stderr.mock.calls.join("")).toContain("29");
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allow-close suppresses intent hit (#3015)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: done.\n\nCloses #55\n", "utf8");
      expect(run(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_HITS_FOUND);
      expect(run(["--body-file", body, "--allow-close", "55"], { runGit: emptyGit })).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("body trailer text does not suppress intent hits (CLI allow-close only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: done.\n\nCloses #55\n\ndeft-close-intent: full\n", "utf8");
      expect(run(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_HITS_FOUND);
      expect(run(["--body-file", body, "--allow-close", "55"], { runGit: emptyGit })).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits one for negation hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: gate.\n\nDOES NOT CLOSE #734 (umbrella).\n", "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_HITS_FOUND);
      expect(stderr.mock.calls.join("")).toContain("FAIL:");
      stderr.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits two for invalid allow token", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "clean body", "utf8");
      expect(
        run(["--body-file", body, "--allow-known-false-positives", "abc"], { runGit: emptyGit }),
      ).toBe(EXIT_CONFIG_ERROR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits two for missing body file", () => {
    expect(run(["--body-file", join(tmpdir(), "does-not-exist.md")], { runGit: emptyGit })).toBe(
      EXIT_CONFIG_ERROR,
    );
  });

  it("FP allow list suppresses class-A hits without --allow-close (both mode)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "Body. Intentionally not `Closes #999` (test fixture).\n", "utf8");
      expect(run(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_HITS_FOUND);
      // Class A stays exclusive to FP mode — no intent leak into --allow-close.
      expect(
        run(["--body-file", body, "--allow-known-false-positives", "999"], { runGit: emptyGit }),
      ).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cmdPrCheckClosingKeywords delegates to run", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "Refs #642 only.", "utf8");
      expect(cmdPrCheckClosingKeywords(["--body-file", body], { runGit: emptyGit })).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run CLI --pr mode", () => {
  it("calls gh for body and commits", () => {
    const calls: string[][] = [];
    const runGh: RunGhFn = (cmd) => {
      calls.push([...cmd]);
      const joined = cmd.join(" ");
      if (joined.includes("/files")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd.includes("body")) {
        return { returncode: 0, stdout: JSON.stringify({ body: "Refs #642 only." }), stderr: "" };
      }
      if (cmd.includes("commits")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            commits: [{ messageHeadline: "feat: implement", messageBody: "Refs #1\n" }],
          }),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    expect(run(["--pr", "735", "--repo", "deftai/directive"], { runGh })).toBe(EXIT_OK);
    expect(calls.some((c) => c.includes("body"))).toBe(true);
    expect(calls.some((c) => c.includes("commits"))).toBe(true);
  });

  it("finds negation hit from pr body", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/files")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd.includes("body")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            body: "Body header. Intentionally NOT using `Closes #642` because umbrella.",
          }),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--pr", "735", "--repo", "deftai/directive"], { runGh })).toBe(EXIT_HITS_FOUND);
    expect(stderr.mock.calls.join("")).toContain("642");
    stderr.mockRestore();
  });

  it("exits two when gh fails", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "permission denied" });
    expect(run(["--pr", "735", "--repo", "deftai/directive"], { runGh })).toBe(EXIT_CONFIG_ERROR);
  });

  it("exits two when gh missing", () => {
    const runGh: RunGhFn = () => ({
      returncode: -1,
      stdout: "",
      stderr: "gh CLI not found. Install GitHub CLI.",
    });
    expect(run(["--pr", "735", "--repo", "deftai/directive"], { runGh })).toBe(EXIT_CONFIG_ERROR);
  });
});

describe("one-PR-unit closer-set (#4494)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ck-4494-"));
  const body = join(tmp, "body.md");

  it("solo one Closes #N passes", () => {
    writeFileSync(body, "Closes #4494\n", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(["--mode", "intent", "--body-file", body, "--allow-close", "4494"], {
        runGit: emptyGit,
      }),
    ).toBe(EXIT_OK);
    stderr.mockRestore();
  });

  it("five-origin comma-list without one-PR-unit fails closed even with --allow-close", () => {
    writeFileSync(body, "Closes #4204, #4218, #4161, #3918, #3849\n", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(
      [
        "--mode",
        "intent",
        "--body-file",
        body,
        "--allow-close",
        "4204,4218,4161,3918,3849",
        "--repo",
        "deftai/directive",
      ],
      { runGit: emptyGit },
    );
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(stderr.mock.calls.join("")).toMatch(/missing one-PR-unit consent/);
    stderr.mockRestore();
  });

  it("--allow-close 4204,4218 is not one-PR-unit consent", () => {
    writeFileSync(body, "Closes #4204, #4218\n", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(
      [
        "--mode",
        "intent",
        "--body-file",
        body,
        "--allow-close",
        "4204,4218",
        "--repo",
        "deftai/directive",
      ],
      { runGit: emptyGit },
    );
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(stderr.mock.calls.join("")).toMatch(/missing one-PR-unit consent/);
    stderr.mockRestore();
  });

  it("live --pr single Closes without --allow-close passes (CI)", () => {
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/files")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd.includes("body")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ body: "Closes #4494\n" }),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--mode", "both", "--pr", "4497", "--repo", "deftai/directive"], { runGh })).toBe(
      EXIT_OK,
    );
    stderr.mockRestore();
  });

  it("live --pr five-origin comma-list without grant fails closed", () => {
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/files")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd.includes("body")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({
            body: "Closes #4204, #4218, #4161, #3918, #3849\n",
          }),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["--mode", "both", "--pr", "1", "--repo", "deftai/directive"], { runGh });
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(stderr.mock.calls.join("")).toMatch(/deployment\/configuration failure/);
    expect(stderr.mock.calls.join("")).not.toMatch(/mint an operator-origin/);
    stderr.mockRestore();
  });

  it("five origins with operator-origin one-PR-unit grant pass", () => {
    writeFileSync(body, "Closes #4204, #4218, #4161, #3918, #3849\n", "utf8");
    mintOnePrUnitGrant({
      projectRoot: tmp,
      id: "unit-five",
      actor: "dbcall2",
      approvalRef: "operator-approved",
      rationale: "five origins",
      origins: [4204, 4218, 4161, 3918, 3849].map((issueId) => ({
        repo: "deftai/directive",
        issueId,
      })),
      repo: "deftai/directive",
      singleUse: true,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run([
      "--mode",
      "intent",
      "--body-file",
      body,
      "--allow-close",
      "4204,4218,4161,3918,3849",
      "--repo",
      "deftai/directive",
      "--one-pr-unit",
      "unit-five",
      "--project-root",
      tmp,
    ]);
    expect(code).toBe(EXIT_OK);
    stderr.mockRestore();
  });

  it("live --pr without repo does not report unknown/unknown", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["--mode", "both", "--pr", "12"], {
      runGh: () => ({ returncode: 0, stdout: "{}", stderr: "" }),
      env: {},
    });
    expect(code).toBe(EXIT_CONFIG_ERROR);
    const out = stderr.mock.calls.join("");
    expect(out).toMatch(/repository identity/);
    expect(out).not.toMatch(/unknown\/unknown/);
    stderr.mockRestore();
  });

  it("live --pr exact-set mint binds PR node id and allows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-4635-"));
    const store = new DirectiveGitHubAppStore(dir);
    mintOnePrUnitGrant({
      store,
      id: "unit-live",
      actor: "dbcall2",
      approvalRef: "op",
      rationale: "pair",
      origins: [
        { repo: "deftai/directive", issueId: 3728 },
        { repo: "deftai/directive", issueId: 3804 },
      ],
      repo: "deftai/directive",
    });
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/files")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd.includes("body")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ body: "Closes #3728\nCloses #3804\n" }),
          stderr: "",
        };
      }
      if (cmd.includes("api")) {
        return { returncode: 0, stdout: JSON.stringify({ node_id: "PR_LEGIT" }), stderr: "" };
      }
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["--mode", "both", "--pr", "9", "--repo", "deftai/directive"], {
      runGh,
      env: { DEFT_ONE_PR_UNIT_APP: dir },
    });
    expect(code, stderr.mock.calls.join("")).toBe(EXIT_OK);
    expect(new DirectiveGitHubAppStore(dir).getByPrNodeId("PR_LEGIT")?.id).toBe("unit-live");
    stderr.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("--allow-close running-for-N refuse (#4628)", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) {
      rmSync(t, { recursive: true, force: true });
    }
  });
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-allow-close-running-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    return root;
  }
  function writeBrief(root: string, name: string, plan: Record<string, unknown>): void {
    writeFileSync(
      join(root, "xbrief", "active", name),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }),
      "utf8",
    );
  }
  function issueRef(n: number): Record<string, unknown> {
    return {
      uri: `https://github.com/deftai/directive/issues/${String(n)}`,
      type: "x-xbrief/github-issue",
    };
  }

  it("fails closed when --allow-close N has a running brief for N", () => {
    const root = makeRoot();
    writeBrief(root, "2026-09-16-55-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(55)],
    });
    const body = join(root, "body.md");
    writeFileSync(body, "Closes #55\n", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run([
      "--body-file",
      body,
      "--allow-close",
      "55",
      "--repo",
      "deftai/directive",
      "--project-root",
      root,
    ]);
    expect(code).toBe(EXIT_HITS_FOUND);
    const msg = stderr.mock.calls.join("");
    expect(msg).toContain("Refs");
    expect(msg).toContain("Tracking");
    expect(msg).toContain("xbrief/active/2026-09-16-55-story.xbrief.json");
    stderr.mockRestore();
  });

  it("passes --allow-close N when no running brief tracks N", () => {
    const root = makeRoot();
    writeBrief(root, "2026-09-16-99-story.xbrief.json", {
      title: "other",
      status: "running",
      references: [issueRef(99)],
    });
    const body = join(root, "body.md");
    writeFileSync(body, "Closes #55\n", "utf8");
    expect(
      run([
        "--body-file",
        body,
        "--allow-close",
        "55",
        "--repo",
        "deftai/directive",
        "--project-root",
        root,
      ]),
    ).toBe(EXIT_OK);
  });

  it("passes --allow-close N when the matching brief is not running", () => {
    const root = makeRoot();
    writeBrief(root, "2026-09-16-55-story.xbrief.json", {
      title: "story",
      status: "proposed",
      references: [issueRef(55)],
    });
    const body = join(root, "body.md");
    writeFileSync(body, "Closes #55\n", "utf8");
    expect(
      run([
        "--body-file",
        body,
        "--allow-close",
        "55",
        "--repo",
        "deftai/directive",
        "--project-root",
        root,
      ]),
    ).toBe(EXIT_OK);
  });

  it("fails closed when --allow-close is set and OWNER/REPO cannot be resolved", () => {
    const root = makeRoot();
    const body = join(root, "body.md");
    writeFileSync(body, "Closes #55\n", "utf8");
    const prev = process.env[ENV_TRIAGE_REPO];
    delete process.env[ENV_TRIAGE_REPO];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = run(["--body-file", body, "--allow-close", "55", "--project-root", root]);
      expect(code).toBe(EXIT_CONFIG_ERROR);
      expect(stderr.mock.calls.join("")).toContain("OWNER/REPO");
    } finally {
      stderr.mockRestore();
      if (prev === undefined) {
        delete process.env[ENV_TRIAGE_REPO];
      } else {
        process.env[ENV_TRIAGE_REPO] = prev;
      }
    }
  });

  it("live --pr without --allow-close still skips intent (#3015)", () => {
    const runGh: RunGhFn = (cmd) => {
      if (cmd.join(" ").includes("/files")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd.includes("body")) {
        return { returncode: 0, stdout: JSON.stringify({ body: "Closes #4494\n" }), stderr: "" };
      }
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--mode", "both", "--pr", "4497", "--repo", "deftai/directive"], { runGh })).toBe(
      EXIT_OK,
    );
    stderr.mockRestore();
  });
});

describe("full-story mark admission shapes (#4919)", () => {
  it("admits leftover-shaped diffs and refuses skip-active", () => {
    expect(
      isLeftoverShapedDiff([
        { status: "removed", path: "xbrief/active/story.xbrief.json" },
        { status: "added", path: "xbrief/completed/story.xbrief.json" },
      ]),
    ).toBe(true);
    expect(
      isSkipActiveDeliveryShape([
        { status: "removed", path: "xbrief/proposed/story.xbrief.json" },
        { status: "added", path: "xbrief/completed/story.xbrief.json" },
      ]),
    ).toBe(true);
    const leftover = evaluateFullStoryMarkAdmission({
      bodyText: "Tracking #1",
      prNumber: 9,
      projectRoot: ".",
      repo: "deftai/directive",
      files: [
        { status: "removed", path: "xbrief/active/story.xbrief.json" },
        { status: "added", path: "xbrief/completed/story.xbrief.json" },
      ],
    });
    expect(leftover.ok).toBe(true);
    const skip = evaluateFullStoryMarkAdmission({
      bodyText: "Tracking #1",
      prNumber: 9,
      projectRoot: ".",
      repo: "deftai/directive",
      files: [
        { status: "removed", path: "xbrief/proposed/story.xbrief.json" },
        { status: "added", path: "xbrief/completed/story.xbrief.json" },
      ],
    });
    expect(skip.ok).toBe(false);
  });

  it("refuses leftover exception when unrelated nonterminal briefs also change", () => {
    expect(
      isLeftoverShapedDiff([
        { status: "removed", path: "xbrief/active/story.xbrief.json" },
        { status: "added", path: "xbrief/completed/story.xbrief.json" },
        { status: "modified", path: "xbrief/proposed/other.xbrief.json" },
      ]),
    ).toBe(false);
  });

  it("refuses mixed proposed→completed + source diffs (no admission bypass) (#4919)", () => {
    const files = [
      { status: "removed", path: "xbrief/proposed/story.xbrief.json" },
      { status: "added", path: "xbrief/completed/story.xbrief.json" },
      { status: "modified", path: "packages/core/src/example.ts" },
    ];
    expect(isSkipActiveDeliveryShape(files)).toBe(true);
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "Tracking #1",
      prNumber: 9,
      projectRoot: ".",
      repo: "deftai/directive",
      files,
    });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/skip-active/);
  });

  it("requires each changed nonterminal brief path to bind productPullRequest", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-admission-bind-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "bound.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "bound",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/55",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { productPullRequest: 9 },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "active", "unbound.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "unbound",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/56",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "deft-story: 55\ndeft-story: 56\n",
      prNumber: 9,
      projectRoot: root,
      repo: "deftai/directive",
      files: [
        { status: "modified", path: "xbrief/active/bound.xbrief.json" },
        { status: "modified", path: "xbrief/active/unbound.xbrief.json" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("unbound.xbrief.json");
    rmSync(root, { recursive: true, force: true });
  });

  it("offline brief-land hard-fails missing deft-story with prNumber null (#5736)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-offline-brief-land-missing-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5736.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "offline",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5736",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const files = [
      { status: "modified", path: "xbrief/active/story-5736.xbrief.json" },
      { status: "modified", path: "CHANGELOG.md" },
    ];
    expect(isBriefLandShapedDiff(files)).toBe(true);
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "Tracking #5736\n",
      prNumber: null,
      projectRoot: root,
      repo: "deftai/directive",
      files,
    });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/missing deft-story|FAIL/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("offline brief-land admits matching deft-story with prNumber null (#5736)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-offline-brief-land-ok-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5736.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "offline",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5736",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "Tracking #5736\n\ndeft-story: 5736\n",
      prNumber: null,
      projectRoot: root,
      repo: "deftai/directive",
      files: [
        { status: "modified", path: "xbrief/active/story-5736.xbrief.json" },
        { status: "modified", path: "CHANGELOG.md" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.messages.join("\n")).toMatch(/offline identity #5736/);
    rmSync(root, { recursive: true, force: true });
  });

  it("admits Path B activation: unset productPullRequest + brief-land + deft-story (#5387)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-activation-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-5380.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5373",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { activationPullRequest: 5380 },
        },
      }),
      "utf8",
    );
    const files = [
      {
        status: "renamed",
        path: "xbrief/active/story-5380.xbrief.json",
        previousFilename: "xbrief/proposed/story-5380.xbrief.json",
      },
      { status: "modified", path: "CHANGELOG.md" },
    ];
    expect(isBriefLandShapedDiff(files)).toBe(true);
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "Tracking #5373\n\ndeft-story: 5373\n",
      prNumber: 5380,
      projectRoot: root,
      repo: "deftai/directive",
      files,
    });
    expect(result.ok).toBe(true);
    expect(result.messages.join("\n")).toMatch(/Path B brief-land activation/);
    rmSync(root, { recursive: true, force: true });
  });

  it("admits keep-active Path B activation with root CHANGELOG only (#5387 / #5362 shape)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-keep-active-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "keep.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "keep-active",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5353",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "Tracking #5353\n\ndeft-story: 5353\n",
      prNumber: 5362,
      projectRoot: root,
      repo: "deftai/directive",
      files: [
        { status: "modified", path: "xbrief/active/keep.xbrief.json" },
        { status: "modified", path: "CHANGELOG.md" },
      ],
    });
    expect(result.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses unset Path B activation when a nonterminal brief is also deleted (#5388 Greptile P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-delete-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "keep.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "keep",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5373",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const files = [
      { status: "added", path: "xbrief/active/keep.xbrief.json" },
      { status: "removed", path: "xbrief/active/other.xbrief.json" },
    ];
    expect(isBriefLandShapedDiff(files)).toBe(true);
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "deft-story: 5373\n",
      prNumber: 5388,
      projectRoot: root,
      repo: "deftai/directive",
      files,
    });
    // Activation refuses deletion; unset brief then fails product stamp fallthrough.
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/productPullRequest/);
    rmSync(root, { recursive: true, force: true });
  });

  it("admits stamped product PR that deletes a sibling nonterminal brief (#5388 Greptile P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-product-delete-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "keep.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "keep",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5373",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { productPullRequest: 5388 },
        },
      }),
      "utf8",
    );
    const files = [
      { status: "modified", path: "xbrief/active/keep.xbrief.json" },
      { status: "removed", path: "xbrief/active/other.xbrief.json" },
    ];
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "deft-story: 5373\n",
      prNumber: 5388,
      projectRoot: root,
      repo: "deftai/directive",
      files,
    });
    expect(result.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses Path B activation when an extra deft-story mark has no changed brief (#5388 Greptile P1)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-extra-mark-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "activation",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/5373",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "deft-story: 5373\ndeft-story: 9999\n",
      prNumber: 5388,
      projectRoot: root,
      repo: "deftai/directive",
      files: [{ status: "modified", path: "xbrief/active/story.xbrief.json" }],
    });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/9999/);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses unset + packages/ mixed product path (#5387)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-mixed-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "mixed.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "mixed",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/99",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const files = [
      { status: "modified", path: "xbrief/active/mixed.xbrief.json" },
      { status: "modified", path: "packages/core/src/example.ts" },
    ];
    expect(isBriefLandShapedDiff(files)).toBe(false);
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "deft-story: 99\n",
      prNumber: 100,
      projectRoot: root,
      repo: "deftai/directive",
      files,
    });
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toMatch(/productPullRequest/);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses malformed productPullRequest as not-unset on brief-land (#5387 S1)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-malformed-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "bad.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "bad",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/88",
              type: "x-xbrief/github-issue",
            },
          ],
          metadata: { productPullRequest: "x" },
        },
      }),
      "utf8",
    );
    const result = evaluateFullStoryMarkAdmission({
      bodyText: "deft-story: 88\n",
      prNumber: 880,
      projectRoot: root,
      repo: "deftai/directive",
      files: [{ status: "modified", path: "xbrief/active/bad.xbrief.json" }],
    });
    expect(result.ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("denies completed/ and nested CHANGELOG from brief-land allowlist (#5387)", () => {
    expect(
      isBriefLandShapedDiff([
        { status: "added", path: "xbrief/completed/story.xbrief.json" },
        { status: "removed", path: "xbrief/active/story.xbrief.json" },
      ]),
    ).toBe(false);
    expect(isBriefLandShapedDiff([{ status: "modified", path: "docs/CHANGELOG.md" }])).toBe(false);
    expect(isBriefLandShapedDiff([{ status: "modified", path: "CHANGELOG.md" }])).toBe(false);
  });

  it("finalize honesty: activation PR is not delivery bind (#5387 limb 5)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-path-b-finalize-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const plan = {
      title: "activation",
      status: "running",
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/5373",
          type: "x-xbrief/github-issue",
        },
      ],
      metadata: { activationPullRequest: 5380 },
    };
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({ plan }),
      "utf8",
    );
    expect(isProductPullRequestUnset(plan)).toBe(true);
    expect(productPullRequestFromPlan(plan)).toBeNull();
    // deftStoryMarkBindsDelivery predicate: stamp === activation PR → false when unset
    expect(productPullRequestFromPlan(plan) === 5380).toBe(false);
    const mark = briefHasMatchingProductPr(root, 5373, 5380, "deftai/directive");
    expect(mark.ok).toBe(false);
    const admit = deriveUnmarkedFinalizeAdmit(plan, "deftai/directive", () => ({
      returncode: 0,
      stdout: "[]",
      stderr: "",
    }));
    expect(admit).toBeNull();
    const bound = bindUnmarkedFinalizePair({
      admit,
      issueFromPlan: 5373,
      plan,
    });
    expect(bound.kind).not.toBe("admit");
    expect(stampProductPullRequestOntoPlan(plan, 5381)).toBe(true);
    expect(productPullRequestFromPlan(plan)).toBe(5381);
    expect(stampProductPullRequestOntoPlan(plan, 5382)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("full-story close intent mark (#4864)", () => {
  it("parses deft-story: N and ignores deft-close-intent: full", () => {
    expect(parseDeftStoryMark("Tracking #55\n\ndeft-story: 55\n")).toBe(55);
    expect(parseDeftStoryMark("Tracking #55\n\ndeft-close-intent: full\n")).toBeNull();
    expect(parseAllDeftStoryMarks("deft-story: 10\ndeft-story: 20\n")).toEqual([10, 20]);
    expect(fullStoryCloseIntentFromBody("Refs #9\ndeft-story: 9\n")).toEqual({
      issue: 9,
      source: "deft-story",
    });
  });

  it("Tracking + deft-story still passes while --allow-close is refused for a running brief", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-full-story-mark-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story-55.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "story",
          status: "running",
          references: [
            {
              uri: "https://github.com/deftai/directive/issues/55",
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    const trackingBody = join(root, "tracking.md");
    writeFileSync(trackingBody, "Tracking #55\n\ndeft-story: 55\n", "utf8");
    expect(
      run(["--body-file", trackingBody, "--repo", "deftai/directive", "--project-root", root]),
    ).toBe(EXIT_OK);

    const closesBody = join(root, "closes.md");
    writeFileSync(closesBody, "Closes #55\n\ndeft-story: 55\n", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run([
        "--body-file",
        closesBody,
        "--allow-close",
        "55",
        "--repo",
        "deftai/directive",
        "--project-root",
        root,
      ]),
    ).toBe(EXIT_HITS_FOUND);
    expect(stderr.mock.calls.join("")).toContain("Tracking");
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("isBriefLandShapedDiff changelog entry paths (#6314)", () => {
  it("admits a changelog.d fragment beside a nonterminal brief, like CHANGELOG.md", () => {
    expect(
      isBriefLandShapedDiff([
        { status: "modified", path: "xbrief/active/story.xbrief.json" },
        { status: "added", path: "changelog.d/6314-x.md" },
      ]),
    ).toBe(true);
  });

  it("refuses a nested fragment directory path", () => {
    expect(
      isBriefLandShapedDiff([
        { status: "modified", path: "xbrief/active/story.xbrief.json" },
        { status: "added", path: "changelog.d/sub/x.md" },
      ]),
    ).toBe(false);
  });
});

describe("story lines: part line, pre-merge check, --write-story-line (#6316)", () => {
  const REPO = "deftai/directive";
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) {
      rmSync(t, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-story-line-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    return root;
  }

  function storyPlan(
    issue: number,
    extra: { status?: string; metadata?: Record<string, unknown>; id?: string } = {},
  ): Record<string, unknown> {
    return {
      ...(extra.id !== undefined ? { id: extra.id } : {}),
      title: `story ${String(issue)}`,
      status: extra.status ?? "running",
      references: [
        {
          uri: `https://github.com/${REPO}/issues/${String(issue)}`,
          type: "x-xbrief/github-issue",
        },
      ],
      ...(extra.metadata !== undefined ? { metadata: extra.metadata } : {}),
    };
  }

  function writeBrief(root: string, name: string, plan: Record<string, unknown>): string {
    const rel = `xbrief/active/${name}`;
    writeFileSync(
      join(root, rel),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }),
      "utf8",
    );
    return rel;
  }

  function liveGh(body: string, files: { filename: string; status: string }[]): RunGhFn {
    return (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/files")) {
        return { returncode: 0, stdout: JSON.stringify(files), stderr: "" };
      }
      if (cmd.includes("body")) {
        return { returncode: 0, stdout: JSON.stringify({ body }), stderr: "" };
      }
      if (cmd.includes("commits")) {
        return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
  }

  function runLive(root: string, pr: number, runGh: RunGhFn): { code: number; err: string } {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["--pr", String(pr), "--mode", "fp", "--repo", REPO, "--project-root", root], {
      runGh,
    });
    const err = stderr.mock.calls.join("");
    stderr.mockRestore();
    return { code, err };
  }

  const PRODUCT = [{ filename: "packages/core/src/x.ts", status: "modified" }];

  it("parses the part line like the mark and never as a close signal", () => {
    expect(parseAllDeftStoryPartLines("deft-story-part: 12\n  deft-story-part: 3 \n")).toEqual([
      3, 12,
    ]);
    expect(parseAllDeftStoryPartLines("x deft-story-part: 12\ndeft-story-part: 1a\n")).toEqual([]);
    expect(parseAllDeftStoryMarks("deft-story-part: 12\n")).toEqual([]);
    expect(parseDeftStoryMark("deft-story-part: 12\n")).toBeNull();
    expect(fullStoryCloseIntentFromBody("deft-story-part: 12\n")).toBeNull();
    expect(findUnparseableDeftStoryPartLines("deft-story-part: github.issue.1\n")).toEqual([
      "github.issue.1",
    ]);
    expect(findUnparseableDeftStoryPartLines("deft-story-part:\n")).toEqual(["(empty)"]);
    // Line-based scan: case-insensitive, CRLF-safe, linear on long whitespace runs.
    expect(parseAllDeftStoryPartLines("DEFT-STORY-PART: 4\r\n")).toEqual([4]);
    const spaces = " ".repeat(50_000);
    const started = Date.now();
    expect(parseAllDeftStoryPartLines(`deft-story-part:${spaces}x`)).toEqual([]);
    expect(findUnparseableDeftStoryPartLines(`deft-story-part:${spaces}x`)).toEqual(["x"]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(findStoryLineConflicts("deft-story: 5\ndeft-story-part: 5\ndeft-story: 6\n")).toEqual([
      5,
    ]);
    expect(storyLineAdvice(7)).toContain("deft-story-part: 7");
    expect(storyLineAdvice(null)).toContain("--write-story-line");
  });

  it("reads Refs / Tracking / Related names and skips code and other repos", () => {
    const body = [
      "Refs #10, #11 and #12",
      "Tracking: deftai/directive#13",
      "Related: https://github.com/deftai/directive/issues/14",
      "Refs other/repo#15",
      "See `Refs #16` in prose",
      "```",
      "Refs #17",
      "```",
      "Prefs #18",
    ].join("\n");
    expect(parseStoryRefIssues(body, REPO)).toEqual([10, 11, 12, 13, 14]);
  });

  it("classifies product-shaped diffs", () => {
    expect(isProductShapedDiff([])).toBe(false);
    expect(isProductShapedDiff([{ status: "modified", path: "xbrief/active/a.json" }])).toBe(false);
    expect(isProductShapedDiff([{ status: "modified", path: "packages/a.ts" }])).toBe(true);
  });

  it("fails a product PR whose body has Refs #N only, prints both lines and the write command", () => {
    const root = makeRoot();
    writeBrief(root, "s-501.xbrief.json", storyPlan(501));
    const { code, err } = runLive(root, 77, liveGh("Refs #501\n", PRODUCT));
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(err).toContain("deft-story: 501");
    expect(err).toContain("deft-story-part: 501");
    expect(err).toContain("completes the story");
    expect(err).toContain("--write-story-line");
  });

  it("fails the same way when the head brief names the PR as productPullRequest", () => {
    const root = makeRoot();
    writeBrief(root, "s-502.xbrief.json", storyPlan(502, { metadata: { productPullRequest: 78 } }));
    const { code, err } = runLive(root, 78, liveGh("No issue reference.\n", PRODUCT));
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(err).toContain("names this PR as metadata.productPullRequest");
    expect(err).toContain("deft-story-part: 502");
    expect(err).toContain("--write-story-line");
  });

  it("names the part line for an authority-record PR (intent-constraint only) (#6335)", () => {
    const root = makeRoot();
    writeBrief(root, "s-510.xbrief.json", storyPlan(510));
    const result = evaluateStoryLineRequirement({
      bodyText: "Refs #510\n",
      prNumber: 81,
      projectRoot: root,
      repo: REPO,
      files: [{ status: "added", path: ".deft/intent-constraint/github.issue.510.json" }],
    });
    expect(result.ok).toBe(false);
    const text = result.messages.join("\n");
    expect(text).toContain("authority-record PR");
    expect(text).toContain("deft-story-part: 510");
    expect(storyLineAdvice(510)).toContain("authority-record PR");
    expect(storyLineAdvice(510)).toContain("deft-story-part: 510");
  });

  it("passes with a sole mark or part line and ignores non-running or lifecycle-only cases", () => {
    const root = makeRoot();
    writeBrief(root, "s-503.xbrief.json", storyPlan(503));
    writeBrief(root, "s-504.xbrief.json", storyPlan(504, { status: "pending" }));
    expect(runLive(root, 79, liveGh("Refs #503\n\ndeft-story: 503\n", PRODUCT)).code).toBe(EXIT_OK);
    expect(runLive(root, 79, liveGh("Refs #503\n\ndeft-story-part: 503\n", PRODUCT)).code).toBe(
      EXIT_OK,
    );
    expect(runLive(root, 79, liveGh("Refs #504\nRefs #999\n", PRODUCT)).code).toBe(EXIT_OK);
    const result = evaluateStoryLineRequirement({
      bodyText: "Refs #503\n",
      prNumber: 79,
      projectRoot: root,
      repo: REPO,
      files: [{ status: "modified", path: "xbrief/active/s-503.xbrief.json" }],
    });
    expect(result.ok).toBe(true);
  });

  it("fails a body that carries both lines for one issue (live and offline)", () => {
    const root = makeRoot();
    writeBrief(root, "s-505.xbrief.json", storyPlan(505));
    const both = "Refs #505\n\ndeft-story: 505\ndeft-story-part: 505\n";
    const live = runLive(root, 80, liveGh(both, PRODUCT));
    expect(live.code).toBe(EXIT_HITS_FOUND);
    expect(live.err).toContain("both `deft-story: N` and `deft-story-part: N`");
    const bodyFile = join(root, "both.md");
    writeFileSync(bodyFile, both, "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--body-file", bodyFile, "--repo", REPO, "--project-root", root], {})).toBe(
      EXIT_HITS_FOUND,
    );
    stderr.mockRestore();
  });

  describe("part-line admission in evaluateFullStoryMarkAdmission", () => {
    function admit(root: string, rel: string, body: string, reader?: ReadMergeBaseFileFn) {
      return evaluateFullStoryMarkAdmission({
        bodyText: body,
        prNumber: 90,
        projectRoot: root,
        repo: REPO,
        files: [
          { status: "modified", path: rel },
          { status: "modified", path: "packages/core/src/x.ts" },
        ],
        ...(reader !== undefined ? { readMergeBaseFile: reader } : {}),
      });
    }

    it("passes a part-line PR that stamps evidence and leaves productPullRequest unchanged", () => {
      const root = makeRoot();
      const basePlan = storyPlan(601, { metadata: { productPullRequest: 55 } });
      const headPlan = { ...basePlan, items: [{ title: "a", status: "completed" }] };
      const rel = writeBrief(root, "s-601.xbrief.json", headPlan);
      const result = admit(root, rel, "deft-story-part: 601\n", () => ({
        kind: "ok",
        text: JSON.stringify({ plan: basePlan }),
      }));
      expect(result).toEqual({ ok: true, messages: [] });
    });

    it("passes when the stamp is unset on both sides, including a brief new at the merge base", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-602.xbrief.json", storyPlan(602));
      expect(admit(root, rel, "deft-story-part: 602\n", () => ({ kind: "absent" })).ok).toBe(true);
    });

    it("fails a part-line PR that sets the stamp to itself", () => {
      const root = makeRoot();
      const rel = writeBrief(
        root,
        "s-603.xbrief.json",
        storyPlan(603, { metadata: { productPullRequest: 90 } }),
      );
      const result = admit(root, rel, "deft-story-part: 603\n", () => ({ kind: "absent" }));
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("sets metadata.productPullRequest to itself");
    });

    it("fails when the stamp otherwise differs from the merge base", () => {
      const root = makeRoot();
      const rel = writeBrief(
        root,
        "s-604.xbrief.json",
        storyPlan(604, { metadata: { productPullRequest: 41 } }),
      );
      const result = admit(root, rel, "deft-story-part: 604\n", () => ({
        kind: "ok",
        text: JSON.stringify({ plan: storyPlan(604) }),
      }));
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain("merge base: unset, head: 41");
    });

    it("fails closed without a readable merge base", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-605.xbrief.json", storyPlan(605));
      expect(admit(root, rel, "deft-story-part: 605\n").messages.join("\n")).toContain(
        "cannot read merge-base",
      );
      expect(
        admit(root, rel, "deft-story-part: 605\n", () => ({ kind: "error", detail: "boom" }))
          .messages[0],
      ).toContain("boom");
      expect(
        admit(root, rel, "deft-story-part: 605\n", () => ({ kind: "ok", text: "{not json" })).ok,
      ).toBe(false);
    });

    it("fails a brief covered by neither line and keeps mark rules for a marked brief", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-606.xbrief.json", storyPlan(606));
      const uncovered = admit(root, rel, "deft-story-part: 1\n", () => ({ kind: "absent" }));
      expect(uncovered.messages.join("\n")).toContain(
        "not covered by deft-story or deft-story-part",
      );
      const marked = writeBrief(
        root,
        "s-607.xbrief.json",
        storyPlan(607, { metadata: { productPullRequest: 90 } }),
      );
      const result = evaluateFullStoryMarkAdmission({
        bodyText: "deft-story: 607\ndeft-story-part: 606\n",
        prNumber: 90,
        projectRoot: root,
        repo: REPO,
        files: [
          { status: "modified", path: marked },
          { status: "modified", path: rel },
          { status: "modified", path: "packages/x.ts" },
        ],
        readMergeBaseFile: () => ({ kind: "absent" }),
      });
      expect(result).toEqual({ ok: true, messages: [] });
    });

    it("refuses both lines for one issue and points a lineless PR at the write command", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-608.xbrief.json", storyPlan(608));
      expect(admit(root, rel, "deft-story: 608\ndeft-story-part: 608\n").ok).toBe(false);
      expect(admit(root, rel, "Refs #608\n").messages[0]).toContain("--write-story-line");
    });

    it("reads the merge base through the live run seam", () => {
      const root = makeRoot();
      const rel = writeBrief(
        root,
        "s-609.xbrief.json",
        storyPlan(609, { metadata: { productPullRequest: 91 } }),
      );
      const calls: string[] = [];
      const runGh: RunGhFn = (cmd) => {
        const joined = cmd.join(" ");
        calls.push(joined);
        if (joined.includes("/files")) {
          return {
            returncode: 0,
            stdout: JSON.stringify([
              { filename: rel, status: "modified" },
              { filename: "packages/x.ts", status: "modified" },
            ]),
            stderr: "",
          };
        }
        if (joined.includes("/compare/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({ merge_base_commit: { sha: "c".repeat(40) } }),
            stderr: "",
          };
        }
        if (joined.includes("/contents/")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from(
                JSON.stringify({ plan: storyPlan(609, { metadata: { productPullRequest: 91 } }) }),
              ).toString("base64"),
            }),
            stderr: "",
          };
        }
        if (joined.includes("/pulls/92")) {
          return {
            returncode: 0,
            stdout: JSON.stringify({
              base: { sha: "a".repeat(40) },
              head: { sha: "b".repeat(40) },
            }),
            stderr: "",
          };
        }
        return liveGh("Refs #609\n\ndeft-story-part: 609\n", [])(cmd);
      };
      expect(runLive(root, 92, runGh).code).toBe(EXIT_OK);
      expect(calls.some((c) => c.includes("/contents/xbrief/active/s-609.xbrief.json"))).toBe(true);

      const failing: RunGhFn = (cmd) => {
        const joined = cmd.join(" ");
        return joined.endsWith("/pulls/92")
          ? { returncode: 1, stdout: "", stderr: "HTTP 502" }
          : runGh(cmd);
      };
      const bad = runLive(root, 92, failing);
      expect(bad.code).toBe(EXIT_HITS_FOUND);
      expect(bad.err).toContain("cannot resolve PR #92 merge base");
    });
  });

  describe("--write-story-line", () => {
    function gitFor(changed: string[], branch = "feat/x"): RunGhFn {
      return (cmd) => {
        if (cmd[0] === "merge-base") {
          return { returncode: 0, stdout: "abc123\n", stderr: "" };
        }
        if (cmd[0] === "diff") {
          return { returncode: 0, stdout: changed.map((p) => `M\0${p}\0`).join(""), stderr: "" };
        }
        if (cmd.includes("rev-parse")) {
          return { returncode: 0, stdout: `${branch}\n`, stderr: "" };
        }
        if (cmd.includes("get-url")) {
          return {
            returncode: 0,
            stdout: "https://github.com/deftai/directive.git\n",
            stderr: "",
          };
        }
        return { returncode: 1, stdout: "", stderr: "unexpected" };
      };
    }

    function runWrite(root: string, bodyFile: string, runGit: RunGhFn, extra: string[] = []) {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const code = run(
        ["--body-file", bodyFile, "--write-story-line", "--project-root", root, ...extra],
        { runGit },
      );
      const err = stderr.mock.calls.join("");
      stderr.mockRestore();
      return { code, err };
    }

    it("appends deft-story: N when the branch changes the running brief and exits 0", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-701.xbrief.json", storyPlan(701));
      const bodyFile = join(root, "body.md");
      writeFileSync(bodyFile, "## Summary\n\nRefs #701", "utf8");
      const { code, err } = runWrite(root, bodyFile, gitFor([rel]));
      expect(code).toBe(EXIT_OK);
      expect(err).toContain("wrote deft-story: 701");
      expect(readFileSync(bodyFile, "utf8")).toBe("## Summary\n\nRefs #701\n\ndeft-story: 701\n");
    });

    it("appends deft-story-part: N with --part", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-702.xbrief.json", storyPlan(702));
      const bodyFile = join(root, "body.md");
      writeFileSync(bodyFile, "Body\r\n", "utf8");
      expect(runWrite(root, bodyFile, gitFor([rel]), ["--part", "--repo", REPO]).code).toBe(
        EXIT_OK,
      );
      expect(readFileSync(bodyFile, "utf8")).toBe("Body\r\n\r\ndeft-story-part: 702\r\n");
    });

    it("finds the story from the branch name plan id or a body Refs line", () => {
      const root = makeRoot();
      writeBrief(root, "s-703.xbrief.json", storyPlan(703, { id: "github.issue.703703" }));
      writeBrief(root, "s-704.xbrief.json", storyPlan(704));
      const bodyFile = join(root, "body.md");
      writeFileSync(bodyFile, "", "utf8");
      expect(runWrite(root, bodyFile, gitFor([], "swarm/w/github.issue.703703")).code).toBe(
        EXIT_OK,
      );
      expect(readFileSync(bodyFile, "utf8")).toBe("deft-story: 703\n");
      writeFileSync(bodyFile, "Refs #704\n", "utf8");
      expect(runWrite(root, bodyFile, gitFor([])).code).toBe(EXIT_OK);
      expect(readFileSync(bodyFile, "utf8")).toBe("Refs #704\n\ndeft-story: 704\n");
      expect(
        storyIssuesForBranch({ projectRoot: root, repo: REPO, bodyText: "", runGit: gitFor([]) }),
      ).toEqual([]);
    });

    it("matches the branch plan id as a whole token, not a prefix (#6316 review)", () => {
      const root = makeRoot();
      writeBrief(root, "s-711.xbrief.json", storyPlan(711, { id: "github.issue.123" }));
      writeBrief(root, "s-712.xbrief.json", storyPlan(712, { id: "github.issue.1234" }));
      const git = gitFor([], "swarm/w/github.issue.1234");
      expect(
        storyIssuesForBranch({ projectRoot: root, repo: REPO, bodyText: "", runGit: git }),
      ).toEqual([712]);
      expect(
        storyIssuesForBranch({
          projectRoot: root,
          repo: REPO,
          bodyText: "",
          runGit: gitFor([], "swarm/w/github.issue.123"),
        }),
      ).toEqual([711]);
    });

    it("keeps a dotted repository name from the origin remote (#6316 review)", () => {
      const root = makeRoot();
      writeFileSync(
        join(root, "xbrief", "active", "s-713.xbrief.json"),
        JSON.stringify({
          plan: {
            status: "running",
            references: [
              { uri: "https://github.com/acme/my.app/issues/713", type: "x-xbrief/github-issue" },
            ],
          },
        }),
        "utf8",
      );
      const bodyFile = join(root, "body.md");
      writeFileSync(bodyFile, "Refs #713\n", "utf8");
      const result = writeStoryLineToBodyFile({
        bodyFile,
        projectRoot: root,
        repo: null,
        part: false,
        runGit: (cmd) =>
          cmd.includes("get-url")
            ? { returncode: 0, stdout: "git@github.com:acme/my.app.git\n", stderr: "" }
            : gitFor([])(cmd),
      });
      expect(result.code).toBe(0);
      expect(readFileSync(bodyFile, "utf8")).toBe("Refs #713\n\ndeft-story: 713\n");
    });

    it("leaves a body that already has one of the lines unchanged", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-705.xbrief.json", storyPlan(705));
      const bodyFile = join(root, "body.md");
      for (const line of ["deft-story: 705", "deft-story-part: 705"]) {
        const text = `Refs #705\n\n${line}\n`;
        writeFileSync(bodyFile, text, "utf8");
        const { code, err } = runWrite(root, bodyFile, gitFor([rel]));
        expect(code).toBe(EXIT_OK);
        expect(err).toContain("unchanged");
        expect(readFileSync(bodyFile, "utf8")).toBe(text);
      }
    });

    it("fails a body with both lines for one issue and leaves no-story branches unchanged", () => {
      const root = makeRoot();
      const rel = writeBrief(root, "s-706.xbrief.json", storyPlan(706));
      const bodyFile = join(root, "body.md");
      writeFileSync(bodyFile, "deft-story: 706\ndeft-story-part: 706\n", "utf8");
      expect(runWrite(root, bodyFile, gitFor([rel])).code).toBe(EXIT_HITS_FOUND);
      const empty = makeRoot();
      writeFileSync(join(empty, "b.md"), "x\n", "utf8");
      const none = runWrite(empty, join(empty, "b.md"), gitFor([]));
      expect(none.code).toBe(EXIT_OK);
      expect(none.err).toContain("no running story");
      expect(readFileSync(join(empty, "b.md"), "utf8")).toBe("x\n");
    });

    it("refuses bad flag combinations and unreadable inputs", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(parseArgs(["--write-story-line", "--part"])).toMatchObject({
        writeStoryLine: true,
        part: true,
      });
      expect(run(["--body-file", "b.md", "--part"])).toBe(EXIT_CONFIG_ERROR);
      expect(run(["--pr", "1", "--write-story-line"])).toBe(EXIT_CONFIG_ERROR);
      expect(run(["--write-story-line"])).toBe(EXIT_CONFIG_ERROR);
      stderr.mockRestore();
      const root = makeRoot();
      expect(
        writeStoryLineToBodyFile({
          bodyFile: join(root, "missing.md"),
          projectRoot: root,
          repo: REPO,
          part: false,
        }).code,
      ).toBe(2);
      writeFileSync(join(root, "b.md"), "x\n", "utf8");
      const noRepo = writeStoryLineToBodyFile({
        bodyFile: join(root, "b.md"),
        projectRoot: root,
        repo: null,
        part: false,
        runGit: () => ({ returncode: 1, stdout: "", stderr: "" }),
      });
      expect(noRepo.code).toBe(2);
      expect(noRepo.message).toContain("--repo");
    });
  });
});

describe("in-PR completion story line (#6277 Bound 6)", () => {
  const repo = "acme/app";
  const rel = "xbrief/completed/2026-11-16-77-story.xbrief.json";

  function landedRoot(disposition: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "ck-lwp-"));
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(
      join(root, rel),
      JSON.stringify({
        plan: {
          id: "github.issue.77",
          status: "completed",
          references: [
            { uri: `https://github.com/${repo}/issues/77`, type: "x-xbrief/github-issue" },
          ],
          metadata: {
            lifecycleWrite: {
              action: "complete",
              writtenAt: "2026-11-16T00:00:00Z",
              ...(disposition !== null ? { completionDisposition: disposition } : {}),
            },
          },
        },
      }),
      "utf8",
    );
    return root;
  }

  const files = [
    {
      status: "renamed",
      path: rel,
      previousFilename: "xbrief/active/2026-11-16-77-story.xbrief.json",
    },
    { status: "modified", path: "src/app.ts" },
  ];

  it("refuses a part line on a PR that completes its story in-PR, and admits the keyword alone", () => {
    const root = landedRoot("lands-with-product");
    try {
      expect(landsWithProductIssues(root, repo, files)).toEqual([77]);
      const part = evaluateStoryLineRequirement({
        bodyText: "Closes #77\n\ndeft-story-part: 77\n",
        prNumber: 90,
        projectRoot: root,
        repo,
        files,
      });
      expect(part.ok).toBe(false);
      expect(part.messages[0]).toMatch(/completes story #77 in-PR/);
      expect(part.messages[0]).toMatch(/#6317/);
      const keyword = evaluateStoryLineRequirement({
        bodyText: "Closes #77\n",
        prNumber: 90,
        projectRoot: root,
        repo,
        files,
      });
      expect(keyword.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores completed briefs without the disposition, removed paths and unreadable files", () => {
    const root = landedRoot(null);
    try {
      expect(landsWithProductIssues(root, repo, files)).toEqual([]);
      expect(
        landsWithProductIssues(root, repo, [
          { status: "removed", path: rel },
          { status: "added", path: "xbrief/completed/missing.xbrief.json" },
          { status: "added", path: "src/app.ts" },
        ]),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
