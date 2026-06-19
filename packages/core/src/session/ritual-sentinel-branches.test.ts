import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRitualState, readSentinel } from "./ritual-sentinel.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

describe("ritual-sentinel validation branches", () => {
  it("rejects malformed quick and gated step payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-val-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const base = {
      schemaVersion: 1,
      session_id: "s",
      git_head: "h",
      worktree_path: "w",
      started_at: "2026-06-09T01:00:00Z",
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      ["quick_steps must be an object", { ...base, quick_steps: [], gated_steps: {} }],
      [
        "deferred_reason",
        {
          ...base,
          quick_steps: { a: { ok: true, ts: "2026-06-09T01:00:00Z", deferred_reason: 1 } },
          gated_steps: {},
        },
      ],
      [
        "message must be a string",
        {
          ...base,
          quick_steps: { a: { ok: true, ts: "2026-06-09T01:00:00Z", message: 1 } },
          gated_steps: {},
        },
      ],
      [
        "command must be an array",
        {
          ...base,
          quick_steps: { a: { ok: true, ts: "2026-06-09T01:00:00Z", command: "x" } },
          gated_steps: {},
        },
      ],
      ["gated_steps must be an object", { ...base, quick_steps: {}, gated_steps: "nope" }],
      [
        ".ts must be an ISO-8601",
        { ...base, quick_steps: { a: { ok: true, ts: "bad" } }, gated_steps: {} },
      ],
    ];
    for (const [needle, payload] of cases) {
      writeFileSync(join(root, ".deft", "ritual-state.json"), JSON.stringify(payload), "utf8");
      const [, err] = readRitualState(root);
      expect(err).toContain(needle);
    }
  });

  it("readSentinel rejects incomplete payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-sent-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "last-session.json"),
      JSON.stringify({
        schemaVersion: 1,
        deftVersion: "1",
        timestamp: "2026-06-09T01:00:00Z",
        lastActiveVbrief: "",
        lastBranch: "main",
      }),
      "utf8",
    );
    expect(readSentinel(root)).toBeNull();
  });
});
