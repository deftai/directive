import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ADOPTION_BLOCKER_TITLE_TOKEN,
  buildFrameworkGapBody,
  buildFrameworkGapTitle,
  FEEDBACK_CLOSED_DEDUP_WINDOW,
  FRAMEWORK_GAP_TITLE_PREFIX,
  feedbackFileMain,
  fenceFreeTextSection,
  findDuplicateIssue,
  isMaintainerFrameworkRepo,
  normalizeForDedup,
  parseFeedbackFileArgs,
  runFeedbackFile,
  walkClosedIssuesForFeedbackDedup,
} from "./feedback-file.js";

function makeConsumerProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-feedback-consumer-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify(
      {
        plan: {
          policy: {
            valueFeedback: {
              enabled: true,
              emitEvents: true,
              sessionLine: true,
              upstreamPrompt: true,
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

function isOpenInventory(args: readonly string[]): boolean {
  return args.includes("--paginate") && args.includes("--slurp");
}

function isClosedPage(args: readonly string[]): boolean {
  const joined = args.join(" ");
  return joined.includes("state=closed") && joined.includes("sort=updated");
}

function isCommentPost(args: readonly string[]): boolean {
  return args.includes("POST") && args.some((a) => /\/issues\/\d+\/comments$/.test(a));
}

function isIssueCreatePost(args: readonly string[]): boolean {
  return (
    args.includes("POST") &&
    !isCommentPost(args) &&
    args.some((a) => typeof a === "string" && /\/issues$/.test(a))
  );
}

function emptySeams(): { runGhApiFn: ReturnType<typeof vi.fn> } {
  return {
    runGhApiFn: vi.fn((args: readonly string[]) => {
      if (isOpenInventory(args) || isClosedPage(args)) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      return { returncode: 0, stdout: "{}", stderr: "" };
    }),
  };
}

describe("feedback-file helpers", () => {
  it("builds a prefixed framework-gap title", () => {
    expect(buildFrameworkGapTitle("Missing decompose hint")).toBe(
      `${FRAMEWORK_GAP_TITLE_PREFIX} Missing decompose hint`,
    );
    expect(buildFrameworkGapTitle("[framework-gap] Already tagged")).toBe(
      "[framework-gap] Already tagged",
    );
  });

  it("renders structured body sections", () => {
    const body = buildFrameworkGapBody({
      summary: "Gate false positive",
      context: "During pre-PR",
      expected: "Pass",
      actual: "Failed on encoding",
    });
    expect(body).toContain("## Summary");
    expect(body).toContain("Gate false positive");
    expect(body).toContain("During pre-PR");
    expect(body).toContain("Refs #1709");
    expect(body).toContain("`deft feedback:file`");
    expect(body).not.toContain("`task feedback:file`");
    expect(body).toContain("_Filed via");
  });

  it("uses evidence-append footer for comment mode (#5099)", () => {
    const comment = buildFrameworkGapBody({ summary: "Evidence" }, { mode: "comment" });
    expect(comment).toContain("_Evidence appended via `deft feedback:file`");
    expect(comment).not.toContain("_Filed via");
  });

  it("fences line-leading # and --- in free-text sections (#4375)", () => {
    expect(fenceFreeTextSection("# Heading\n---\nplain")).toBe("    # Heading\n    ---\nplain");
    const body = buildFrameworkGapBody({
      summary: "Fence check",
      context: "# Injected heading\n---\nmore",
      expected: "## Expected leak",
      actual: "---\nactual",
      sessionNotes: "# note",
    });
    expect(body).toContain("    # Injected heading");
    expect(body).toContain("    ---");
    expect(body).toContain("    ## Expected leak");
    expect(body).toContain("    # note");
    expect(body).not.toMatch(/\n# Injected heading/);
  });

  it("normalizes titles for dedup", () => {
    expect(normalizeForDedup("[framework-gap] Hello World")).toBe("hello world");
    expect(normalizeForDedup("  [FRAMEWORK-GAP]  Hello!!!  ")).toBe("hello");
  });
});

describe("findDuplicateIssue", () => {
  it("returns a match when normalized titles align", () => {
    const seams = {
      runGhApiFn: vi.fn(() => ({
        returncode: 0,
        stdout: JSON.stringify([
          {
            number: 42,
            state: "open",
            title: "[framework-gap] Missing skill coverage",
            html_url: "https://github.com/deftai/directive/issues/42",
          },
        ]),
        stderr: "",
      })),
    };
    const found = findDuplicateIssue(
      "deftai/directive",
      buildFrameworkGapTitle("Missing skill coverage"),
      seams,
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.match?.url).toBe("https://github.com/deftai/directive/issues/42");
    expect(found.match?.number).toBe(42);
    expect(found.match?.state).toBe("open");
  });
});

describe("runFeedbackFile gates", () => {
  it("rejects filing without confirmation", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Needs clearer onboarding",
        projectRoot: root,
        confirm: false,
        seams: emptySeams(),
      });
      expect(result.outcome).toBe("draft");
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("Re-run with --confirm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips filing inside the maintainer framework repo", () => {
    const repoRoot = process.cwd();
    expect(isMaintainerFrameworkRepo(repoRoot)).toBe(true);
    const result = runFeedbackFile({
      summary: "Dogfood gap",
      projectRoot: repoRoot,
      confirm: true,
    });
    expect(result.outcome).toBe("skipped-maintainer");
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Skipped");
  });

  it("comments on open duplicate with --confirm (retires blocked-duplicate)", () => {
    const root = makeConsumerProject();
    const posts: string[] = [];
    try {
      const result = runFeedbackFile({
        summary: "Duplicate gap",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 99,
                    state: "open",
                    title: "[framework-gap] Duplicate gap",
                    html_url: "https://github.com/deftai/directive/issues/99",
                  },
                ]),
                stderr: "",
              };
            }
            if (isCommentPost(args)) {
              posts.push("comment");
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  id: 555,
                  html_url: "https://github.com/deftai/directive/issues/99#issuecomment-555",
                }),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args)) {
              posts.push("create");
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  number: 1000,
                  html_url: "https://github.com/deftai/directive/issues/1000",
                }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("commented-open-duplicate");
      expect(result.exitCode).toBe(0);
      expect(result.duplicateUrl).toContain("/issues/99");
      expect(result.commentUrl).toContain("issuecomment-555");
      expect(result.body).toContain("_Evidence appended via");
      expect(posts).toEqual(["comment"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("files upstream only after explicit confirmation", () => {
    const root = makeConsumerProject();
    const createPayload = vi.fn(() => ({
      returncode: 0,
      stdout: JSON.stringify({
        html_url: "https://github.com/deftai/directive/issues/1001",
        number: 1001,
      }),
      stderr: "",
    }));
    try {
      const result = runFeedbackFile({
        summary: "Confirmed gap",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: (args: readonly string[]) => {
            if (isIssueCreatePost(args)) {
              return createPayload();
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          },
        },
      });
      expect(result.outcome).toBe("filed");
      expect(result.exitCode).toBe(0);
      expect(result.issueUrl).toBe("https://github.com/deftai/directive/issues/1001");
      expect(createPayload).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks when upstreamPrompt policy path is OFF", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-feedback-off-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { policy: { valueFeedback: { enabled: true, upstreamPrompt: false } } },
      }),
      "utf8",
    );
    try {
      const result = runFeedbackFile({
        summary: "Policy blocked",
        projectRoot: root,
        confirm: true,
      });
      expect(result.outcome).toBe("blocked-policy");
      expect(result.exitCode).toBe(1);
      expect(result.title).toContain("Policy blocked");
      expect(result.body).toContain("## Summary");
      expect(result.message).toContain("--upstream-prompt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gate-OFF dry-run and --json still return title+body template (#4375)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-feedback-off-readout-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: { policy: { valueFeedback: { enabled: true, upstreamPrompt: false } } },
      }),
      "utf8",
    );
    try {
      const dry = runFeedbackFile({
        summary: "OFF-policy draft",
        context: "mid-session",
        projectRoot: root,
        dryRun: true,
      });
      expect(dry.outcome).toBe("blocked-policy");
      expect(dry.title).toBe(`${FRAMEWORK_GAP_TITLE_PREFIX} OFF-policy draft`);
      expect(dry.body).toContain("## Summary");
      expect(dry.body).toContain("OFF-policy draft");
      expect(dry.body).toContain("mid-session");
      expect(dry.message).toContain("Draft framework-gap issue");
      expect(dry.message).toContain("--upstream-prompt");

      const json = runFeedbackFile({
        summary: "OFF-policy json",
        projectRoot: root,
        json: true,
      });
      expect(json.outcome).toBe("blocked-policy");
      expect(json.title).toBe(`${FRAMEWORK_GAP_TITLE_PREFIX} OFF-policy json`);
      expect(json.body.length).toBeGreaterThan(0);
      expect(json.message).toContain("Draft framework-gap issue");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("feedback-file CLI", () => {
  it("parses positional summary and flags", () => {
    const parsed = parseFeedbackFileArgs([
      "--context",
      "ctx",
      "--confirm",
      "My",
      "summary",
      "here",
    ]);
    expect(parsed.summary).toBe("My summary here");
    expect(parsed.context).toBe("ctx");
    expect(parsed.confirm).toBe(true);
  });

  it("accumulates two space-separated --context flags", () => {
    const parsed = parseFeedbackFileArgs(["--context", "first", "--context", "second"]);
    expect(parsed.context).toBe("first\nsecond");
  });

  it("accumulates two --context= flags", () => {
    const parsed = parseFeedbackFileArgs(["--context=first", "--context=second"]);
    expect(parsed.context).toBe("first\nsecond");
  });

  it("keeps prior --context when a later flag has no value", () => {
    const parsed = parseFeedbackFileArgs(["--context", "kept", "--context"]);
    expect(parsed.context).toBe("kept");
  });

  it("parses --on-closed equals and space forms; rejects bogus", () => {
    expect(parseFeedbackFileArgs(["--on-closed=comment"]).onClosed).toBe("comment");
    expect(parseFeedbackFileArgs(["--on-closed", "create-anyway"]).onClosed).toBe("create-anyway");
    expect(parseFeedbackFileArgs(["--on-closed=bogus"]).error).toMatch(/invalid --on-closed/);
    expect(feedbackFileMain(["--summary", "x", "--on-closed=bogus"])).toBe(2);
  });

  it("returns config error when summary missing", () => {
    expect(feedbackFileMain([])).toBe(2);
  });

  it("returns error-network when duplicate search fails", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Network gap",
        projectRoot: root,
        confirm: false,
        seams: {
          runGhApiFn: () => ({
            returncode: 1,
            stdout: "",
            stderr: "rate limit",
          }),
        },
      });
      expect(result.outcome).toBe("error-network");
      expect(result.exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns error-network when filing fails after confirm", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Filing gap",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: (args: readonly string[]) => {
            if (isIssueCreatePost(args)) {
              return { returncode: 1, stdout: "", stderr: "forbidden" };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          },
        },
      });
      expect(result.outcome).toBe("error-network");
      expect(result.exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs duplicate detection during dry-run preview", () => {
    const root = makeConsumerProject();
    const listCalls = vi.fn((args: readonly string[]) => {
      if (isOpenInventory(args) || isClosedPage(args)) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      return { returncode: 0, stdout: "{}", stderr: "" };
    });
    try {
      runFeedbackFile({
        summary: "Dry preview",
        projectRoot: root,
        dryRun: true,
        confirm: false,
        seams: { runGhApiFn: listCalls },
      });
      expect(listCalls).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses equals-form flags and rejects unknown options (#3144)", () => {
    const parsed = parseFeedbackFileArgs([
      "--summary=Equals summary",
      "--context=ctx-eq",
      "--expected=pass",
      "--actual=fail",
      "--notes=session-eq",
      "--repo=other/repo",
      "--project-root=/tmp/x",
      "--dry-run",
      "--json",
    ]);
    expect(parsed.summary).toBe("Equals summary");
    expect(parsed.context).toBe("ctx-eq");
    expect(parsed.expected).toBe("pass");
    expect(parsed.actual).toBe("fail");
    expect(parsed.sessionNotes).toBe("session-eq");
    expect(parsed.repo).toBe("other/repo");
    expect(parsed.projectRoot).toBe("/tmp/x");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parseFeedbackFileArgs(["--bogus"]).error).toMatch(/unrecognized/);
  });

  it("skips dedup when DEFT_NO_NETWORK=1 and dry-runs after confirm (#3144)", () => {
    const root = makeConsumerProject();
    const prev = process.env.DEFT_NO_NETWORK;
    process.env.DEFT_NO_NETWORK = "1";
    try {
      const draft = runFeedbackFile({
        summary: "Offline draft",
        projectRoot: root,
        confirm: false,
      });
      expect(draft.outcome).toBe("draft");
      expect(draft.message).toMatch(/duplicate detection skipped/);

      const dry = runFeedbackFile({
        summary: "Offline confirm",
        projectRoot: root,
        confirm: true,
        dryRun: true,
      });
      expect(dry.outcome).toBe("draft");
      expect(dry.exitCode).toBe(0);
      expect(dry.message).toMatch(/Dry run/);
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_NO_NETWORK;
      } else {
        process.env.DEFT_NO_NETWORK = prev;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits json CLI output and falls back when html_url is missing (#3144)", () => {
    const root = makeConsumerProject();
    const prevNet = process.env.DEFT_NO_NETWORK;
    try {
      process.env.DEFT_NO_NETWORK = "1";
      const code = feedbackFileMain(["--summary", "Json path", "--project-root", root, "--json"]);
      expect(code).toBe(1);

      delete process.env.DEFT_NO_NETWORK;
      const filed = runFeedbackFile({
        summary: "No url filed",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: (args: readonly string[]) => {
            if (isIssueCreatePost(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify({ number: 77 }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          },
        },
      });
      expect(filed.outcome).toBe("filed");
      expect(filed.issueUrl).toContain("/issues/77");
    } finally {
      if (prevNet === undefined) {
        delete process.env.DEFT_NO_NETWORK;
      } else {
        process.env.DEFT_NO_NETWORK = prevNet;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns config error when project root cannot be resolved (#3144)", () => {
    const result = runFeedbackFile({
      summary: "No root",
      projectRoot: join(tmpdir(), "deft-feedback-missing-root-xyz"),
      confirm: true,
    });
    expect(result.outcome).toBe("error-config");
    expect(result.exitCode).toBe(2);
  });

  it("handles empty-title duplicate needle and missing issue html_url (#3144)", () => {
    expect(findDuplicateIssue("deftai/directive", "   ", {}).ok).toBe(true);
    expect(
      findDuplicateIssue("deftai/directive", "   ", {}).ok &&
        findDuplicateIssue("deftai/directive", "   ", {}).match,
    ).toBeNull();
    const found = findDuplicateIssue("deftai/directive", "Gap title", {
      runGhApiFn: vi.fn(() => ({
        returncode: 0,
        stdout: JSON.stringify([
          { title: 123 },
          {
            number: 9,
            state: "open",
            title: "[framework-gap] Gap title",
            html_url: "https://github.com/deftai/directive/issues/9",
          },
        ]),
        stderr: "",
      })),
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.match?.url).toContain("/issues/9");
    const malformed = findDuplicateIssue("deftai/directive", "Gap title", {
      runGhApiFn: vi.fn(() => ({
        returncode: 0,
        stdout: JSON.stringify([{ title: "Gap title", html_url: "", number: 1, state: "open" }]),
        stderr: "",
      })),
    });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error).toMatch(/usable numeric number/);
  });
});

describe("Prefer-A Recut-2 open inventory + closed walk (#5099)", () => {
  it("finds open match regardless of closed-heavy neighbors", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Open wins",
        projectRoot: root,
        confirm: false,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 11,
                    state: "open",
                    title: "[framework-gap] Open wins",
                    html_url: "https://github.com/deftai/directive/issues/11",
                  },
                ]),
                stderr: "",
              };
            }
            // Closed walk should not be consulted once open match exists.
            if (isClosedPage(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 12,
                    state: "closed",
                    title: "[framework-gap] Open wins",
                    html_url: "https://github.com/deftai/directive/issues/12",
                  },
                ]),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("draft");
      expect(result.duplicateUrl).toContain("/issues/11");
      expect(result.message).toContain("Open duplicate");
      expect(result.message).toContain("_Evidence appended via");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on open-inventory failure (no create)", () => {
    const root = makeConsumerProject();
    const posts: string[] = [];
    try {
      const result = runFeedbackFile({
        summary: "Inventory fail",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return { returncode: 1, stdout: "", stderr: "boom" };
            }
            if (isIssueCreatePost(args) || isCommentPost(args)) {
              posts.push("mutation");
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("error-network");
      expect(posts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run --confirm open-match performs zero mutations", () => {
    const root = makeConsumerProject();
    const posts: string[] = [];
    try {
      const result = runFeedbackFile({
        summary: "Dry open",
        projectRoot: root,
        confirm: true,
        dryRun: true,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 7,
                    state: "open",
                    title: "[framework-gap] Dry open",
                    html_url: "https://github.com/deftai/directive/issues/7",
                  },
                ]),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args) || isCommentPost(args)) {
              posts.push("mutation");
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("draft");
      expect(result.exitCode).toBe(0);
      expect(posts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closed window-exhausted without match creates with incomplete note", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Window note",
        projectRoot: root,
        confirm: true,
        closedWindow: 2,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return { returncode: 0, stdout: "[]", stderr: "" };
            }
            if (isClosedPage(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 1,
                    state: "closed",
                    title: "other one",
                    html_url: "https://github.com/deftai/directive/issues/1",
                  },
                  {
                    number: 2,
                    state: "closed",
                    title: "other two",
                    html_url: "https://github.com/deftai/directive/issues/2",
                  },
                ]),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  number: 300,
                  html_url: "https://github.com/deftai/directive/issues/300",
                }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("filed");
      expect(result.message).toContain("stopReason=window-exhausted");
      expect(result.message).toContain("inspectedIssueCount=2");
      expect(result.message).toContain("window=2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closed list-exhausted without match creates without incomplete warning", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "List exhausted",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args) || isClosedPage(args)) {
              return { returncode: 0, stdout: "[]", stderr: "" };
            }
            if (isIssueCreatePost(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  number: 301,
                  html_url: "https://github.com/deftai/directive/issues/301",
                }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "{}", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("filed");
      expect(result.message).not.toContain("closed-issue search incomplete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closed cap before window end with PR-heavy pages notes stopReason=cap", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Cap note",
        projectRoot: root,
        confirm: true,
        closedWindow: 50,
        closedRowBudget: 3,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return { returncode: 0, stdout: "[]", stderr: "" };
            }
            if (isClosedPage(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 10,
                    state: "closed",
                    title: "pr twin",
                    html_url: "https://github.com/deftai/directive/pull/10",
                    pull_request: {},
                  },
                  {
                    number: 11,
                    state: "closed",
                    title: "pr twin 2",
                    html_url: "https://github.com/deftai/directive/pull/11",
                    pull_request: {},
                  },
                  {
                    number: 12,
                    state: "closed",
                    title: "pr twin 3",
                    html_url: "https://github.com/deftai/directive/pull/12",
                    pull_request: {},
                  },
                  {
                    number: 13,
                    state: "closed",
                    title: "real issue",
                    html_url: "https://github.com/deftai/directive/issues/13",
                  },
                ]),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  number: 302,
                  html_url: "https://github.com/deftai/directive/issues/302",
                }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("filed");
      expect(result.message).toContain("stopReason=cap");
      expect(result.message).not.toContain("stopReason=window-exhausted");
      expect(result.message).toContain("budget=3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes pull rows from title match and retained count", () => {
    const walk = walkClosedIssuesForFeedbackDedup(
      "deftai/directive",
      "[framework-gap] Pull twin",
      { window: 1 },
      {
        runGhApiFn: vi.fn(() => ({
          returncode: 0,
          stdout: JSON.stringify([
            {
              number: 80,
              state: "closed",
              title: "[framework-gap] Pull twin",
              html_url: "https://github.com/deftai/directive/pull/80",
              pull_request: {},
            },
            {
              number: 81,
              state: "closed",
              title: "unrelated",
              html_url: "https://github.com/deftai/directive/issues/81",
            },
          ]),
          stderr: "",
        })),
      },
    );
    expect(walk.match).toBeNull();
    expect(walk.outcome).toBe("window-exhausted");
    expect(walk.inspectedIssueCount).toBe(1);
    expect(walk.rawRows).toBeGreaterThanOrEqual(2);
  });

  it("blocks closed duplicate without disposition", () => {
    const root = makeConsumerProject();
    const posts: string[] = [];
    try {
      const result = runFeedbackFile({
        summary: "Closed twin",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return { returncode: 0, stdout: "[]", stderr: "" };
            }
            if (isClosedPage(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 44,
                    state: "closed",
                    title: "[framework-gap] Closed twin",
                    html_url: "https://github.com/deftai/directive/issues/44",
                  },
                ]),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args) || isCommentPost(args)) {
              posts.push("mutation");
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("blocked-closed-duplicate");
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("--on-closed=comment");
      expect(result.message).toContain("--on-closed=create-anyway");
      expect(posts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--on-closed=comment posts without reopen", () => {
    const root = makeConsumerProject();
    const posts: string[] = [];
    try {
      const result = runFeedbackFile({
        summary: "Closed comment",
        projectRoot: root,
        confirm: true,
        onClosed: "comment",
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return { returncode: 0, stdout: "[]", stderr: "" };
            }
            if (isClosedPage(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 55,
                    state: "closed",
                    title: "[framework-gap] Closed comment",
                    html_url: "https://github.com/deftai/directive/issues/55",
                  },
                ]),
                stderr: "",
              };
            }
            if (isCommentPost(args)) {
              posts.push("comment");
              expect(args.some((a) => a.includes("/issues/55/comments"))).toBe(true);
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  id: 900,
                  html_url: "https://github.com/deftai/directive/issues/55#issuecomment-900",
                }),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args)) {
              posts.push("create");
            }
            // PATCH reopen would be a different endpoint; ensure none.
            if (args.includes("PATCH")) {
              posts.push("patch");
            }
            return { returncode: 0, stdout: "{}", stderr: "" };
          }),
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.commentUrl).toContain("issuecomment-900");
      expect(posts).toEqual(["comment"]);
      expect(result.body).toContain("_Evidence appended via");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--on-closed=create-anyway creates with Related: closed #<n>", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Create anyway",
        projectRoot: root,
        confirm: true,
        onClosed: "create-anyway",
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return { returncode: 0, stdout: "[]", stderr: "" };
            }
            if (isClosedPage(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    number: 66,
                    state: "closed",
                    title: "[framework-gap] Create anyway",
                    html_url: "https://github.com/deftai/directive/issues/66",
                  },
                ]),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args)) {
              const input = args[args.indexOf("--input") + 1];
              const payload = JSON.parse(readFileSync(String(input), "utf8")) as {
                body?: string;
              };
              expect(payload.body).toContain("Related: closed #66");
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  number: 67,
                  html_url: "https://github.com/deftai/directive/issues/67",
                }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("filed");
      expect(result.body).toContain("Related: closed #66");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("malformed open row without number does not create", () => {
    const root = makeConsumerProject();
    const posts: string[] = [];
    try {
      const result = runFeedbackFile({
        summary: "Malformed",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: vi.fn((args: readonly string[]) => {
            if (isOpenInventory(args)) {
              return {
                returncode: 0,
                stdout: JSON.stringify([
                  {
                    state: "open",
                    title: "[framework-gap] Malformed",
                    html_url: "https://github.com/deftai/directive/issues/1",
                  },
                ]),
                stderr: "",
              };
            }
            if (isIssueCreatePost(args) || isCommentPost(args)) {
              posts.push("mutation");
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          }),
        },
      });
      expect(result.outcome).toBe("error-network");
      expect(posts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins FEEDBACK_CLOSED_DEDUP_WINDOW default at 500", () => {
    expect(FEEDBACK_CLOSED_DEDUP_WINDOW).toBe(500);
  });
});

describe("adoption-blocker title token (#3713)", () => {
  const summary = "Missing skill coverage";

  it("builds a marked title with [framework-gap] and BLOCKER", () => {
    expect(buildFrameworkGapTitle(summary, { adoptionBlocker: true })).toBe(
      `${FRAMEWORK_GAP_TITLE_PREFIX} ${ADOPTION_BLOCKER_TITLE_TOKEN} ${summary}`,
    );
    expect(
      buildFrameworkGapTitle("[framework-gap] BLOCKER: already tagged", { adoptionBlocker: true }),
    ).toBe(`${FRAMEWORK_GAP_TITLE_PREFIX} ${ADOPTION_BLOCKER_TITLE_TOKEN} already tagged`);
  });

  it("leaves unmarked titles without the BLOCKER token", () => {
    expect(buildFrameworkGapTitle(summary)).toBe(`${FRAMEWORK_GAP_TITLE_PREFIX} ${summary}`);
    expect(buildFrameworkGapTitle(summary, { adoptionBlocker: false })).toBe(
      `${FRAMEWORK_GAP_TITLE_PREFIX} ${summary}`,
    );
    expect(buildFrameworkGapTitle(summary)).not.toMatch(/\bBLOCKER\b/);
  });

  it("dedups marked and unmarked titles to the same needle", () => {
    const marked = buildFrameworkGapTitle(summary, { adoptionBlocker: true });
    const unmarked = buildFrameworkGapTitle(summary);
    expect(normalizeForDedup(marked)).toBe(normalizeForDedup(unmarked));
    expect(normalizeForDedup(marked)).toBe("missing skill coverage");
    expect(normalizeForDedup("BLOCKER: Missing skill coverage")).toBe("missing skill coverage");
    expect(normalizeForDedup("[framework-gap] Missing skill coverage")).toBe(
      "missing skill coverage",
    );
  });

  it("finds a duplicate when one side is marked and the other is not", () => {
    const unmarkedOpen = {
      number: 42,
      state: "open",
      title: "[framework-gap] Missing skill coverage",
      html_url: "https://github.com/deftai/directive/issues/42",
    };
    const markedFound = findDuplicateIssue(
      "deftai/directive",
      buildFrameworkGapTitle(summary, { adoptionBlocker: true }),
      {
        runGhApiFn: vi.fn(() => ({
          returncode: 0,
          stdout: JSON.stringify([unmarkedOpen]),
          stderr: "",
        })),
      },
    );
    expect(markedFound.ok).toBe(true);
    if (!markedFound.ok) return;
    const markedMatch = markedFound.match;
    expect(markedMatch?.url).toBe(unmarkedOpen.html_url);

    const unmarkedFound = findDuplicateIssue("deftai/directive", buildFrameworkGapTitle(summary), {
      runGhApiFn: vi.fn(() => ({
        returncode: 0,
        stdout: JSON.stringify([
          {
            number: 43,
            state: "open",
            title: "[framework-gap] BLOCKER Missing skill coverage",
            html_url: "https://github.com/deftai/directive/issues/43",
          },
        ]),
        stderr: "",
      })),
    });
    expect(unmarkedFound.ok).toBe(true);
    if (!unmarkedFound.ok) return;
    const unmarkedMatch = unmarkedFound.match;
    expect(unmarkedMatch?.url).toContain("/issues/43");
  });

  it("puts #3706 evidence in the body only when marked", () => {
    const marked = buildFrameworkGapBody({
      summary,
      adoptionBlocker: true,
      flowAndVersion: "task check on 0.80.0",
      alternatives: "reran doctor",
      recoveryCost: "session stuck 40m",
    });
    expect(marked).toContain("## Adoption impact");
    expect(marked).toContain("task check on 0.80.0");
    expect(marked).toContain("reran doctor");
    expect(marked).toContain("session stuck 40m");
    expect(marked).toContain("does not apply the `adoption-blocker` ranking label");
    expect(marked).toContain("### Triage owner and date");

    const unmarked = buildFrameworkGapBody({ summary });
    expect(unmarked).not.toContain("## Adoption impact");
    expect(unmarked).not.toContain("not a blocker");
  });

  it("parses --blocker and evidence flags", () => {
    const parsed = parseFeedbackFileArgs([
      "--summary",
      summary,
      "--blocker",
      "--flow",
      "install 0.80",
      "--alternatives",
      "none work",
      "--recovery-cost",
      "blocked",
    ]);
    expect(parsed.adoptionBlocker).toBe(true);
    expect(parsed.flowAndVersion).toBe("install 0.80");
    expect(parsed.alternatives).toBe("none work");
    expect(parsed.recoveryCost).toBe("blocked");
    expect(parseFeedbackFileArgs(["--summary", summary]).adoptionBlocker).toBeUndefined();
    expect(parseFeedbackFileArgs(["--flow=eq-flow", "--alternatives=eq-alt"]).flowAndVersion).toBe(
      "eq-flow",
    );
  });

  it("files a marked report without writing adoption-blocker", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary,
        adoptionBlocker: true,
        flowAndVersion: "update",
        alternatives: "pin prior",
        recoveryCost: "lost hour",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: (args: readonly string[]) => {
            if (isIssueCreatePost(args)) {
              const input = args[args.indexOf("--input") + 1];
              const payload = JSON.parse(readFileSync(String(input), "utf8")) as {
                title?: string;
                body?: string;
                labels?: unknown;
              };
              expect(payload.labels).toBeUndefined();
              expect(payload.title).toBe(
                `${FRAMEWORK_GAP_TITLE_PREFIX} ${ADOPTION_BLOCKER_TITLE_TOKEN} ${summary}`,
              );
              expect(payload.body).toContain("## Adoption impact");
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  html_url: "https://github.com/deftai/directive/issues/2001",
                  number: 2001,
                }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          },
        },
      });
      expect(result.outcome).toBe("filed");
      expect(result.title).toContain(ADOPTION_BLOCKER_TITLE_TOKEN);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fail or gate when the token is absent", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary,
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: (args: readonly string[]) => {
            if (isIssueCreatePost(args)) {
              const input = args[args.indexOf("--input") + 1];
              const payload = JSON.parse(readFileSync(String(input), "utf8")) as {
                title?: string;
                body?: string;
              };
              expect(payload.title).not.toMatch(/\bBLOCKER\b/);
              expect(payload.body).not.toContain("## Adoption impact");
              return {
                returncode: 0,
                stdout: JSON.stringify({
                  html_url: "https://github.com/deftai/directive/issues/2002",
                  number: 2002,
                }),
                stderr: "",
              };
            }
            return { returncode: 0, stdout: "[]", stderr: "" };
          },
        },
      });
      expect(result.outcome).toBe("filed");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
