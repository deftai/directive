import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache, emit, main, readEvents, validatePairing } from "./events.js";

afterEach(() => {
  clearRegistryCache();
  delete process.env.DEFT_EVENT_LOG;
});

describe("events branch coverage (#2766)", () => {
  it("covers remaining behavioral emit variants", () => {
    const root = mkdtempSync(join(tmpdir(), "be-branches-"));
    const log = join(root, "events.jsonl");
    for (const [event, payload] of [
      ["value:gate-catch", { signal_class: "gate", source: "test" }],
      ["value:wip-cap-protect", { signal_class: "gate", source: "test", count: 1, cap: 10 }],
      ["bypass:off-flow", { signal_class: "gate", source: "test" }],
      ["adoption:unused-capability", { signal_class: "gate", source: "test", capability: "x" }],
      ["friction:directive-gap", { signal_class: "gate", source: "test" }],
    ] as const) {
      emit(event, { ...payload }, { logPath: log, projectRoot: root });
    }
    expect(readEvents(log)).toHaveLength(5);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers validate-pairing CLI with explicit log path", () => {
    const root = mkdtempSync(join(tmpdir(), "be-vp-cli-"));
    const log = join(root, "events.jsonl");
    const opened = emit(
      "session:interrupted",
      { reason: "pair", session_id: "s1" },
      { logPath: log, projectRoot: root },
    );
    emit(
      "session:resumed",
      { interrupted_id: opened.id, session_id: "s1" },
      { logPath: log, projectRoot: root },
    );
    expect(main(["validate-pairing", "--log", log])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers list CLI without explicit log path after default emit", () => {
    const root = mkdtempSync(join(tmpdir(), "be-list-default-"));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      emit(
        "session:interrupted",
        { reason: "listed", session_id: "s-list" },
        { projectRoot: root },
      );
      expect(main(["list"])).toBe(0);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers validatePairing when interrupted id is missing from payload", () => {
    const orphan = {
      detected_at: "2026-01-01T00:00:00Z",
      event: "session:resumed",
      id: "resume-1",
      payload: { session_id: "s1" },
    };
    expect(validatePairing([orphan])).toHaveLength(1);
  });
});
