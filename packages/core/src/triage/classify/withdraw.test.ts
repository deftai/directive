import { describe, expect, it } from "vitest";
import type { LabelClient } from "../../vbrief-reconcile/types.js";
import {
  applyWithdrawnChipStrip,
  CLASSIFY_MIRROR_WITHDRAWN_ISSUE,
  CLASSIFY_MIRROR_WITHDRAWN_MESSAGE,
  type ClassifyIssueFn,
  remainingSetAfterWithdrawnChipStrip,
  shadowedVsFaithfulEntry,
  stripWithdrawnChips,
  unionWithdrawnChipIssues,
  WITHDRAWN_TRIAGE_CHIPS,
  type WithdrawnChipIssue,
  withdrawnChipStripDelta,
} from "./withdraw.js";

class FakeLabelClient implements LabelClient {
  labels = new Map<string, string[]>();
  applyCalls: Array<[string, number, string[], string[]]> = [];

  fetchLabels(repo: string, issueNumber: number): string[] {
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

describe("withdrawn chip remaining-set (#4070)", () => {
  it("drops triaged and triage:* and keeps design-critique catalog chips", () => {
    const remaining = remainingSetAfterWithdrawnChipStrip([
      "bug",
      "triaged",
      "triage:deferred",
      "design-critique:triage-ready",
      "triage:needs-human",
      "process",
    ]);
    expect(remaining).toEqual(["bug", "design-critique:triage-ready", "process"]);
  });

  it("remove delta is the withdrawn chips present, never adds", () => {
    expect(withdrawnChipStripDelta(["triaged", "triage:archived", "agent-experience"])).toEqual({
      add: [],
      remove: ["triaged", "triage:archived"],
    });
  });

  it("apply is a no-op when no withdrawn chips are present", () => {
    const client = new FakeLabelClient();
    client.labels.set("o/r:12", ["bug", "design-critique:mechanism-shaped"]);
    const result = applyWithdrawnChipStrip(client, "o/r", 12);
    expect(client.applyCalls).toEqual([]);
    expect(result.remove).toEqual([]);
    expect(result.remaining).toEqual(["bug", "design-critique:mechanism-shaped"]);
  });

  it("apply remaining-set removes withdrawn chips in one write", () => {
    const client = new FakeLabelClient();
    const result = applyWithdrawnChipStrip(client, "o/r", 9, [
      "triaged",
      "triage:deferred",
      "design-critique:triage-ready",
    ]);
    expect(client.applyCalls).toEqual([["o/r", 9, [], ["triaged", "triage:deferred"]]]);
    expect(result.remaining).toEqual(["design-critique:triage-ready"]);
  });
});

describe("shadowed vs faithful digest", () => {
  it("marks hold-marker defer that shadows a later escalate as shadowed", () => {
    const classify: ClassifyIssueFn = (_issue, options) => {
      const rules = options?.rules ?? [];
      const kinds = rules.map((r) =>
        typeof r === "object" && r !== null ? (r as { rule?: string }).rule : undefined,
      );
      if (kinds.includes("universal:hold-marker")) {
        return {
          action: "defer",
          reason: "hold marker in body",
          ruleIndex: 0,
          ruleSource: "framework",
          ruleKind: "universal:hold-marker",
          resumeOn: null,
        };
      }
      return {
        action: "escalate",
        reason: "consumer escalate",
        ruleIndex: 0,
        ruleSource: "consumer",
        ruleKind: "consumer:escalate",
        resumeOn: null,
      };
    };
    const entry = shadowedVsFaithfulEntry(
      { number: 1, body: "BLOCKED", labels: ["triaged"] },
      classify,
      [{ rule: "universal:hold-marker" }, { rule: "consumer:escalate" }],
      ["BLOCKED"],
    );
    expect(entry.shadowed).toBe(true);
    expect(entry.matched?.ruleKind).toBe("universal:hold-marker");
    expect(entry.without_hold_marker?.ruleKind).toBe("consumer:escalate");
  });

  it("is not shadowed when hold-marker is the only match", () => {
    const classify: ClassifyIssueFn = () => ({
      action: "defer",
      reason: "hold marker in body",
      ruleIndex: 0,
      ruleSource: "framework",
      ruleKind: "universal:hold-marker",
      resumeOn: null,
    });
    const entry = shadowedVsFaithfulEntry(
      { number: 2, body: "BLOCKED" },
      classify,
      [{ rule: "universal:hold-marker" }],
      ["BLOCKED"],
    );
    expect(entry.shadowed).toBe(false);
  });
});

describe("stripWithdrawnChips", () => {
  it("unions per-chip lists and dry-run plans remaining-set removes", () => {
    const listed: Record<string, WithdrawnChipIssue[]> = {
      triaged: [
        { number: 10, labels: ["triaged", "triage:deferred", "bug"] },
        { number: 11, labels: ["triaged"] },
      ],
      "triage:deferred": [{ number: 10, labels: ["triage:deferred"] }],
      "triage:needs-human": [{ number: 12, labels: ["triage:needs-human", "process"] }],
    };
    const [code, outcome] = stripWithdrawnChips({
      repo: "deftai/directive",
      dryRun: true,
      emitDigest: true,
      listIssues: (_repo, label) => listed[label] ?? [],
    });
    expect(code).toBe(0);
    expect(outcome.scanned).toBe(3);
    expect(outcome.planned).toBe(3);
    expect(outcome.applied).toBe(0);
    const ten = outcome.items.find((i) => i.issue_number === 10);
    expect(ten?.remove).toEqual(["triaged", "triage:deferred"]);
    expect(ten?.remaining).toEqual(["bug"]);
    expect(outcome.digest).toEqual([]);
  });

  it("apply writes remaining-set via LabelClient and skips unchanged", () => {
    const client = new FakeLabelClient();
    client.labels.set("o/r:1", ["triaged", "design-critique:triage-ready"]);
    const [code, outcome] = stripWithdrawnChips({
      repo: "o/r",
      dryRun: false,
      client,
      listIssues: (_repo, label) => {
        if (label === "triaged") {
          return [
            { number: 1, labels: ["triaged", "design-critique:triage-ready"] },
            { number: 2, labels: ["bug"] },
          ];
        }
        return [];
      },
    });
    expect(code).toBe(0);
    expect(outcome.applied).toBe(1);
    expect(outcome.unchanged).toBe(1);
    expect(client.applyCalls).toEqual([["o/r", 1, [], ["triaged"]]]);
    expect(client.labels.get("o/r:1")).toEqual(["design-critique:triage-ready"]);
  });
});

describe("unionWithdrawnChipIssues", () => {
  it("merges labels for the same issue number", () => {
    const union = unionWithdrawnChipIssues([
      [{ number: 5, labels: ["triaged"] }],
      [
        { number: 5, labels: ["triage:deferred"] },
        { number: 6, labels: ["triage:needs-human"] },
      ],
    ]);
    expect(union.map((i) => i.number)).toEqual([5, 6]);
    expect(union[0]?.labels).toEqual(["triaged", "triage:deferred"]);
  });
});

describe("withdrawn pointer", () => {
  it("names #4070, dry-run and apply, replacement, and transitive #3579", () => {
    expect(CLASSIFY_MIRROR_WITHDRAWN_ISSUE).toBe(4070);
    expect(CLASSIFY_MIRROR_WITHDRAWN_MESSAGE).toContain("#4070");
    expect(CLASSIFY_MIRROR_WITHDRAWN_MESSAGE).toContain("Dry-run");
    expect(CLASSIFY_MIRROR_WITHDRAWN_MESSAGE).toContain("--apply");
    expect(CLASSIFY_MIRROR_WITHDRAWN_MESSAGE).toContain("#4071");
    expect(CLASSIFY_MIRROR_WITHDRAWN_MESSAGE).toContain("#3579");
    expect(WITHDRAWN_TRIAGE_CHIPS).toContain("triaged");
    expect(WITHDRAWN_TRIAGE_CHIPS).toContain("triage:lifecycle-linked");
  });
});
