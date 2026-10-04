import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSteerFile, steerInboxPath } from "@deftai/directive-core/orchestration";
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

function writeParentHeartbeat(root: string, agentId: string, parentId: string): void {
  const scratch = join(root, ".deft-scratch", "subagent-status");
  mkdirSync(scratch, { recursive: true });
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(scratch, `${agentId}.json`),
    JSON.stringify({
      agent_id: agentId,
      parent_id: parentId,
      last_heartbeat_at: nowIso,
      last_message: "ok",
      phase: "polling",
    }),
    "utf8",
  );
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

  it("writes a closed-schema inbox under --target-id when heartbeat parent matches", () => {
    const root = tempRoot();
    writeParentHeartbeat(root, "leaf-a", "parent-1");
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

  it("refuses self-attested writer without independent parent identity", () => {
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
    expect(err.mock.calls.join("")).toMatch(/independent parent/i);
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
