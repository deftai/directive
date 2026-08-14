import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_CEREMONY_MODEL_TIER } from "../policy/ceremony-dial.js";
import {
  collectCeremonyDialConsumerEvidence,
  ENV_FAILING_GATE_COUNT,
  ENV_HOST_MODEL_TIER,
  formatCeremonyDialEvidenceLine,
  mergeCeremonyDialInputsWithConsumerEvidence,
  taskSizeFromClauseCount,
  taskSizeFromFailingGateCount,
} from "./ceremony-dial-evidence.js";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dial-evidence-"));
  temps.push(root);
  return root;
}

function writeBrief(
  root: string,
  folder: "active" | "pending",
  name: string,
  acceptance: Record<string, unknown>,
): void {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", acceptance },
    }),
    "utf8",
  );
}

describe("taskSizeFromClauseCount (#3358)", () => {
  it("stays null when no clauses exist — rapid default unchanged", () => {
    expect(taskSizeFromClauseCount(0)).toBeNull();
    expect(taskSizeFromClauseCount(-1)).toBeNull();
    expect(taskSizeFromClauseCount(Number.NaN)).toBeNull();
  });

  it("maps stamped clause counts to size bands", () => {
    expect(taskSizeFromClauseCount(1)).toBe("S");
    expect(taskSizeFromClauseCount(2)).toBe("M");
    expect(taskSizeFromClauseCount(3)).toBe("M");
    expect(taskSizeFromClauseCount(4)).toBe("L");
    expect(taskSizeFromClauseCount(6)).toBe("L");
    expect(taskSizeFromClauseCount(7)).toBe("XL");
  });
});

describe("taskSizeFromFailingGateCount (#3358)", () => {
  it("stays null on zero — does not invent a size", () => {
    expect(taskSizeFromFailingGateCount(0)).toBeNull();
  });

  it("maps a positive failing-gate count to M/L", () => {
    expect(taskSizeFromFailingGateCount(1)).toBe("M");
    expect(taskSizeFromFailingGateCount(2)).toBe("M");
    expect(taskSizeFromFailingGateCount(3)).toBe("L");
  });
});

describe("collectCeremonyDialConsumerEvidence (#3358)", () => {
  it("returns null inputs when the consumer has no stamped clauses or host env", () => {
    const evidence = collectCeremonyDialConsumerEvidence(tempRoot(), { env: {} });
    expect(evidence.taskSize).toBeNull();
    expect(evidence.modelTier).toBeNull();
    expect(evidence.clauseCount).toBeNull();
    expect(evidence.reasons).toEqual([]);
    expect(formatCeremonyDialEvidenceLine(evidence)).toBeNull();
  });

  it("reads stamped clause count from an active brief as a size proxy", () => {
    const root = tempRoot();
    writeBrief(root, "active", "story.xbrief.json", {
      none_stated: true,
      clauses: [
        { id: 1, text: "a" },
        { id: 2, text: "b" },
        { id: 3, text: "c" },
      ],
    });
    const evidence = collectCeremonyDialConsumerEvidence(root, { env: {} });
    expect(evidence.clauseCount).toBe(3);
    expect(evidence.taskSize).toBe("M");
    expect(evidence.reasons.some((r) => r.includes("clauseCount=3"))).toBe(true);
    expect(formatCeremonyDialEvidenceLine(evidence)).toContain("taskSize=M");
  });

  it("accepts a numeric clause_count stamp when clauses[] is absent", () => {
    const root = tempRoot();
    writeBrief(root, "active", "stamped.xbrief.json", { clause_count: 4 });
    const evidence = collectCeremonyDialConsumerEvidence(root, { env: {} });
    expect(evidence.clauseCount).toBe(4);
    expect(evidence.taskSize).toBe("L");
  });

  it("uses pending when active has no clauses", () => {
    const root = tempRoot();
    writeBrief(root, "pending", "queued.xbrief.json", {
      clauses: [{ id: 1, text: "one" }],
    });
    const evidence = collectCeremonyDialConsumerEvidence(root, { env: {} });
    expect(evidence.clauseCount).toBe(1);
    expect(evidence.taskSize).toBe("S");
  });

  it("takes the max stamped count across briefs", () => {
    const root = tempRoot();
    writeBrief(root, "active", "small.xbrief.json", {
      clauses: [{ id: 1, text: "one" }],
    });
    writeBrief(root, "pending", "hard.xbrief.json", {
      clauses: [
        { id: 1, text: "a" },
        { id: 2, text: "b" },
        { id: 3, text: "c" },
        { id: 4, text: "d" },
      ],
    });
    const evidence = collectCeremonyDialConsumerEvidence(root, { env: {} });
    expect(evidence.clauseCount).toBe(4);
    expect(evidence.taskSize).toBe("L");
  });

  it("ignores malformed briefs instead of inventing a size", () => {
    const root = tempRoot();
    const dir = join(root, "xbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.xbrief.json"), "{not-json", "utf8");
    const evidence = collectCeremonyDialConsumerEvidence(root, { env: {} });
    expect(evidence.taskSize).toBeNull();
    expect(evidence.clauseCount).toBeNull();
  });

  it("reads a host-supplied model-tier env", () => {
    const evidence = collectCeremonyDialConsumerEvidence(tempRoot(), {
      env: { [ENV_HOST_MODEL_TIER]: "mid" },
    });
    expect(evidence.modelTier).toBe("mid");
    expect(evidence.reasons.some((r) => r.includes("modelTier=mid"))).toBe(true);
  });

  it("lets ceremony-specific model-tier env win over the generic host hint", () => {
    const evidence = collectCeremonyDialConsumerEvidence(tempRoot(), {
      env: {
        [ENV_HOST_MODEL_TIER]: "low",
        [ENV_CEREMONY_MODEL_TIER]: "frontier",
      },
    });
    expect(evidence.modelTier).toBe("frontier");
  });

  it("ignores an unparsable failing-gate env instead of inventing a size", () => {
    const evidence = collectCeremonyDialConsumerEvidence(tempRoot(), {
      env: { [ENV_FAILING_GATE_COUNT]: "nope" },
    });
    expect(evidence.failingGateCount).toBeNull();
    expect(evidence.taskSize).toBeNull();
  });

  it("raises size from a failing-gate count the harness can supply", () => {
    const evidence = collectCeremonyDialConsumerEvidence(tempRoot(), {
      env: { [ENV_FAILING_GATE_COUNT]: "3" },
    });
    expect(evidence.failingGateCount).toBe(3);
    expect(evidence.taskSize).toBe("L");
  });

  it("records a same-size failing-gate count without raising further", () => {
    const root = tempRoot();
    writeBrief(root, "active", "story.xbrief.json", {
      clauses: [
        { id: 1, text: "a" },
        { id: 2, text: "b" },
        { id: 3, text: "c" },
      ],
    });
    const evidence = collectCeremonyDialConsumerEvidence(root, {
      env: { [ENV_FAILING_GATE_COUNT]: "2" },
    });
    expect(evidence.taskSize).toBe("M");
    expect(evidence.reasons.some((r) => r.includes("failingGateCount=2"))).toBe(true);
  });

  it("keeps the larger of clause-count and failing-gate size", () => {
    const root = tempRoot();
    writeBrief(root, "active", "story.xbrief.json", {
      clauses: [{ id: 1, text: "one" }],
    });
    const evidence = collectCeremonyDialConsumerEvidence(root, {
      env: { [ENV_FAILING_GATE_COUNT]: "3" },
    });
    expect(evidence.taskSize).toBe("L");
    expect(evidence.clauseCount).toBe(1);
  });
});

describe("mergeCeremonyDialInputsWithConsumerEvidence (#3358)", () => {
  it("fills only missing fields so explicit CLI inputs still win", () => {
    const evidence = {
      taskSize: "L" as const,
      modelTier: "low" as const,
      clauseCount: 4,
      failingGateCount: null,
      reasons: ["taskSize=L from stamped clauseCount=4"],
    };
    expect(
      mergeCeremonyDialInputsWithConsumerEvidence(
        { taskSize: "S", modelTier: null, projectShape: "project" },
        evidence,
      ),
    ).toEqual({ taskSize: "S", modelTier: "low", projectShape: "project" });
  });
});
