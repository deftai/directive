import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionWriteMain, parseDecisionWriteArgs, runDecisionWrite } from "./write.js";

const roots: string[] = [];

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-decision-write-"));
  roots.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "active", "story.xbrief.json"),
    JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8", description: "test", updated: "2026-08-08T00:00:00Z" },
        plan: {
          id: "story",
          title: "Story",
          status: "running",
          narratives: {
            Description: "A story long enough for validation placeholders.",
            ImplementationPlan: "Do the thing carefully with tests.",
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

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

const baseInput = {
  decision: "Prefer dual location for decision records",
  governingRule: {
    description: "Significant choices leave durable rationale",
    path: "content/docs/decision-log.md",
    rfc2119: "MUST",
  },
  alternatives: [
    { option: "scope-only", whyNot: "orphans cross-cutting" },
    { option: "ADR-only", whyNot: "too heavy" },
  ],
  whyWinner: "Covers both cases without ADR noise",
  confidence: "high",
  revisitTrigger: "If list/find is painful, reconsider folder layout",
  timestamp: "2026-08-08T15:00:00Z",
  id: "dual-location-layout",
};

describe("parseDecisionWriteArgs", () => {
  it("parses flags and positionals", () => {
    const args = parseDecisionWriteArgs([
      "--confidence",
      "medium",
      "--alternative",
      "A",
      "--alternative",
      "B",
      "--why-winner",
      "because",
      "--revisit-trigger",
      "later",
      "--governing-rule",
      "rule",
      "Use dual location",
    ]);
    expect(args.decision).toBe("Use dual location");
    expect(args.confidence).toBe("medium");
    expect(args.alternatives).toEqual(["A", "B"]);
    expect(args.whyWinner).toBe("because");
  });

  it("flags unrecognized args", () => {
    expect(parseDecisionWriteArgs(["--nope"]).error).toContain("unrecognized");
  });
});

describe("runDecisionWrite", () => {
  it("writes a standalone decision under xbrief/decisions/", () => {
    const root = makeProject();
    const result = runDecisionWrite({
      ...baseInput,
      projectRoot: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe("xbrief/decisions/2026-08-08-dual-location-layout.decision.json");
    expect(existsSync(join(root, result.path as string))).toBe(true);
    const raw = JSON.parse(readFileSync(join(root, result.path as string), "utf8"));
    expect(raw.decision).toContain("dual location");
    expect(raw.revisitTrigger).toContain("list/find");
  });

  it("fails closed on invalid schema", () => {
    const root = makeProject();
    const result = runDecisionWrite({
      decision: "Incomplete",
      projectRoot: root,
    });
    expect(result.exitCode).toBe(2);
    expect(result.outcome).toBe("error-bad-args");
    expect(result.message).toContain("invalid decision record");
  });

  it("links a pointer into the scope xBRIEF when --scope is set", () => {
    const root = makeProject();
    const scope = "xbrief/active/story.xbrief.json";
    const result = runDecisionWrite({
      ...baseInput,
      scope,
      projectRoot: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.scopePath).toBe(scope);
    const scopeDoc = JSON.parse(readFileSync(join(root, scope), "utf8"));
    expect(scopeDoc.plan.narratives.Decisions).toContain(result.path);
  });

  it("supports body-file input", () => {
    const root = makeProject();
    const bodyPath = join(root, "body.json");
    writeFileSync(
      bodyPath,
      JSON.stringify({
        ...baseInput,
        alternativesConsidered: baseInput.alternatives,
        governingRule: baseInput.governingRule,
      }),
      "utf8",
    );
    const result = runDecisionWrite({
      bodyFile: bodyPath,
      projectRoot: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.path).toContain(".decision.json");
  });

  it("dry-run does not write", () => {
    const root = makeProject();
    const result = runDecisionWrite({
      ...baseInput,
      dryRun: true,
      projectRoot: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("dry-run");
    expect(existsSync(join(root, "xbrief", "decisions"))).toBe(false);
  });

  it("fails when body file is missing or not an object", () => {
    const root = makeProject();
    const missing = runDecisionWrite({ bodyFile: join(root, "nope.json"), projectRoot: root });
    expect(missing.exitCode).toBe(2);
    const arrPath = join(root, "arr.json");
    writeFileSync(arrPath, "[]", "utf8");
    const bad = runDecisionWrite({ bodyFile: arrPath, projectRoot: root });
    expect(bad.exitCode).toBe(2);
  });

  it("fails closed when project root is missing", () => {
    const result = runDecisionWrite({
      ...baseInput,
      projectRoot: "C:/definitely-missing-root-xyz",
    });
    expect(result.exitCode).toBe(2);
    expect(result.outcome).toBe("error-config");
  });

  it("refuses overwrite without --force", () => {
    const root = makeProject();
    const first = runDecisionWrite({ ...baseInput, projectRoot: root });
    expect(first.exitCode).toBe(0);
    const second = runDecisionWrite({ ...baseInput, projectRoot: root });
    expect(second.exitCode).toBe(2);
    expect(second.message).toContain("already exists");
    const forced = runDecisionWrite({ ...baseInput, force: true, projectRoot: root });
    expect(forced.exitCode).toBe(0);
  });

  it("skips re-linking an existing scope pointer", () => {
    const root = makeProject();
    const scope = "xbrief/active/story.xbrief.json";
    const first = runDecisionWrite({ ...baseInput, scope, projectRoot: root });
    expect(first.exitCode).toBe(0);
    const second = runDecisionWrite({
      ...baseInput,
      id: "dual-location-layout-2",
      scope,
      projectRoot: root,
    });
    expect(second.exitCode).toBe(0);
    const scopeDoc = JSON.parse(readFileSync(join(root, scope), "utf8"));
    expect(scopeDoc.plan.narratives.Decisions).toContain("dual-location-layout");
    expect(scopeDoc.plan.narratives.Decisions).toContain("dual-location-layout-2");
  });

  it("decisionWriteMain json path and flags", () => {
    const root = makeProject();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = decisionWriteMain([
        "--project-root",
        root,
        "--decision",
        "Ship list surface",
        "--governing-rule",
        "CLI parity",
        "--governing-path",
        "docs",
        "--governing-rfc",
        "SHOULD",
        "--alternative",
        "docs only",
        "--why-winner",
        "Agents need list",
        "--confidence",
        "high",
        "--revisit-trigger",
        "If unused, drop",
        "--tag",
        "cli",
        "--related-issue",
        "1396",
        "--id",
        "ship-list",
        "--timestamp",
        "2026-08-09T00:00:00Z",
        "--json",
      ]);
      expect(code).toBe(0);
      expect(out).toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
