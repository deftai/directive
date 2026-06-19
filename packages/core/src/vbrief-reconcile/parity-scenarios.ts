import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pythonJsonPretty } from "../vbrief-build/json.js";
import { graphOutcomeToJson, reconcileGraph, renderGraphReport } from "./graph.js";
import { labelsOutcomeToJson, reconcileLabels, renderLabelsReport } from "./labels.js";
import {
  buildSpecTaskIndex,
  formatReconciliationMarkdown,
  hasDisagreement,
  parseOverridesYaml,
  reconcileScopeItems,
} from "./reconciliation.js";
import type { LabelClient, UmbrellaClient } from "./types.js";
import { parseCurrentShape, reconcileUmbrellas, renderUmbrellasReport } from "./umbrellas.js";

class MemoryLabelClient implements LabelClient {
  fetchLabels(): string[] {
    return [];
  }
  apply(): void {}
}

class MemoryUmbrellaClient implements UmbrellaClient {
  private readonly comments = new Map<string, Array<{ id: number; body: string }>>();
  private nextId = 1000;

  private key(repo: string, issue: number): string {
    return `${repo}:${issue}`;
  }

  fetchComments(repo: string, issueNumber: number): Array<{ id: number; body: string }> {
    return [...(this.comments.get(this.key(repo, issueNumber)) ?? [])];
  }

  editComment(_repo: string, commentId: number, body: string): void {
    for (const bucket of this.comments.values()) {
      for (const comment of bucket) {
        if (comment.id === commentId) comment.body = body;
      }
    }
  }

  createComment(repo: string, issueNumber: number, body: string): number | null {
    const key = this.key(repo, issueNumber);
    const id = this.nextId;
    this.nextId += 1;
    const bucket = this.comments.get(key) ?? [];
    bucket.push({ id, body });
    this.comments.set(key, bucket);
    return id;
  }
}

const SHARED_UMBRELLA_CLIENT = new MemoryUmbrellaClient();

export const PARITY_SCENARIO_NAMES = [
  "reconcile-overrides",
  "reconcile-spec-index",
  "reconcile-scope-clean",
  "reconcile-scope-orphan",
  "reconcile-report",
  "reconcile-parse-shape",
  "graph-dry-run",
  "graph-cycle",
  "graph-missing-proposed",
  "labels-blocked-dry-run",
  "labels-utf8-dry-run",
  "umbrellas-create-dry-run",
  "umbrellas-unchanged",
] as const;

export type ParityScenarioName = (typeof PARITY_SCENARIO_NAMES)[number];

const FIXED_NOW = new Date("2026-06-14T20:00:00Z");
const FIXED_REPORT_NOW = new Date("2026-06-19T12:00:00Z");

const OVERRIDES_SAMPLE =
  "overrides:\n" +
  "  t2.4.1:\n" +
  "    status: completed\n" +
  "    body_source: spec\n" +
  "  roadmap-9:\n" +
  "    drop: true\n";

// Whitespace-edge body for the ReDoS-hardened parse path (#1782 s4): leading
// runs of spaces/tabs, an all-whitespace tail, and a final line without a
// trailing newline -- exactly the inputs the `\s*(\S.*|)$` rewrite must parse
// byte-identically to the Python oracle's `\s*(.*)$`.
const PARSE_SHAPE_BODY =
  "## Current shape (as of pass-4)\n" +
  "Last updated:    2026-06-19T00:00:00Z   \n" +
  "Last pass type:\tverify\t\n" +
  "Child-count history:   pass-1: 2, pass-2: 3,  pass-3: 5\n" +
  "Trailing field with empty value:      \n" +
  "Child-count history: pass-9: 9";

function specWith(items: unknown[]): Record<string, unknown> {
  return {
    vBRIEFInfo: { version: "0.5", description: "spec" },
    plan: { title: "Spec", status: "approved", narratives: {}, items },
  };
}

function writeBrief(
  root: string,
  storyId: string,
  folder: string,
  extra: Record<string, unknown> = {},
): string {
  const path = join(root, "vbrief", folder, `2026-05-21-${storyId}.vbrief.json`);
  mkdirSync(join(root, "vbrief", folder), { recursive: true });
  const statusMap: Record<string, string> = {
    proposed: "proposed",
    pending: "pending",
    active: "running",
    completed: "completed",
    cancelled: "cancelled",
  };
  const data = {
    vBRIEFInfo: { version: "0.6" },
    plan: {
      id: storyId,
      title: storyId,
      status: statusMap[folder] ?? "pending",
      narratives: {
        Description: `${storyId} description.`,
        ImplementationPlan: `1. Do ${storyId}.`,
        UserStory: `As a user, I want ${storyId}.`,
        Traces: "FR-1",
      },
      items: [
        {
          id: `${storyId}-a1`,
          title: "Acceptance item 1",
          status: "pending",
          narrative: { Acceptance: `Given X when ${storyId} then Y.` },
        },
      ],
      metadata: {
        kind: "story",
        swarm: {
          readiness: "ready",
          parallel_safe: true,
          file_scope: [`src/${storyId}.py`],
          verify_commands: [`pytest ${storyId}`],
          expected_outputs: ["tests pass"],
          depends_on: [],
          conflict_group: "reconcile-suite",
          size: "small",
          file_scope_confidence: "high",
          model_tier: "standard",
        },
      },
      references: [],
      ...extra,
    },
  };
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return path;
}

export interface ParityScenarioResult {
  readonly scenario: string;
  readonly ok: boolean;
  readonly payload: unknown;
}

export function renderScenarioOutput(
  payload: ParityScenarioResult | ParityScenarioResult[],
): string {
  return pythonJsonPretty(payload);
}

export function runParityScenario(
  name: string,
  options: { fixtureRoot: string; labelClient?: LabelClient; umbrellaClient?: UmbrellaClient },
): ParityScenarioResult {
  const root = options.fixtureRoot;
  switch (name as ParityScenarioName) {
    case "reconcile-overrides":
      return { scenario: name, ok: true, payload: parseOverridesYaml(OVERRIDES_SAMPLE) };
    case "reconcile-spec-index": {
      const spec = specWith([
        { id: "t1.1", title: "One", status: "pending" },
        {
          id: "phase-1",
          title: "Phase 1: Foundation",
          status: "pending",
          subItems: [{ id: "t1.1.1", title: "Deep task", status: "pending" }],
        },
      ]);
      const index = buildSpecTaskIndex(spec);
      return {
        scenario: name,
        ok: true,
        payload: {
          keys: Object.keys(index).sort(),
          deepPhase: index["t1.1.1"]?.specPhase ?? "",
        },
      };
    }
    case "reconcile-scope-clean": {
      const spec = specWith([{ id: "t1", title: "Task one", status: "pending" }]);
      const [items, report] = reconcileScopeItems({
        roadmapActive: [{ number: "", task_id: "t1", title: "Task one", phase: "Phase 1" }],
        roadmapCompleted: [],
        specVbrief: spec,
      });
      return {
        scenario: name,
        ok: true,
        payload: { items, hasDisagreement: hasDisagreement(report) },
      };
    }
    case "reconcile-scope-orphan": {
      const spec = specWith([{ id: "t1", title: "One", status: "pending" }]);
      const [items, report] = reconcileScopeItems({
        roadmapActive: [
          { number: "9", title: "Orphan task", phase: "Phase 1", synthetic_id: "roadmap-9" },
        ],
        roadmapCompleted: [],
        specVbrief: spec,
      });
      return {
        scenario: name,
        ok: true,
        payload: { items, orphans: report.orphans },
      };
    }
    case "reconcile-report": {
      const spec = specWith([{ id: "t2.4.1", title: "Repo indexer", status: "pending" }]);
      const [, report] = reconcileScopeItems({
        roadmapActive: [],
        roadmapCompleted: [
          { number: "", task_id: "t2.4.1", title: "Repo indexer", phase: "Completed" },
        ],
        specVbrief: spec,
      });
      return {
        scenario: name,
        ok: true,
        payload: formatReconciliationMarkdown(report, FIXED_REPORT_NOW),
      };
    }
    case "reconcile-parse-shape": {
      const parsed = parseCurrentShape(PARSE_SHAPE_BODY);
      return {
        scenario: name,
        ok: true,
        payload: {
          passN: parsed.passN,
          history: parsed.history,
          lastUpdated: parsed.lastUpdated,
          lastPassType: parsed.lastPassType,
        },
      };
    }
    case "graph-dry-run": {
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      writeBrief(root, "dep-done", "completed");
      writeBrief(root, "child", "proposed", {
        metadata: {
          kind: "story",
          swarm: {
            readiness: "ready",
            parallel_safe: true,
            file_scope: ["src/child.py"],
            verify_commands: ["pytest child"],
            expected_outputs: ["tests pass"],
            depends_on: ["dep-done"],
            conflict_group: "reconcile-suite",
            size: "small",
            file_scope_confidence: "high",
            model_tier: "standard",
          },
        },
      });
      const [code, outcome] = reconcileGraph(root, { dryRun: true });
      return {
        scenario: name,
        ok: true,
        payload: {
          exitCode: code,
          report: renderGraphReport(outcome),
          json: graphOutcomeToJson(outcome),
        },
      };
    }
    case "graph-cycle": {
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      for (const id of ["a", "b"]) {
        writeBrief(root, id, "proposed", {
          metadata: {
            kind: "story",
            swarm: {
              readiness: "ready",
              parallel_safe: true,
              file_scope: [`src/${id}.py`],
              verify_commands: [`pytest ${id}`],
              expected_outputs: ["tests pass"],
              depends_on: [id === "a" ? "b" : "a"],
              conflict_group: "reconcile-suite",
              size: "small",
              file_scope_confidence: "high",
              model_tier: "standard",
            },
          },
        });
      }
      const [code, outcome] = reconcileGraph(root, { dryRun: true });
      return {
        scenario: name,
        ok: true,
        payload: { exitCode: code, report: renderGraphReport(outcome) },
      };
    }
    case "graph-missing-proposed": {
      mkdirSync(join(root, "vbrief"), { recursive: true });
      const [code] = reconcileGraph(root, { dryRun: true });
      return { scenario: name, ok: true, payload: { exitCode: code } };
    }
    case "labels-blocked-dry-run": {
      mkdirSync(join(root, "vbrief", "active"), { recursive: true });
      writeBrief(root, "blk", "active", {
        status: "blocked",
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/10",
            type: "x-vbrief/github-issue",
            title: "Issue #10",
          },
        ],
      });
      const client = options.labelClient ?? new MemoryLabelClient();
      const [code, outcome] = reconcileLabels(root, { client, dryRun: true });
      return {
        scenario: name,
        ok: true,
        payload: {
          exitCode: code,
          report: renderLabelsReport(outcome),
          json: labelsOutcomeToJson(outcome),
        },
      };
    }
    case "labels-utf8-dry-run": {
      mkdirSync(join(root, "vbrief", "active"), { recursive: true });
      writeBrief(root, "utf8", "active", {
        references: [
          {
            uri: "https://github.com/deftai/directive/issues/11",
            type: "x-vbrief/github-issue",
            title: "Issue #11 — smart “quotes”",
          },
        ],
      });
      const client = options.labelClient ?? new MemoryLabelClient();
      const [code, outcome] = reconcileLabels(root, { client, dryRun: true });
      return {
        scenario: name,
        ok: true,
        payload: { exitCode: code, report: renderLabelsReport(outcome) },
      };
    }
    case "umbrellas-create-dry-run": {
      mkdirSync(join(root, "vbrief", "active"), { recursive: true });
      writeBrief(root, "child-a", "active", {
        metadata: { kind: "story", swarm: { depends_on: [] } },
      });
      writeBrief(root, "epic-1", "active", {
        metadata: { kind: "epic", swarm: { depends_on: [] } },
        references: [
          { uri: "active/2026-05-21-child-a.vbrief.json", type: "x-vbrief/plan", title: "child-a" },
          {
            uri: "https://github.com/deftai/directive/issues/1284",
            type: "x-vbrief/github-issue",
            title: "Issue #1284",
          },
        ],
      });
      const client = options.umbrellaClient ?? SHARED_UMBRELLA_CLIENT;
      const [code, outcome] = reconcileUmbrellas(root, {
        client,
        dryRun: true,
        now: FIXED_NOW.toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
      return {
        scenario: name,
        ok: true,
        payload: { exitCode: code, report: renderUmbrellasReport(outcome) },
      };
    }
    case "umbrellas-unchanged": {
      mkdirSync(join(root, "vbrief", "active"), { recursive: true });
      writeBrief(root, "child-b", "active", {
        metadata: { kind: "story", swarm: { depends_on: [] } },
      });
      writeBrief(root, "epic-2", "active", {
        metadata: { kind: "epic", swarm: { depends_on: [] } },
        references: [
          { uri: "active/2026-05-21-child-b.vbrief.json", type: "x-vbrief/plan", title: "child-b" },
          {
            uri: "https://github.com/deftai/directive/issues/1285",
            type: "x-vbrief/github-issue",
            title: "Issue #1285",
          },
        ],
      });
      const client = options.umbrellaClient ?? SHARED_UMBRELLA_CLIENT;
      const now = FIXED_NOW.toISOString().replace(/\.\d{3}Z$/, "Z");
      reconcileUmbrellas(root, { client, dryRun: false, now });
      const [code, outcome] = reconcileUmbrellas(root, { client, dryRun: true, now });
      return {
        scenario: name,
        ok: true,
        payload: { exitCode: code, report: renderUmbrellasReport(outcome) },
      };
    }
    default:
      throw new Error(`unknown scenario: ${name}`);
  }
}

export function loadFixtureBrief(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
