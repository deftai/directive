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
    expect(outcome.filters.include_closed).toBe(false);
    expect(outcome.digest.by_action.defer).toBe(1);
  });

  it("open-only default skips closed; --includeClosed plans closed archive", () => {
    const root = tmpRoot();
    writeProject(root);
    writeCachedIssue(root, "acme/demo", 10, {
      number: 10,
      state: "open",
      body: "BLOCKED open hold",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    writeCachedIssue(root, "acme/demo", 11, {
      number: 11,
      state: "closed",
      body: "closed never triaged body long enough",
      labels: [],
      updated_at: "2026-01-01T00:00:00Z",
    });
    const [, openOnly] = mirrorLabels(root, { dryRun: true, useLiveLabels: false });
    expect(openOnly.planned).toBe(1);
    expect(openOnly.skipped_closed).toBe(1);
    expect(openOnly.items.find((i) => i.issue_number === 11)?.status).toBe("skipped_closed");
    expect(openOnly.digest.by_state.open).toBe(1);
    expect(openOnly.digest.by_state.closed).toBeUndefined();

    const [, withClosed] = mirrorLabels(root, {
      dryRun: true,
      useLiveLabels: false,
      includeClosed: true,
    });
    expect(withClosed.skipped_closed).toBe(0);
    expect(withClosed.planned).toBeGreaterThanOrEqual(2);
    expect(withClosed.filters.include_closed).toBe(true);
    const closedItem = withClosed.items.find((i) => i.issue_number === 11);
    expect(closedItem?.status).toBe("planned");
    expect(closedItem?.action).toBe("archive");
  });

  it("author filter AND open-only plans only matching open authors (#3129)", () => {
    const root = tmpRoot();
    writeProject(root);
    writeCachedIssue(root, "acme/demo", 30, {
      number: 30,
      state: "open",
      body: "BLOCKED alice open",
      labels: [],
      author: { login: "alice" },
      updated_at: "2026-08-01T00:00:00Z",
    });
    writeCachedIssue(root, "acme/demo", 31, {
      number: 31,
      state: "open",
      body: "BLOCKED bob open",
      labels: [],
      author: { login: "bob" },
      updated_at: "2026-08-01T00:00:00Z",
    });
    writeCachedIssue(root, "acme/demo", 32, {
      number: 32,
      state: "closed",
      body: "alice closed archive body long enough",
      labels: [],
      author: { login: "alice" },
      updated_at: "2026-01-01T00:00:00Z",
    });
    writeCachedIssue(root, "acme/demo", 33, {
      number: 33,
      state: "open",
      body: "BLOCKED missing author",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    const authorFilter = {
      raw: "alice",
      allowLogins: ["alice"],
      usedMe: false,
      display: "alice",
    };
    const [, outcome] = mirrorLabels(root, {
      dryRun: true,
      useLiveLabels: false,
      authorFilter,
    });
    expect(outcome.filters.author).toBe("alice");
    expect(outcome.planned).toBe(1);
    expect(outcome.items.find((i) => i.issue_number === 30)?.status).toBe("planned");
    expect(outcome.items.find((i) => i.issue_number === 31)?.status).toBe("skipped_author");
    expect(outcome.items.find((i) => i.issue_number === 32)?.status).toBe("skipped_closed");
    expect(outcome.items.find((i) => i.issue_number === 33)?.status).toBe("skipped_author");
    expect(outcome.skipped_author).toBeGreaterThanOrEqual(2);
    expect(outcome.skipped_closed).toBe(1);
    const report = renderLabelMirrorReport(outcome);
    expect(report).toContain("author=alice");
    expect(report).toContain("author_skipped=");
  });

  it("digest samples truncate and json includes aggregates", () => {
    const root = tmpRoot();
    writeProject(root);
    for (let n = 1; n <= 5; n += 1) {
      writeCachedIssue(root, "acme/demo", n, {
        number: n,
        state: "open",
        body: "BLOCKED item",
        labels: [],
        updated_at: "2026-08-01T00:00:00Z",
      });
    }
    const [, outcome] = mirrorLabels(root, {
      dryRun: true,
      useLiveLabels: false,
      sampleLimit: 2,
    });
    expect(outcome.planned).toBe(5);
    expect(outcome.digest.samples).toHaveLength(2);
    expect(outcome.digest.sample_truncated).toBe(true);
    expect(outcome.digest.by_rule["universal:hold-marker"]).toBe(5);
    const report = renderLabelMirrorReport(outcome);
    expect(report).toContain("By state");
    expect(report).toContain("By rule");
    expect(report).toContain("By action");
    expect(report).toContain("and 3 more");
    const json = labelMirrorOutcomeToJson(outcome);
    expect((json.digest as { by_action: Record<string, number> }).by_action.defer).toBe(5);
    expect((json.filters as { include_closed: boolean }).include_closed).toBe(false);
  });

  it("apply batches with rate-limit delay and continues after partial failure", () => {
    const root = tmpRoot();
    writeProject(root);
    for (const n of [20, 21, 22]) {
      writeCachedIssue(root, "acme/demo", n, {
        number: n,
        state: "open",
        body: "BLOCKED batch",
        labels: [],
        updated_at: "2026-08-01T00:00:00Z",
      });
    }
    const sleeps: number[] = [];
    const client = new FakeLabelClient();
    let calls = 0;
    const origApply = client.apply.bind(client);
    client.apply = (repo, issueNumber, add, remove) => {
      calls += 1;
      if (issueNumber === 21) {
        throw new Error('could not add label "triaged" not found');
      }
      origApply(repo, issueNumber, add, remove);
    };
    const [code, outcome] = mirrorLabels(root, {
      dryRun: false,
      client,
      allowCrossRepo: true,
      useLiveLabels: true,
      batchSize: 1,
      delayMs: 5,
      sleepMs: (ms) => {
        sleeps.push(ms);
      },
    });
    expect(code).toBe(1);
    expect(outcome.applied).toBe(2);
    expect(outcome.errors).toBe(1);
    expect(calls).toBe(3);
    // Failed attempts still count toward batchSize, so sleeps fire before 2nd and 3rd attempts.
    expect(sleeps).toEqual([5, 5]);
    const errItem = outcome.items.find((i) => i.issue_number === 21);
    expect(errItem?.status).toBe("error");
    expect(errItem?.message).toMatch(/ensure label/i);
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
    expect(outcome.re_enrich_planned).toBe(0);
    expect(outcome.filters.re_enrich).toBe(false);
    expect(outcome.items[0]?.status).toBe("skipped_already_triaged");
  });

  it("--re-enrich plans additive labels on already-triaged issues (#3197)", () => {
    const root = tmpRoot();
    writeProject(root, {
      triageLabelMirror: {
        actionLabels: { defer: ["status:deferred", "triage:deferred"] },
      },
    });
    // Already stamped with triaged only — missing action chips after policy change.
    writeCachedIssue(root, "acme/demo", 30, {
      number: 30,
      state: "open",
      body: "HOLDING for later — blocked on partner",
      labels: [{ name: "triaged" }],
      updated_at: "2026-08-01T00:00:00Z",
    });
    // First-time issue (no stamp) should still plan as first-time under re-enrich.
    writeCachedIssue(root, "acme/demo", 31, {
      number: 31,
      state: "open",
      body: "HOLDING for later — new candidate",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });

    // Default path still skips the stamped issue.
    const [, skipOutcome] = mirrorLabels(root, { dryRun: true, useLiveLabels: false });
    expect(skipOutcome.skipped_already_triaged).toBe(1);
    expect(skipOutcome.planned).toBe(1);
    expect(skipOutcome.re_enrich_planned).toBe(0);

    const [code, outcome] = mirrorLabels(root, {
      dryRun: true,
      useLiveLabels: false,
      reEnrich: true,
    });
    expect(code).toBe(0);
    expect(outcome.filters.re_enrich).toBe(true);
    expect(outcome.skipped_already_triaged).toBe(0);
    expect(outcome.planned).toBe(2);
    expect(outcome.re_enrich_planned).toBe(1);

    const reRow = outcome.items.find((i) => i.issue_number === 30);
    expect(reRow?.status).toBe("planned");
    expect(reRow?.re_enrich).toBe(true);
    expect(reRow?.add).toEqual(expect.arrayContaining(["status:deferred", "triage:deferred"]));
    expect(reRow?.add).not.toContain("triaged"); // already present; additive-only

    const firstRow = outcome.items.find((i) => i.issue_number === 31);
    expect(firstRow?.status).toBe("planned");
    expect(firstRow?.re_enrich).toBeUndefined();
    expect(firstRow?.add).toEqual(
      expect.arrayContaining(["triaged", "status:deferred", "triage:deferred"]),
    );

    const report = renderLabelMirrorReport(outcome);
    expect(report).toContain("re_enrich=on");
    expect(report).toContain("planned_kind:");
    expect(report).toContain("re_enrich=1");
    expect(report).toContain("kind=re-enrich");
    expect(report).toContain("kind=first-time");

    const json = labelMirrorOutcomeToJson(outcome);
    expect(json.re_enrich_planned).toBe(1);
    expect((json.filters as { re_enrich: boolean }).re_enrich).toBe(true);
  });

  it("--re-enrich apply writes additive labels only; never removals (#3197)", () => {
    const root = tmpRoot();
    writeProject(root, {
      triageLabelMirror: {
        actionLabels: { defer: ["status:deferred"] },
      },
    });
    writeCachedIssue(root, "acme/demo", 32, {
      number: 32,
      state: "open",
      body: "HOLDING for later",
      labels: [{ name: "triaged" }, { name: "legacy-chip" }],
      updated_at: "2026-08-01T00:00:00Z",
    });
    const client = new FakeLabelClient();
    client.labels.set("acme/demo:32", ["legacy-chip", "triaged"]);
    const [code, outcome] = mirrorLabels(root, {
      dryRun: false,
      client,
      allowCrossRepo: true,
      useLiveLabels: true,
      reEnrich: true,
      delayMs: 0,
    });
    expect(code).toBe(0);
    expect(outcome.re_enrich_applied).toBe(1);
    expect(client.applyCalls).toHaveLength(1);
    const [, , add, remove] = client.applyCalls[0] ?? ["", 0, [], []];
    expect(add).toEqual(["status:deferred"]);
    expect(remove).toEqual([]); // additive-only v1
    // legacy-chip must remain (not stripped)
    expect(client.labels.get("acme/demo:32")?.sort()).toEqual(
      ["legacy-chip", "status:deferred", "triaged"].sort(),
    );
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
      delayMs: 0,
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
      delayMs: 0,
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
    expect(report).toContain("bootstrap mass-triage");
    expect(report).toContain("Samples");
    expect(report).toContain("open-only");
    const json = labelMirrorOutcomeToJson(outcome);
    expect(json.dry_run).toBe(true);
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.skipped_closed).toBe(0);
    expect(json.re_enrich_planned).toBe(0);
    expect(json.re_enrich_applied).toBe(0);
    expect((json.filters as { re_enrich: boolean }).re_enrich).toBe(false);
    expect(report).toContain("re_enrich=off");
    expect(report).toContain("kind=first-time");
  });

  it("dry-run digest cues empty actionLabels and no_match domination (#3124)", () => {
    const root = tmpRoot();
    writeProject(root); // default policy: empty actionLabels
    // One hold-marker match (planned) + several no_match open issues.
    writeCachedIssue(root, "acme/demo", 70, {
      number: 70,
      state: "open",
      body: "BLOCKED planned",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    for (let n = 71; n <= 75; n += 1) {
      writeCachedIssue(root, "acme/demo", n, {
        number: n,
        state: "open",
        body: "ordinary open issue with no classify signal",
        labels: [{ name: "enhancement" }],
        updated_at: "2026-08-01T00:00:00Z",
      });
    }
    const [, outcome] = mirrorLabels(root, { dryRun: true, useLiveLabels: false });
    expect(outcome.planned).toBeGreaterThanOrEqual(1);
    expect(outcome.skipped_no_match).toBeGreaterThanOrEqual(1);
    const report = renderLabelMirrorReport(outcome);
    expect(report).toContain("Hint (#3124)");
    expect(report).toMatch(/actionLabels|alwaysLabels \(triaged\)/i);
  });

  it("digest omits empty-actionLabels cue when actionLabels configured (#3124)", () => {
    const root = tmpRoot();
    writeProject(root, {
      triageLabelMirror: {
        actionLabels: {
          defer: ["triage:deferred"],
          archive: ["triage:archived"],
          accept: ["triage:lifecycle-linked"],
          escalate: ["triage:needs-human"],
        },
      },
    });
    writeCachedIssue(root, "acme/demo", 80, {
      number: 80,
      state: "open",
      body: "BLOCKED planned with chips",
      labels: [],
      updated_at: "2026-08-01T00:00:00Z",
    });
    const [, outcome] = mirrorLabels(root, { dryRun: true, useLiveLabels: false });
    expect(outcome.planned).toBe(1);
    const report = renderLabelMirrorReport(outcome);
    expect(report).not.toContain("alwaysLabels (triaged) will be added");
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
      delayMs: 0,
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
