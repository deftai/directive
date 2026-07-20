import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerReviewMonitor, reviewMonitorPath } from "./record.js";

describe("review-monitor record", () => {
  it("writes under .deft/review-monitor.json", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-record-"));
    const { path } = registerReviewMonitor({
      pr: 3,
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-3",
      projectRoot: root,
    });
    expect(path).toBe(reviewMonitorPath(root));
    expect(path).toContain("review-monitor.json");
  });
});
