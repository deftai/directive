import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionListMain, parseDecisionListArgs, runDecisionList } from "./list.js";
import { DECISION_SCHEMA_VERSION } from "./schema.js";

const roots: string[] = [];

function makeProjectWithDecisions(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-decision-list-"));
  roots.push(root);
  mkdirSync(join(root, "xbrief", "decisions"), { recursive: true });

  const write = (name: string, body: Record<string, unknown>) => {
    writeFileSync(
      join(root, "xbrief", "decisions", name),
      JSON.stringify({ schemaVersion: DECISION_SCHEMA_VERSION, ...body }, null, 2),
      "utf8",
    );
  };

  write("2026-08-08-scm-label-mirror-first-mass-apply.decision.json", {
    id: "scm-label-mirror-first-mass-apply",
    decision: "First mass-apply SCM label-mirror with visionik-first then full open",
    governingRule: { description: "Dogfood classify mirror before productization" },
    alternativesConsidered: [{ option: "skip apply", whyNot: "no dogfood evidence" }],
    whyWinner: "Real stamp data unblocks re-enrich design",
    confidence: "high",
    activeScopeRefs: [],
    timestamp: "2026-08-08T18:00:00Z",
    revisitTrigger: "Fix hold markers then re-enrich; do not reverse policy without data",
    tags: ["scm", "mirror"],
    relatedIssues: [1423],
  });

  write("2026-08-09-portfolio-dispose-seed.decision.json", {
    id: "portfolio-dispose-seed",
    decision: "Portfolio briefs dispose into decision log not chat",
    governingRule: { description: "Propose-not-apply; operator disposes" },
    alternativesConsidered: [{ option: "chat-only", whyNot: "re-litigates next session" }],
    whyWinner: "Durable park/promote memory",
    confidence: "medium",
    activeScopeRefs: ["xbrief/active/portfolio.xbrief.json"],
    timestamp: "2026-08-09T10:00:00Z",
    revisitTrigger: "If decision:write is unused after two portfolio passes, revisit UX",
    tags: ["portfolio"],
    relatedIssues: [3198, 3201],
  });

  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

describe("parseDecisionListArgs", () => {
  it("parses filters", () => {
    const args = parseDecisionListArgs([
      "--query",
      "mirror",
      "--issue",
      "1423",
      "--limit",
      "5",
      "--json",
    ]);
    expect(args.query).toBe("mirror");
    expect(args.issue).toBe(1423);
    expect(args.limit).toBe(5);
    expect(args.json).toBe(true);
  });

  it("fails closed on malformed issue/limit", () => {
    expect(parseDecisionListArgs(["--issue", "abc"]).error).toContain("positive integer");
    expect(parseDecisionListArgs(["--limit", "nope"]).error).toContain("positive integer");
    expect(parseDecisionListArgs(["--issue"]).error).toContain("--issue");
  });
});

describe("runDecisionList", () => {
  it("lists all records newest-first", () => {
    const root = makeProjectWithDecisions();
    const result = runDecisionList({ projectRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.id).toBe("portfolio-dispose-seed");
    expect(result.message).toContain("scm-label-mirror");
  });

  it("filters by query", () => {
    const root = makeProjectWithDecisions();
    const result = runDecisionList({ projectRoot: root, query: "mirror" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toContain("scm-label");
  });

  it("filters by issue", () => {
    const root = makeProjectWithDecisions();
    const result = runDecisionList({ projectRoot: root, issue: 3198 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("portfolio-dispose-seed");
  });

  it("filters by scope", () => {
    const root = makeProjectWithDecisions();
    const result = runDecisionList({
      projectRoot: root,
      scope: "xbrief/active/portfolio",
    });
    expect(result.entries).toHaveLength(1);
  });

  it("returns empty message when no decisions dir", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-decision-empty-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const result = runDecisionList({ projectRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.entries).toHaveLength(0);
    expect(result.message).toContain("No decision records");
  });

  it("includes invalid records as list entries and honors limit", () => {
    const root = makeProjectWithDecisions();
    writeFileSync(
      join(root, "xbrief", "decisions", "2026-08-01-broken.decision.json"),
      "{not-json",
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "decisions", "2026-08-02-invalid.decision.json"),
      JSON.stringify({ decision: "incomplete" }),
      "utf8",
    );
    const limited = runDecisionList({ projectRoot: root, limit: 1 });
    expect(limited.entries).toHaveLength(1);
    const all = runDecisionList({ projectRoot: root });
    expect(all.entries.some((e) => e.id === "(error)" || e.id === "(invalid)")).toBe(true);
  });

  it("decisionListMain supports json and rejects bad args", () => {
    const root = makeProjectWithDecisions();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(decisionListMain(["--project-root", root, "--json", "--query", "mirror"])).toBe(0);
      expect(decisionListMain(["--nope"])).toBe(2);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
