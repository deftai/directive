import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  fullStoryCloseIntentFromBody,
  isBriefLandShapedDiff,
  isLeftoverShapedDiff,
  isSkipActiveDeliveryShape,
  parseAllDeftStoryMarks,
  parseAllowList,
  parseArgs,
  parseDeftStoryMark,
  run,
} from "./main.js";
import type { RunGhFn } from "./types.js";

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

  it("exits zero for clean body with only Refs (both modes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: lint introduction.\n\nRefs #1234\n", "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body])).toBe(EXIT_OK);
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
      expect(run(["--body-file", body, "--mode", "fp"])).toBe(EXIT_OK);
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
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
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
      expect(run(["--body-file", body, "--mode", "fp"])).toBe(EXIT_OK);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(run(["--body-file", body, "--mode", "intent"])).toBe(EXIT_HITS_FOUND);
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
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
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
      expect(run(["--body-file", body, "--allow-close", "55"])).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("body trailer text does not suppress intent hits (CLI allow-close only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "feat: done.\n\nCloses #55\n\ndeft-close-intent: full\n", "utf8");
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
      expect(run(["--body-file", body, "--allow-close", "55"])).toBe(EXIT_OK);
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
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
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
      expect(run(["--body-file", body, "--allow-known-false-positives", "abc"])).toBe(
        EXIT_CONFIG_ERROR,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits two for missing body file", () => {
    expect(run(["--body-file", join(tmpdir(), "does-not-exist.md")])).toBe(EXIT_CONFIG_ERROR);
  });

  it("FP allow list suppresses class-A hits without --allow-close (both mode)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "Body. Intentionally not `Closes #999` (test fixture).\n", "utf8");
      expect(run(["--body-file", body])).toBe(EXIT_HITS_FOUND);
      // Class A stays exclusive to FP mode — no intent leak into --allow-close.
      expect(run(["--body-file", body, "--allow-known-false-positives", "999"])).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cmdPrCheckClosingKeywords delegates to run", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-closing-keywords-"));
    try {
      const body = join(dir, "body.md");
      writeFileSync(body, "Refs #642 only.", "utf8");
      expect(cmdPrCheckClosingKeywords(["--body-file", body])).toBe(EXIT_OK);
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
    expect(run(["--mode", "intent", "--body-file", body, "--allow-close", "4494"])).toBe(EXIT_OK);
    stderr.mockRestore();
  });

  it("five-origin comma-list without one-PR-unit fails closed even with --allow-close", () => {
    writeFileSync(body, "Closes #4204, #4218, #4161, #3918, #3849\n", "utf8");
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
    ]);
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(stderr.mock.calls.join("")).toMatch(/missing one-PR-unit consent/);
    stderr.mockRestore();
  });

  it("--allow-close 4204,4218 is not one-PR-unit consent", () => {
    writeFileSync(body, "Closes #4204, #4218\n", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run([
      "--mode",
      "intent",
      "--body-file",
      body,
      "--allow-close",
      "4204,4218",
      "--repo",
      "deftai/directive",
    ]);
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
