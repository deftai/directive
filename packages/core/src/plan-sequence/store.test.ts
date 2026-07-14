import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPlanSequence,
  planSequencePath,
  readPlanSequence,
  writePlanSequence,
} from "./store.js";
import { createPlanSequence } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plan-sequence store", () => {
  it("planSequencePath lives under .deft", () => {
    expect(planSequencePath("/tmp/proj").replace(/\\/g, "/")).toMatch(
      /\.deft\/plan-sequence\.json$/,
    );
  });

  it("round-trips write/read/clear", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-store-"));
    roots.push(root);
    const seq = createPlanSequence({
      sequence_id: "s",
      sequence_kind: "checklist",
      authorized_by: "op",
      entries: [{ id: "1", kind: "task" }],
    });
    writePlanSequence(root, seq);
    expect(readPlanSequence(root)?.sequence_id).toBe("s");
    expect(clearPlanSequence(root)).toBe(true);
    expect(readPlanSequence(root)).toBeNull();
  });
});
