import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDriftReport } from "./render.js";

describe("renderDriftReport full", () => {
  it("renders labels and milestones together", () => {
    const text = renderDriftReport({
      labels: { bug: 2, feat: 1 },
      milestones: { v1: 3 },
      total: 6,
      threshold: 3,
    });
    expect(text).toContain("labels not in subscription");
    expect(text).toContain("milestones not in subscription");
    expect(text).toContain("task triage:subscribe");
    expect(text).toContain("ignore-label=bug");
    expect(text).toContain("ignore-milestone=v1");
  });
});
