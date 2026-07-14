import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as planSequenceMain } from "./plan-sequence.js";
import { main } from "./verify-plan-sequence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("verify-plan-sequence CLI (#2402)", () => {
  it("requires target-kind and target", () => {
    expect(main([])).toBe(2);
  });

  it("skips cleanly with no active sequence", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-"));
    roots.push(root);
    expect(main(["--project-root", root, "--target-kind", "issue", "--target", "1"])).toBe(0);
  });

  it("writes the exhausted fail-closed message exactly once to stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "vps-exhausted-"));
    roots.push(root);
    const file = join(root, "plan.json");
    writeFileSync(
      file,
      JSON.stringify({
        sequence_id: "exhausted-test",
        sequence_kind: "delivery",
        authorized_by: "test",
        entries: [{ id: "pr-1", kind: "pr", issue: 1 }],
      }),
    );
    expect(planSequenceMain(["set", "--project-root", root, "--file", file])).toBe(0);
    expect(planSequenceMain(["advance", "--project-root", root])).toBe(0);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(main(["--project-root", root, "--target-kind", "pr", "--target", "pr-9999"])).toBe(1);
      const writes = err.mock.calls.map((c) => String(c[0]));
      const exhaustedWrites = writes.filter((w) => w.includes("Starting another item"));
      expect(exhaustedWrites).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });
});
