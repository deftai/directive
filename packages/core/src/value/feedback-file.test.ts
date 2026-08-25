import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ADOPTION_BLOCKER_TITLE_TOKEN,
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
      title: "[framework-gap] Missing skill coverage",
      html_url: "https://github.com/deftai/directive/issues/42",
    };
    const markedMatch = findDuplicateIssue(
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
    expect(markedMatch?.url).toBe(unmarkedOpen.html_url);

    const unmarkedMatch = findDuplicateIssue("deftai/directive", buildFrameworkGapTitle(summary), {
      runGhApiFn: vi.fn(() => ({
        returncode: 0,
        stdout: JSON.stringify([
          {
            title: "[framework-gap] BLOCKER Missing skill coverage",
            html_url: "https://github.com/deftai/directive/issues/43",
          },
        ]),
        stderr: "",
      })),
    });
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
            if (args.includes("POST")) {
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
            if (args.includes("POST")) {
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
