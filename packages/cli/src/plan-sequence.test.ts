import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as planSequenceMain } from "./plan-sequence.js";
import { main as verifyPlanSequenceMain } from "./verify-plan-sequence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plan-sequence CLI (#2402)", () => {
  it("set/current/advance/verify happy path for two-PR plan", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "cli-test",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [
          { id: "pr-1", kind: "pr", issue: 1 },
          { id: "pr-2", kind: "pr", issue: 2 },
        ],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-1"]),
    ).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(1);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(0);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(0);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "pr-2"]),
    ).toBe(1);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);
  });

  it("verify skips when no sequence", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-empty-"));
    roots.push(root);
    expect(
      verifyPlanSequenceMain(["--project-root", root, "--target-kind", "pr", "--target", "x"]),
    ).toBe(0);
  });

  it("set rejects a JSON payload that is not an object (null/array/primitive)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-non-object-"));
    roots.push(root);
    const nullFile = join(root, "null.json");
    writeFileSync(nullFile, "null");
    expect(planSequenceMain(["set", "--project-root", root, "--file", nullFile])).toBe(1);
    const arrayFile = join(root, "array.json");
    writeFileSync(arrayFile, "[1,2,3]");
    expect(planSequenceMain(["set", "--project-root", root, "--file", arrayFile])).toBe(1);
  });

  it("covers argv/flag and JSON emit branches (#3027)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-cli-branches-"));
    roots.push(root);

    expect(planSequenceMain([])).toBe(2);
    expect(planSequenceMain(["nope"])).toBe(2);
    expect(planSequenceMain(["set", "--unknown"])).toBe(2);
    expect(planSequenceMain(["set", "--project-root"])).toBe(2);
    expect(planSequenceMain(["set", "--file"])).toBe(2);
    expect(planSequenceMain(["set", "--from-json"])).toBe(2);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(1);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(1);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);

    const inline = JSON.stringify({
      sequence_id: "inline",
      sequence_kind: "checklist",
      authorized_by: "t",
      entries: [{ id: "a", kind: "task" }],
    });
    expect(
      planSequenceMain(["set", `--project-root=${root}`, "--from-json", inline, "--json"]),
    ).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root, "--json"])).toBe(0);
    expect(planSequenceMain(["advance", "--project-root", root, "--json"])).toBe(0);
    // exhausted after advance past single entry
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);
    // already absent
    expect(planSequenceMain(["clear", "--project-root", root])).toBe(0);

    // Full sequence object with current_index uses parsePlanSequence path
    const fullFile = join(root, "full.json");
    writeFileSync(
      fullFile,
      JSON.stringify({
        sequence_id: "full",
        sequence_kind: "delivery",
        authorized_by: "t",
        entries: [
          { id: "p1", kind: "pr", issue: 1 },
          { id: "p2", kind: "pr", issue: 2 },
        ],
        current_index: 0,
        batching_allowed: true,
        continuation_past_final: false,
        exhausted: false,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
      }),
    );
    expect(planSequenceMain(["set", `--file=${fullFile}`, "--project-root", root])).toBe(0);
    expect(planSequenceMain(["current", "--project-root", root])).toBe(0);
    expect(planSequenceMain(["set", "--project-root", root])).toBe(1);
  });
});
