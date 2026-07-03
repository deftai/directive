import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stampCompletionMetadata } from "./capacity-stamp.js";
import { formatVbriefJson } from "./vbrief-json.js";

const CONFIG = {
  plan: {
    policy: {
      capacityAllocation: {
        unit: "vbrief-count",
        window: 30,
        defaultBucket: "new-capability",
        buckets: [
          {
            id: "new-capability",
            target: 0.5,
            match: { labels: { "any-of": ["enhancement", "beta", "skills"] } },
          },
          {
            id: "technical-debt",
            target: 0.5,
            match: { labels: { "any-of": ["refactor", "test-debt", "bug"] } },
          },
        ],
      },
    },
  },
};

function writeConfig(root: string, config: unknown = CONFIG): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    formatVbriefJson(config as Record<string, unknown>),
    "utf8",
  );
}

const TS = "2026-07-03T00:00:00Z";

describe("stampCompletionMetadata label-aware bucket resolution (#2237)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("stamps the label-matched bucket, not the default (bug -> technical-debt)", () => {
    root = mkdtempSync(join(tmpdir(), "cap-match-"));
    writeConfig(root);
    const plan: Record<string, unknown> = { status: "running" };
    stampCompletionMetadata(plan, root, TS, { labels: ["bug"] });
    const meta = plan.metadata as Record<string, unknown>;
    expect(meta.completedAt).toBe(TS);
    expect(meta.capacityBucket).toBe("technical-debt");
  });

  it("falls back to defaultBucket when no label matches a bucket", () => {
    root = mkdtempSync(join(tmpdir(), "cap-nomatch-"));
    writeConfig(root);
    const plan: Record<string, unknown> = { status: "running" };
    stampCompletionMetadata(plan, root, TS, { labels: ["docs", "unrelated"] });
    expect((plan.metadata as Record<string, unknown>).capacityBucket).toBe("new-capability");
  });

  it("falls back to defaultBucket when the brief has no resolvable labels", () => {
    root = mkdtempSync(join(tmpdir(), "cap-nolabels-"));
    writeConfig(root);
    const plan: Record<string, unknown> = { status: "running" };
    stampCompletionMetadata(plan, root, TS);
    expect((plan.metadata as Record<string, unknown>).capacityBucket).toBe("new-capability");
  });

  it("never overwrites an explicit pre-existing capacityBucket", () => {
    root = mkdtempSync(join(tmpdir(), "cap-preexisting-"));
    writeConfig(root);
    const plan: Record<string, unknown> = {
      status: "running",
      metadata: { capacityBucket: "cognitive-debt" },
    };
    // Even a label that would match technical-debt must not override the explicit bucket.
    stampCompletionMetadata(plan, root, TS, { labels: ["bug"] });
    const meta = plan.metadata as Record<string, unknown>;
    expect(meta.capacityBucket).toBe("cognitive-debt");
    expect(meta.completedAt).toBe(TS);
  });

  it("first-declared bucket wins when labels match more than one bucket", () => {
    root = mkdtempSync(join(tmpdir(), "cap-order-"));
    writeConfig(root, {
      plan: {
        policy: {
          capacityAllocation: {
            unit: "vbrief-count",
            window: 30,
            defaultBucket: "second",
            buckets: [
              {
                id: "first",
                target: 0.5,
                match: { labels: { "any-of": ["shared"] } },
              },
              {
                id: "second",
                target: 0.5,
                match: { labels: { "any-of": ["shared"] } },
              },
            ],
          },
        },
      },
    });
    const plan: Record<string, unknown> = { status: "running" };
    stampCompletionMetadata(plan, root, TS, { labels: ["shared"] });
    expect((plan.metadata as Record<string, unknown>).capacityBucket).toBe("first");
  });

  it("resolves labels from the brief's linked issue via the cache (no network)", () => {
    root = mkdtempSync(join(tmpdir(), "cap-cache-"));
    writeConfig(root);
    const cacheDir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "42");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "raw.json"),
      JSON.stringify({ labels: [{ name: "bug" }] }),
      "utf8",
    );
    const plan: Record<string, unknown> = {
      status: "running",
      references: [
        {
          type: "x-xbrief/github-issue",
          uri: "https://github.com/deftai/directive/issues/42",
        },
      ],
    };
    stampCompletionMetadata(plan, root, TS);
    expect((plan.metadata as Record<string, unknown>).capacityBucket).toBe("technical-debt");
  });

  it("uses an injected label reader when provided", () => {
    root = mkdtempSync(join(tmpdir(), "cap-reader-"));
    writeConfig(root);
    const plan: Record<string, unknown> = {
      status: "running",
      references: [
        {
          type: "x-xbrief/github-issue",
          uri: "https://github.com/deftai/directive/issues/7",
        },
      ],
    };
    let seenRepo = "";
    let seenIssue = 0;
    stampCompletionMetadata(plan, root, TS, {
      labelReader: (repo, issue) => {
        seenRepo = repo;
        seenIssue = issue;
        return new Set(["refactor"]);
      },
    });
    expect(seenRepo).toBe("deftai/directive");
    expect(seenIssue).toBe(7);
    expect((plan.metadata as Record<string, unknown>).capacityBucket).toBe("technical-debt");
  });
});
