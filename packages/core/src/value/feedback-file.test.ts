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
});
