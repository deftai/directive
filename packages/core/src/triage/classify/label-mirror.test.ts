import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LabelClient } from "../../vbrief-reconcile/types.js";
import {
  DEFAULT_IDEMPOTENCY_LABEL,
  defaultLabelMirrorPolicy,
  desiredLabelsForClassification,
  labelMirrorOutcomeToJson,
  mirrorLabels,
  renderLabelMirrorReport,
  resolveLabelMirrorPolicy,
  validateLabelMirrorPolicy,
} from "./index.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) {
    const t = temps.pop();
    if (t !== undefined) {
      rmSync(t, { recursive: true, force: true });
    }
  }
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-label-mirror-"));
  temps.push(root);
  return root;
}

function writeProject(root: string, policy?: Record<string, unknown>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        ...(policy !== undefined ? { "x-directive/policy": policy } : {}),
      },
    }),
    "utf8",
  );
}

function writeCachedIssue(
  root: string,
  repo: string,
  issueNumber: number,
  issue: Record<string, unknown>,
): void {
  const [owner, name] = repo.split("/", 2);
  const dir = join(
    root,
    ".deft-cache",
    "github-issue",
    owner ?? "",
    name ?? "",
    String(issueNumber),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify(issue), "utf8");
}

class FakeLabelClient implements LabelClient {
  labels = new Map<string, string[]>();
  applyCalls: Array<[string, number, string[], string[]]> = [];
  fetchCalls: Array<[string, number]> = [];

  fetchLabels(repo: string, issueNumber: number): string[] {
    this.fetchCalls.push([repo, issueNumber]);
    return [...(this.labels.get(`${repo}:${issueNumber}`) ?? [])];
  }

  apply(
    repo: string,
    issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    this.applyCalls.push([repo, issueNumber, [...add], [...remove]]);
    const key = `${repo}:${issueNumber}`;
    const cur = new Set(this.labels.get(key) ?? []);
    for (const a of add) cur.add(a);
    for (const r of remove) cur.delete(r);
    this.labels.set(key, [...cur].sort());
  }
}

describe("validateLabelMirrorPolicy", () => {
  it("accepts null/undefined", () => {
    expect(validateLabelMirrorPolicy(undefined).errors).toEqual([]);
    expect(validateLabelMirrorPolicy(null).errors).toEqual([]);
  });

  it("rejects non-object", () => {
    expect(validateLabelMirrorPolicy([]).errors.length).toBeGreaterThan(0);
  });

  it("rejects bad actionLabels keys", () => {
    const { errors } = validateLabelMirrorPolicy({
      actionLabels: { nope: ["x"] },
    });
    expect(errors.some((e) => e.includes("nope"))).toBe(true);
  });

  it("accepts valid policy", () => {
    const { errors } = validateLabelMirrorPolicy({
      enabled: true,
      idempotencyLabel: "triaged",
      alwaysLabels: ["triaged"],
      actionLabels: { defer: ["status:deferred"] },
    });
    expect(errors).toEqual([]);
  });
});

describe("desiredLabelsForClassification", () => {
  it("includes idempotency + action labels", () => {
    const policy = resolveLabelMirrorPolicy({
      override: {
        alwaysLabels: ["triaged"],
        actionLabels: { defer: ["status:deferred"], accept: ["enhancement"] },
      },
    });
    expect(desiredLabelsForClassification("defer", policy)).toEqual(["status:deferred", "triaged"]);
    expect(desiredLabelsForClassification("accept", policy)).toEqual(["enhancement", "triaged"]);
  });

  it("defaults to triaged only", () => {
    const policy = defaultLabelMirrorPolicy();
    expect(policy.idempotencyLabel).toBe(DEFAULT_IDEMPOTENCY_LABEL);
    expect(desiredLabelsForClassification("archive", policy)).toEqual(["triaged"]);
  });
});

describe("mirrorLabels", () => {
  it("dry-run plans labels with zero SCM writes", () => {
    const root = tmpRoot();
    writeProject(root);
    // Hold-marker match → defer
    writeCachedIssue(root, "acme/demo", 1, {
      number: 1,
      state: "open",
      body: "BLOCKED do not implement yet",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    const client = new FakeLabelClient();
    const [code, outcome] = mirrorLabels(root, {
      dryRun: true,
      client,
      // force cache labels even if client provided
      useLiveLabels: false,
    });
    expect(code).toBe(0);
    expect(outcome.dry_run).toBe(true);
    expect(client.applyCalls).toHaveLength(0);
    expect(client.fetchCalls).toHaveLength(0);
    expect(outcome.planned).toBe(1);
    expect(outcome.items[0]?.status).toBe("planned");
    expect(outcome.items[0]?.add).toContain("triaged");
    expect(outcome.items[0]?.action).toBe("defer");
  });

  it("skips already-triaged issues (idempotent)", () => {
    const root = tmpRoot();
    writeProject(root);
    writeCachedIssue(root, "acme/demo", 2, {
      number: 2,
      state: "open",
      body: "BLOCKED",
      labels: [{ name: "triaged" }],
      updated_at: "2026-08-01T00:00:00Z",
    });
    const [code, outcome] = mirrorLabels(root, { dryRun: true, useLiveLabels: false });
    expect(code).toBe(0);
    expect(outcome.skipped_already_triaged).toBe(1);
    expect(outcome.planned).toBe(0);
    expect(outcome.items[0]?.status).toBe("skipped_already_triaged");
  });

  it("--apply writes labels via LabelClient; re-run is no-op", () => {
    const root = tmpRoot();
    writeProject(root, {
      triageLabelMirror: {
        actionLabels: { defer: ["status:deferred"] },
      },
    });
    writeCachedIssue(root, "acme/demo", 3, {
      number: 3,
      state: "open",
      body: "HOLDING for later",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    // Seed git remote resolution by writing a fake origin? repo guard needs project repo.
    // Use allowCrossRepo for fixture without git remote.
    const client = new FakeLabelClient();
    const [code1, outcome1] = mirrorLabels(root, {
      dryRun: false,
      client,
      allowCrossRepo: true,
      useLiveLabels: true,
    });
    expect(code1).toBe(0);
    expect(outcome1.applied).toBe(1);
    expect(client.applyCalls).toHaveLength(1);
    expect(client.applyCalls[0]?.[2].sort()).toEqual(["status:deferred", "triaged"]);

    // Re-run: live labels now include triaged → skip
    const [code2, outcome2] = mirrorLabels(root, {
      dryRun: false,
      client,
      allowCrossRepo: true,
      useLiveLabels: true,
    });
    expect(code2).toBe(0);
    expect(outcome2.applied).toBe(0);
    expect(outcome2.skipped_already_triaged).toBe(1);
    expect(client.applyCalls).toHaveLength(1); // no second apply
  });

  it("never mutates on dry-run even when client is provided", () => {
    const root = tmpRoot();
    writeProject(root);
    writeCachedIssue(root, "acme/demo", 4, {
      number: 4,
      state: "closed",
      body: "done",
      labels: [],
      updated_at: "2026-01-01T00:00:00Z",
    });
    const client = new FakeLabelClient();
    mirrorLabels(root, { dryRun: true, client, useLiveLabels: false });
    expect(client.applyCalls).toHaveLength(0);
  });

  it("respects enabled: false", () => {
    const root = tmpRoot();
    writeProject(root, { triageLabelMirror: { enabled: false } });
    writeCachedIssue(root, "acme/demo", 5, {
      number: 5,
      state: "open",
      body: "BLOCKED",
      labels: [],
    });
    const [code, outcome] = mirrorLabels(root, { dryRun: true });
    expect(code).toBe(0);
    expect(outcome.items[0]?.status).toBe("skipped_disabled");
  });

  it("render + json shapes are stable", () => {
    const root = tmpRoot();
    writeProject(root);
    writeCachedIssue(root, "acme/demo", 6, {
      number: 6,
      state: "open",
      body: "BLOCKED",
      labels: [],
    });
    const [, outcome] = mirrorLabels(root, { dryRun: true, useLiveLabels: false });
    const report = renderLabelMirrorReport(outcome);
    expect(report).toContain("dry-run");
    expect(report).toContain("Would add labels:");
    const json = labelMirrorOutcomeToJson(outcome);
    expect(json.dry_run).toBe(true);
    expect(Array.isArray(json.items)).toBe(true);
  });

  it("refuses cross-repo apply without allowCrossRepo", () => {
    const root = tmpRoot();
    writeProject(root);
    writeCachedIssue(root, "other/victim", 99, {
      number: 99,
      state: "open",
      body: "BLOCKED",
      labels: [],
    });
    const client = new FakeLabelClient();
    const [code2, outcome2] = mirrorLabels(root, {
      dryRun: false,
      client,
      allowCrossRepo: false,
      useLiveLabels: true,
    });
    expect(code2).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    expect(outcome2.errors).toBeGreaterThan(0);
    expect(outcome2.items.some((i) => i.status === "error")).toBe(true);
  });

  it("applies repo-qualified xBRIEF refs only to the matching repo (#1423 P1)", () => {
    const root = tmpRoot();
    writeProject(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "S",
          status: "running",
          items: [],
          references: [
            {
              type: "x-xbrief/github-issue",
              uri: "https://github.com/acme/demo/issues/42",
            },
          ],
        },
      }),
      "utf8",
    );
    writeCachedIssue(root, "other/victim", 42, {
      number: 42,
      state: "open",
      body: "unrelated issue with a substantial body that is not dormant",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    writeCachedIssue(root, "acme/demo", 42, {
      number: 42,
      state: "open",
      body: "referenced scope work with enough body text to avoid dormant",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    const [, outcome] = mirrorLabels(root, {
      dryRun: true,
      useLiveLabels: false,
      allowCrossRepo: true,
    });
    const foreign = outcome.items.find((i) => i.repo === "other/victim" && i.issue_number === 42);
    const project = outcome.items.find((i) => i.repo === "acme/demo" && i.issue_number === 42);
    expect(foreign?.ruleKind).not.toBe("universal:vbrief-referenced");
    expect(foreign?.action).not.toBe("accept");
    expect(project?.action).toBe("accept");
    expect(project?.ruleKind).toBe("universal:vbrief-referenced");
  });

  it("does not let --repo filter re-enable foreign xBRIEF refs on multi-repo cache", () => {
    const root = tmpRoot();
    writeProject(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "S",
          status: "running",
          items: [],
          references: [
            {
              type: "x-xbrief/github-issue",
              uri: "https://github.com/acme/demo/issues/55",
            },
          ],
        },
      }),
      "utf8",
    );
    writeCachedIssue(root, "other/victim", 55, {
      number: 55,
      state: "open",
      body: "foreign same number with enough body text",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    writeCachedIssue(root, "acme/demo", 55, {
      number: 55,
      state: "open",
      body: "project same number with enough body text",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    const [, outcome] = mirrorLabels(root, {
      dryRun: true,
      useLiveLabels: false,
      repo: "other/victim",
      allowCrossRepo: true,
    });
    const foreign = outcome.items.find((i) => i.repo === "other/victim" && i.issue_number === 55);
    expect(foreign).toBeDefined();
    expect(foreign?.ruleKind).not.toBe("universal:vbrief-referenced");
    expect(foreign?.action).not.toBe("accept");
  });
});
