import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ELIGIBLE_STATUS, emitJson, evaluate, formatActivateHint } from "./evaluate.js";
import { emitJson as emitJsonFromIndex, evaluate as evaluateFromIndex } from "./index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writeVbrief(folder: string, name: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-preflight-test-"));
  temps.push(root);
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, content, "utf8");
  return full;
}

describe("evaluate", () => {
  it("returns exit 0 for active/ + running", () => {
    const path = writeVbrief(
      "active",
      "story.vbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(0);
    expect(result.message).toBe(`OK ${path} -- ready for implementation.`);
  });

  it("rejects pending/ folder", () => {
    const path = writeVbrief(
      "pending",
      "story.vbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("pending/");
    expect(result.message).toContain(formatActivateHint(path));
  });

  it("rejects proposed/ folder", () => {
    const path = writeVbrief(
      "proposed",
      "story.vbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    expect(evaluate(path).exitCode).toBe(1);
  });

  it("rejects wrong plan.status", () => {
    const path = writeVbrief(
      "active",
      "story.vbrief.json",
      JSON.stringify({ plan: { status: "pending" } }),
    );
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("plan.status is 'pending'");
    expect(result.message).toContain(ELIGIBLE_STATUS);
  });

  it("rejects missing plan.status", () => {
    const path = writeVbrief("active", "story.vbrief.json", JSON.stringify({ plan: {} }));
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("lacks `plan.status`");
  });

  it("rejects missing plan object", () => {
    const path = writeVbrief("active", "story.vbrief.json", JSON.stringify({}));
    expect(evaluate(path).message).toContain("lacks a `plan` object");
  });

  it("rejects non-object top-level JSON", () => {
    const path = writeVbrief("active", "story.vbrief.json", "[]");
    expect(evaluate(path).message).toContain("top-level value is not a JSON object");
  });

  it("rejects malformed JSON with Python-style msg", () => {
    const path = writeVbrief("active", "story.vbrief.json", "{bad json");
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Expecting property name enclosed in double quotes (line 1).");
  });

  it("rejects missing file", () => {
    const path = join(tmpdir(), "missing-active-story.vbrief.json");
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("vBRIEF not found");
  });

  it("rejects a directory path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-preflight-dir-"));
    temps.push(root);
    mkdirSync(join(root, "active"), { recursive: true });
    const result = evaluate(join(root, "active"));
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not a regular file");
  });
});

describe("emitJson", () => {
  it("emits sorted keys matching the Python schema", () => {
    const json = emitJson("/x/y.vbrief.json", 0, "OK");
    expect(json).toBe(
      JSON.stringify(
        { ready: true, exit_code: 0, vbrief_path: "/x/y.vbrief.json", message: "OK" },
        ["exit_code", "message", "ready", "vbrief_path"],
      ),
    );
  });

  it("marks ready false for non-zero exit", () => {
    const payload = JSON.parse(emitJson("/p", 1, "nope")) as { ready: boolean; exit_code: number };
    expect(payload.ready).toBe(false);
    expect(payload.exit_code).toBe(1);
  });
});

describe("preflight index barrel", () => {
  it("re-exports evaluate and emitJson", () => {
    expect(evaluateFromIndex).toBe(evaluate);
    expect(emitJsonFromIndex).toBe(emitJson);
  });
});

describe("evaluate edge branches", () => {
  it("handles unreadable vBRIEF files", () => {
    const path = writeVbrief(
      "active",
      "locked.vbrief.json",
      JSON.stringify({ plan: { status: "running" } }),
    );
    chmodSync(path, 0o000);
    try {
      const result = evaluate(path);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("Could not read vBRIEF");
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("maps unexpected token to Expecting value", () => {
    const path = writeVbrief("active", "story.vbrief.json", "not json");
    expect(evaluate(path).message).toContain("Expecting value (line 1).");
  });

  it("maps Extra data JSON errors", () => {
    const path = writeVbrief("active", "extra.vbrief.json", '{"a":1}{"b":2}');
    expect(evaluate(path).message).toContain("Extra data");
  });

  it("falls back to generic JSON error mapping", () => {
    // Force a message shape not covered by explicit branches.
    const path = writeVbrief("active", "weird.vbrief.json", "\u0000");
    const result = evaluate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not valid JSON");
  });
});
