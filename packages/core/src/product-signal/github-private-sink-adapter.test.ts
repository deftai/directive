import { describe, expect, it, vi } from "vitest";
import { GhRestError } from "../scm/gh-rest.js";
import { classifySinkError } from "./gates.js";
import {
  buildThreadMarker,
  GitHubPrivateSinkAdapter,
  mergeIssueLabels,
} from "./github-private-sink-adapter.js";
import { isHeadlessSession } from "./headless.js";
import type { ProductSignalPayload } from "./payload.js";
import { bootstrapProductSignalLabels, bootstrapProductSignalSink } from "./sink-bootstrap.js";

function samplePayload(overrides: Partial<ProductSignalPayload> = {}): ProductSignalPayload {
  return {
    schemaVersion: 1,
    surface: "pulse",
    installId: "install-abc",
    actorName: "Alex",
    actorNameSource: "user-md",
    directiveVersion: "0.80.0",
    os: "win32",
    osVersion: "v24.0.0",
    shell: "powershell",
    harness: "cursor",
    harnessVersion: null,
    consentTier: "product-signal",
    consentSource: "user",
    consentVersion: "1",
    human: { nps: 9, answers: [{ q: "liked?", a: "fast" }], freeText: null },
    agentNotes: null,
    localSignalSummary: null,
    skillsSummary: null,
    collectedAt: "2026-07-21T12:00:00Z",
    ...overrides,
  };
}

describe("classifySinkError", () => {
  it("maps 403 to sink-unauthorized", () => {
    expect(classifySinkError("HTTP 403 Forbidden", 1)).toBe("sink-unauthorized");
  });

  it("maps generic failure to sink-unreachable", () => {
    expect(classifySinkError("timeout", 1)).toBe("sink-unreachable");
  });
});

describe("headless detection", () => {
  it("detects CI env", () => {
    expect(isHeadlessSession({ env: { CI: "true" }, stdinIsTTY: true })).toBe(true);
  });

  it("detects DEFT_HEADLESS", () => {
    expect(isHeadlessSession({ env: { DEFT_HEADLESS: "1" } })).toBe(true);
  });
});

describe("GitHubPrivateSinkAdapter", () => {
  it("creates pulse standing issue and comments", async () => {
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      const path = args[0] ?? "";
      if (path.includes("/comments") && args.includes("--method") && args.includes("POST")) {
        return { returncode: 0, stdout: JSON.stringify({ id: 1 }), stderr: "" };
      }
      if (path.includes("/issues") && args.includes("--method") && args.includes("POST")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ number: 42, html_url: "https://github.com/o/r/issues/42" }),
          stderr: "",
        };
      }
      if (path.includes("/issues") && args.includes("GET")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      return { returncode: 0, stdout: "{}", stderr: "" };
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(samplePayload());
    expect(result.outcome).toBe("submitted");
    expect(result.issueNumber).toBe(42);
  });

  it("upserts portrait when standing issue exists", async () => {
    const marker = buildThreadMarker("install-abc", "Alex", "portrait");
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            {
              number: 7,
              body: marker,
              html_url: "https://github.com/o/r/issues/7",
            },
          ]),
          stderr: "",
        };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify({ number: 7, html_url: "https://github.com/o/r/issues/7" }),
        stderr: "",
      };
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(samplePayload({ surface: "portrait" }));
    expect(result.outcome).toBe("submitted");
    expect(result.message).toContain("portrait upserted");
  });

  it("soft-skips on GhRestError", async () => {
    const runGhApiFn = vi.fn(() => ({
      returncode: 1,
      stdout: "",
      stderr: "403 Forbidden",
    }));
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(samplePayload());
    expect(result.outcome).toBe("sink-unauthorized");
  });

  it("appends pulse comment on existing standing issue", async () => {
    const marker = buildThreadMarker("install-abc", "Alex", "pulse");
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            { number: 3, body: marker, html_url: "https://github.com/o/r/issues/3" },
          ]),
          stderr: "",
        };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify({ number: 3, html_url: "https://github.com/o/r/issues/3" }),
        stderr: "",
      };
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(
      samplePayload({
        human: { nps: 7, answers: [], freeText: "good" },
        agentNotes: "notes",
        harnessVersion: "1.0",
        localSignalSummary: {
          schemaVersion: 1,
          window: "7d",
          valueFeedback: null,
          evalHealth: null,
          helpedHealth: null,
        },
        skillsSummary: {
          schemaVersion: 1,
          top: [{ skill: "build", useCount: 1, viewCount: 0, lastUsed: null }],
          skillCount: 1,
        },
      }),
    );
    expect(result.outcome).toBe("submitted");
    expect(result.message).toContain("pulse comment appended");
  });

  it("creates new portrait standing issue", async () => {
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify({ number: 9, html_url: "https://github.com/o/r/issues/9" }),
        stderr: "",
      };
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(
      samplePayload({ surface: "portrait", human: { nps: 4, answers: [], freeText: null } }),
    );
    expect(result.outcome).toBe("submitted");
    expect(result.message).toContain("portrait standing issue created");
  });

  it("soft-skips on generic thrown error", async () => {
    const runGhApiFn = vi.fn(() => {
      throw new Error("network down");
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(samplePayload());
    expect(result.outcome).toBe("sink-unreachable");
    expect(result.message).toContain("network down");
  });

  it("handles portrait standing issue missing number", async () => {
    const marker = buildThreadMarker("install-abc", "Alex", "portrait");
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([{ body: marker, html_url: "https://github.com/o/r/issues/7" }]),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: "{}", stderr: "" };
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(samplePayload({ surface: "portrait" }));
    expect(result.outcome).toBe("sink-unreachable");
  });

  it("submits pulse with null nps", async () => {
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify({ number: 2, html_url: "https://github.com/o/r/issues/2" }),
        stderr: "",
      };
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(
      samplePayload({ human: { nps: null, answers: [], freeText: null } }),
    );
    expect(result.outcome).toBe("submitted");
  });
});

describe("appendGapCommentOnPulse", () => {
  it("returns unreachable when no pulse thread", () => {
    const runGhApiFn = vi.fn(() => ({ returncode: 0, stdout: "[]", stderr: "" }));
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = adapter.appendGapCommentOnPulse(
      samplePayload({ installId: "x" }),
      "hook blocked write",
    );
    expect(result.outcome).toBe("sink-unreachable");
  });

  it("appends gap comment on existing pulse thread", () => {
    const marker = buildThreadMarker("install-abc", "Alex", "pulse");
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([
            { number: 5, body: marker, html_url: "https://github.com/o/r/issues/5" },
          ]),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: "{}", stderr: "" };
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = adapter.appendGapCommentOnPulse(samplePayload(), "blocked hook");
    expect(result.outcome).toBe("submitted");
    expect(result.message).toContain("gap comment appended");
  });

  it("soft-skips gap comment on GhRestError", () => {
    const marker = buildThreadMarker("install-abc", "Alex", "pulse");
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([{ number: 5, body: marker }]),
          stderr: "",
        };
      }
      throw new GhRestError({
        stderr: "500",
        exitCode: 500,
        endpoint: "comment",
        payload: null,
      });
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = adapter.appendGapCommentOnPulse(samplePayload(), "x");
    expect(result.outcome).toBe("sink-unreachable");
  });

  it("returns unreachable when pulse issue lacks number", () => {
    const marker = buildThreadMarker("install-abc", "Alex", "pulse");
    const runGhApiFn = vi.fn(() => ({
      returncode: 0,
      stdout: JSON.stringify([{ body: marker, html_url: "https://github.com/o/r/issues/x" }]),
      stderr: "",
    }));
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = adapter.appendGapCommentOnPulse(samplePayload(), "x");
    expect(result.outcome).toBe("sink-unreachable");
    expect(result.message).toContain("missing number");
  });

  it("soft-skips gap comment on generic error", () => {
    const marker = buildThreadMarker("install-abc", "Alex", "pulse");
    const runGhApiFn = vi.fn((args: readonly string[]) => {
      if (args.includes("GET")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([{ number: 5, body: marker }]),
          stderr: "",
        };
      }
      throw new Error("network");
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = adapter.appendGapCommentOnPulse(samplePayload(), "x");
    expect(result.outcome).toBe("sink-unreachable");
  });
});

describe("mergeIssueLabels", () => {
  it("preserves existing labels when adding gap marker", () => {
    const merged = mergeIssueLabels(
      { labels: [{ name: "surface:pulse" }, { name: "nps:promoter" }] },
      ["signal:gap"],
    );
    expect(merged).toEqual(expect.arrayContaining(["surface:pulse", "nps:promoter", "signal:gap"]));
  });

  it("preserves string labels from issue payload", () => {
    expect(mergeIssueLabels({ labels: ["surface:pulse", "signal:gap"] }, ["nps:none"])).toEqual(
      expect.arrayContaining(["surface:pulse", "signal:gap", "nps:none"]),
    );
  });
});

describe("buildThreadMarker", () => {
  it("includes normalized actor key", () => {
    expect(buildThreadMarker("i1", "Alex Lee", "pulse")).toContain("actorKey=alex lee");
  });
});

describe("sink bootstrap", () => {
  it("dry-run bootstrap sink", () => {
    const result = bootstrapProductSignalSink({ dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry-run");
  });

  it("bootstrap labels idempotent on already_exists", () => {
    const runGhApiFn = vi.fn(() => ({
      returncode: 1,
      stdout: "",
      stderr: "already_exists",
    }));
    const result = bootstrapProductSignalLabels("deftai/product-signal", { runGhApiFn });
    expect(result.skipped).toBeGreaterThan(0);
  });
});

describe("GhRestError path", () => {
  it("adapter handles thrown GhRestError", async () => {
    const runGhApiFn = vi.fn(() => {
      throw new GhRestError({
        stderr: "404 Not Found",
        exitCode: 404,
        endpoint: "test",
        payload: null,
      });
    });
    const adapter = new GitHubPrivateSinkAdapter({
      sinkRepo: "deftai/product-signal",
      seams: { runGhApiFn },
    });
    const result = await adapter.submit(samplePayload());
    expect(result.outcome).toBe("sink-unauthorized");
  });
});
