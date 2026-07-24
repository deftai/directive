import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findActiveMonitorForPr, readReviewMonitorFile } from "./record.js";

describe("review-monitor record branch coverage (#2666)", () => {
  it("readReviewMonitorFile returns empty legacy ledger (#2814)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-parse-"));
    const { data, error } = readReviewMonitorFile(join(root, ".deft", "review-monitor.json"));
    expect(error).toBeNull();
    expect(data?.records).toEqual([]);
    expect(findActiveMonitorForPr(data as NonNullable<typeof data>, 5, {})).toBeNull();
  });
});
