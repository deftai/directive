import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSteerFile, steerInboxPath } from "@deftai/directive-core/orchestration";
import { recordChildOccupancyLease } from "@deftai/directive-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSubagentSteerWriteArgs, run } from "./subagent-steer-write.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-steer-write-"));
  roots.push(root);
  return root;
}

function recordParentLease(root: string, agentId: string, parentId: string): void {
  recordChildOccupancyLease(root, {
    agentId,
    parentId,
    occupancyOwner: parentId,
    worktreePath: root,
    identitySourceKind: "host-env",
    incarnation: "inc-1",
    provenance: "dispatch",
  });
}

describe("subagent:steer CLI (#5278)", () => {
  it("parses required write args", () => {
    const parsed = parseSubagentSteerWriteArgs([
      "--agent",
      "leaf-a",
      "--writer-id",
      "parent-1",
      "--kind",
      "note",
      "--text",
      "status?",
      "--target-id",
      "wt",
    ]);
    expect(parsed.agentId).toBe("leaf-a");
    expect(parsed.kind).toBe("note");
    expect(parsed.targetId).toBe("wt");
  });

  it("writes a closed-schema inbox under --target-id when child occupancy parent matches", () => {
    const root = tempRoot();
    recordParentLease(root, "leaf-a", "parent-1");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      run(
        [
          "--agent",
          "leaf-a",
          "--writer-id",
          "parent-1",
          "--kind",
          "correction",
          "--text",
          "report wait_kind",
          "--steer-id",
          "steer-cli-1",
          "--target-id",
          root,
        ],
        root,
      ),
    ).toBe(0);
    expect(out.mock.calls.join("")).toContain("steer-cli-1");
    const parsed = parseSteerFile(
      steerInboxPath(join(root, ".deft-scratch", "subagent-steer"), "leaf-a"),
    );
    expect(parsed.record?.steer_id).toBe("steer-cli-1");
    expect(parsed.record?.kind).toBe("correction");
  });

  it("refuses self-attested writer without child occupancy lease", () => {
    const root = tempRoot();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(
        [
          "--agent",
          "leaf-a",
          "--writer-id",
          "imposter",
          "--kind",
          "halt",
          "--text",
          "stop",
          "--target-id",
          root,
        ],
        root,
      ),
    ).toBe(2);
    expect(err.mock.calls.join("")).toMatch(/child occupancy lease/i);
  });

  it("refuses caller-controlled heartbeat as parent authority", () => {
    const root = tempRoot();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // No child occupancy lease — attacker-shaped heartbeat must not authorize.
    expect(
      run(
        [
          "--agent",
          "leaf-a",
          "--writer-id",
          "attacker",
          "--kind",
          "halt",
          "--text",
          "stop",
          "--target-id",
          root,
          "--scratch-dir",
          join(root, "attacker-scratch"),
        ],
        root,
      ),
    ).toBe(2);
    expect(err.mock.calls.join("")).toMatch(
      /heartbeat alone is not authority|child occupancy lease/i,
    );
  });

  it("refuses empty text and unknown kind", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--agent", "leaf-a", "--writer-id", "p", "--kind", "note", "--text", "  "])).toBe(
      2,
    );
    expect(run(["--agent", "leaf-a", "--writer-id", "p", "--kind", "vibes", "--text", "x"])).toBe(
      2,
    );
    expect(err.mock.calls.join("")).toMatch(/kind|text/i);
  });

  it("help exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("subagent:steer");
  });
});
