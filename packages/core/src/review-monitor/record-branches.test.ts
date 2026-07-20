import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findActiveMonitorForPr, readReviewMonitorFile, registerReviewMonitor } from "./record.js";

describe("review-monitor record branch coverage (#2666)", () => {
  it("registerReviewMonitor throws when the monitor file cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-reg-throw-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "review-monitor.json"), "{bad", "utf8");
    expect(() =>
      registerReviewMonitor({
        pr: 3,
        platformPrimitive: "cursor-task",
        monitorAgentId: "rm-3",
        projectRoot: root,
      }),
    ).toThrow(/invalid JSON/);
  });

  it("readReviewMonitorFile preserves ended_at and defaults schema_version", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-parse-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "review-monitor.json"),
      JSON.stringify({
        records: [
          {
            pr: 5,
            monitor_agent_id: "rm-5",
            platform_primitive: "cursor-task",
            started_at: "2026-07-20T12:00:00Z",
            worktree_path: root,
            ended_at: "2026-07-20T13:00:00Z",
          },
        ],
      }),
      "utf8",
    );
    const { data } = readReviewMonitorFile(join(root, ".deft", "review-monitor.json"));
    expect(data?.schema_version).toBe(1);
    expect(data?.records[0]?.ended_at).toBe("2026-07-20T13:00:00Z");
    expect(findActiveMonitorForPr(data as NonNullable<typeof data>, 5, {})).toBeNull();
  });
});
