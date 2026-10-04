import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSubagentPreCancelArgs, run } from "./subagent-pre-cancel.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-pre-cancel-"));
  roots.push(root);
  return root;
}

describe("subagent:pre-cancel CLI (#5278)", () => {
  it("parses dest-capable args and refuses default-to-cwd alone", () => {
    const parsed = parseSubagentPreCancelArgs([
      "--agent",
      "leaf-a",
      "--canceller-id",
      "parent-1",
      "--target-id",
      "wt",
      "--force",
      "--reason",
      "x",
    ]);
    expect(parsed.agentId).toBe("leaf-a");
    expect(parsed.targetId).toBe("wt");
    expect(parsed.force).toBe(true);

    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(["--agent", "leaf-a", "--canceller-id", "parent-1", "--force", "--reason", "x"]),
    ).toBe(2);
    expect(err.mock.calls.join("")).toContain("dest-capable");
  });

  it("refuses partial dest when only --steer-dir is set", () => {
    const root = tempRoot();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      run(
        [
          "--agent",
          "leaf-a",
          "--canceller-id",
          "parent-1",
          "--steer-dir",
          join(root, "steer-only"),
          "--force",
          "--reason",
          "x",
        ],
        root,
      ),
    ).toBe(2);
    expect(err.mock.calls.join("")).toMatch(/paired|partial dest/i);
  });

  it("force clear exits 0 with --target-id", () => {
    const root = tempRoot();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      run(
        [
          "--agent",
          "leaf-a",
          "--canceller-id",
          "parent-1",
          "--target-id",
          root,
          "--force",
          "--reason",
          "cli force",
        ],
        root,
      ),
    ).toBe(0);
    expect(out.mock.calls.join("")).toContain("FORCE");
  });

  it("fresh heartbeat without status steer stays red", () => {
    const root = tempRoot();
    const steerDir = join(root, ".deft-scratch", "subagent-steer");
    const scratchDir = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(steerDir, { recursive: true });
    mkdirSync(scratchDir, { recursive: true });
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(scratchDir, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: nowIso,
        last_message: "ok",
        phase: "implementing",
      }),
      "utf8",
    );

    expect(
      run(
        [
          "--agent",
          "leaf-a",
          "--canceller-id",
          "parent-1",
          "--steer-dir",
          steerDir,
          "--scratch-dir",
          scratchDir,
          "--first-seen-dir",
          join(root, "fs"),
        ],
        root,
      ),
    ).toBe(1);
  });

  it("help exits 0", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(run(["--help"])).toBe(0);
    expect(out.mock.calls.join("")).toContain("subagent:pre-cancel");
  });
});
