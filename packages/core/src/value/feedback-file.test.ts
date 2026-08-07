import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildFrameworkGapBody,
  buildFrameworkGapTitle,
  FRAMEWORK_GAP_TITLE_PREFIX,
  feedbackFileMain,
  findDuplicateIssue,
  isMaintainerFrameworkRepo,
  normalizeForDedup,
  parseFeedbackFileArgs,
  runFeedbackFile,
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
            title: "[framework-gap] Missing skill coverage",
            html_url: "https://github.com/deftai/directive/issues/42",
          },
        ]),
        stderr: "",
      })),
    };
    const match = findDuplicateIssue(
      "deftai/directive",
      buildFrameworkGapTitle("Missing skill coverage"),
      seams,
    );
    expect(match?.url).toBe("https://github.com/deftai/directive/issues/42");
  });
});

describe("runFeedbackFile gates", () => {
  it("rejects filing without confirmation", () => {
    const root = makeConsumerProject();
    const restCreateIssue = vi.fn();
    try {
      const result = runFeedbackFile({
        summary: "Needs clearer onboarding",
        projectRoot: root,
        confirm: false,
        seams: {
          runGhApiFn: vi.fn(() => ({ returncode: 0, stdout: "[]", stderr: "" })),
        },
      });
      expect(result.outcome).toBe("draft");
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("Re-run with --confirm");
      expect(restCreateIssue).not.toHaveBeenCalled();
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

  it("blocks duplicate upstream issues", () => {
    const root = makeConsumerProject();
    try {
      const result = runFeedbackFile({
        summary: "Duplicate gap",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: vi.fn(() => ({
            returncode: 0,
            stdout: JSON.stringify([
              {
                title: "[framework-gap] Duplicate gap",
                html_url: "https://github.com/deftai/directive/issues/99",
              },
            ]),
            stderr: "",
          })),
        },
      });
      expect(result.outcome).toBe("blocked-duplicate");
      expect(result.exitCode).toBe(1);
      expect(result.duplicateUrl).toContain("/issues/99");
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
            if (args.includes("POST")) {
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
            if (args.includes("POST")) {
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
    const listCalls = vi.fn(() => ({
      returncode: 0,
      stdout: JSON.stringify([]),
      stderr: "",
    }));
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
      // Offline so draft path does not flaky-fail on live gh dedup (exit 2 network).
      process.env.DEFT_NO_NETWORK = "1";
      const code = feedbackFileMain(["--summary", "Json path", "--project-root", root, "--json"]);
      expect(code).toBe(1);

      // Filing path uses seams; clear offline so confirm+seams still exercises POST.
      delete process.env.DEFT_NO_NETWORK;
      const filed = runFeedbackFile({
        summary: "No url filed",
        projectRoot: root,
        confirm: true,
        seams: {
          runGhApiFn: (args: readonly string[]) => {
            if (args.includes("POST")) {
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
    expect(findDuplicateIssue("deftai/directive", "   ", {})).toBeNull();
    const match = findDuplicateIssue("deftai/directive", "Gap title", {
      runGhApiFn: vi.fn(() => ({
        returncode: 0,
        stdout: JSON.stringify([
          { title: "Gap title", html_url: "" },
          { title: 123 },
          {
            title: "[framework-gap] Gap title",
            html_url: "https://github.com/deftai/directive/issues/9",
          },
        ]),
        stderr: "",
      })),
    });
    expect(match?.url).toContain("/issues/9");
  });
});
