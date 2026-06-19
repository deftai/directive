import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpecTaskIndex,
  detectStatusMarker,
  formatReconciliationMarkdown,
  hasDisagreement,
  normalizeTaskId,
  parseOverridesYaml,
  reconcileScopeItems,
  writeReconciliationReport,
} from "./reconciliation.js";
import { VBRIEF_RECONCILE_MODULE } from "./types.js";

describe("parseOverridesYaml", () => {
  it("parses documented shape", () => {
    const text =
      "overrides:\n" +
      "  t2.4.1:\n" +
      "    status: completed\n" +
      "    body_source: spec\n" +
      "  roadmap-9:\n" +
      "    drop: true\n";
    expect(parseOverridesYaml(text)).toEqual({
      "t2.4.1": { status: "completed", body_source: "spec" },
      "roadmap-9": { drop: true },
    });
  });

  it("returns empty for blank input", () => {
    expect(parseOverridesYaml("")).toEqual({});
  });

  // ReDoS-hardening regression fixtures (#1782 s4 / CodeQL js/polynomial-redos):
  // the `rawLine.trimEnd()` rewrite of `replace(/\s+$/, "")` must stay
  // byte-identical across trailing-whitespace / end-of-string / many-repetition
  // inputs, mirroring Python's `raw_line.rstrip()`.
  it("strips trailing whitespace via trimEnd identically to the regex", () => {
    const text =
      "overrides:\n" +
      "  t1:   \t \n" +
      "    status: completed   \n" +
      "    body_source: spec\t\t\n";
    expect(parseOverridesYaml(text)).toEqual({
      t1: { status: "completed", body_source: "spec" },
    });
  });

  it("handles a final line with no trailing newline", () => {
    const text = "overrides:\n  t1:\n    drop: true";
    expect(parseOverridesYaml(text)).toEqual({ t1: { drop: true } });
  });

  it("stays linear on many-repetition trailing whitespace", () => {
    const pad = " ".repeat(50000);
    const text = `overrides:\n  t1:${pad}\n    status: completed${pad}\n`;
    const start = Date.now();
    const result = parseOverridesYaml(text);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toEqual({ t1: { status: "completed" } });
  });
});

describe("normalizeTaskId", () => {
  it("strips leading t", () => {
    expect(normalizeTaskId("t1.1.1")).toBe("1.1.1");
  });
});

describe("detectStatusMarker", () => {
  it("detects done markers", () => {
    expect(detectStatusMarker("Task [done]")).toBe("completed");
  });

  it("returns null for plain text", () => {
    expect(detectStatusMarker("plain")).toBeNull();
  });
});

describe("buildSpecTaskIndex", () => {
  it("indexes nested subItems with phase", () => {
    const spec = {
      plan: {
        items: [
          {
            id: "phase-1",
            title: "Phase 1: Foundation",
            subItems: [{ id: "t1.1.1", title: "Deep" }],
          },
        ],
      },
    };
    const index = buildSpecTaskIndex(spec);
    expect(index["t1.1.1"]?.specPhase).toBe("Phase 1: Foundation");
  });
});

describe("reconcileScopeItems", () => {
  const spec = {
    plan: { items: [{ id: "t1", title: "One", status: "pending" }] },
  };

  it("clean case has no disagreement", () => {
    const [, report] = reconcileScopeItems({
      roadmapActive: [{ task_id: "t1", title: "One", number: "", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: spec,
    });
    expect(hasDisagreement(report)).toBe(false);
  });

  it("orphan routes to proposed", () => {
    const [items] = reconcileScopeItems({
      roadmapActive: [{ number: "9", title: "Orphan", phase: "P1", synthetic_id: "roadmap-9" }],
      roadmapCompleted: [],
      specVbrief: spec,
    });
    expect(items[0]?.folder).toBe("proposed");
    expect(items[0]?.source_conflict).toBe("missing-from-spec");
  });

  it("no spec means pending folder without orphan", () => {
    const [items] = reconcileScopeItems({
      roadmapActive: [{ number: "9", title: "Some", phase: "P1" }],
      roadmapCompleted: [],
      specVbrief: null,
    });
    expect(items[0]?.folder).toBe("pending");
  });
});

describe("buildSpecTaskIndex refs", () => {
  it("github issue ref in spec index", () => {
    const spec = {
      plan: {
        items: [
          {
            id: "t1",
            references: [{ type: "github-issue", id: "#123" }],
          },
        ],
      },
    };
    expect(buildSpecTaskIndex(spec)["123"]).toBeDefined();
  });
});

describe("writeReconciliationReport", () => {
  it("writes reconciliation report file", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-wrr2-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    const [, report] = reconcileScopeItems({
      roadmapActive: [],
      roadmapCompleted: [{ task_id: "t2", title: "X", number: "", phase: "Completed" }],
      specVbrief: { plan: { items: [{ id: "t2", title: "X", status: "pending" }] } },
    });
    const path = writeReconciliationReport(report, vbrief, new Date("2026-06-19T12:00:00Z"));
    expect(path).toContain("RECONCILIATION.md");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("module exports", () => {
  it("exports module constant", () => {
    expect(VBRIEF_RECONCILE_MODULE).toBe("vbrief-reconcile");
  });

  it("format markdown includes timestamp", () => {
    const now = new Date("2026-06-19T12:00:00Z");
    const [, report] = reconcileScopeItems({
      roadmapActive: [],
      roadmapCompleted: [{ task_id: "t2", title: "X", number: "", phase: "Completed" }],
      specVbrief: { plan: { items: [{ id: "t2", title: "X", status: "pending" }] } },
    });
    const md = formatReconciliationMarkdown(report, now);
    expect(md).toContain("Generated: 2026-06-19T12:00:00Z");
  });
});
