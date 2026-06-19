import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activate } from "./activate.js";

const FIXTURE_NAME = "2026-05-01-test.vbrief.json";
const FIXED_NOW = new Date("2026-06-19T12:00:00.000Z");

function writeVbrief(
  base: string,
  folder: string,
  options: {
    status?: string;
    rawOverride?: string;
    payloadOverride?: Record<string, unknown>;
  } = {},
): string {
  const dir = join(base, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FIXTURE_NAME);
  if (options.rawOverride !== undefined) {
    writeFileSync(path, options.rawOverride, "utf8");
    return path;
  }
  if (options.payloadOverride !== undefined) {
    writeFileSync(path, JSON.stringify(options.payloadOverride), "utf8");
    return path;
  }
  writeFileSync(
    path,
    JSON.stringify({
      vBRIEFInfo: { version: "0.6", updated: "2026-04-30T00:00:00Z" },
      plan: { title: "T", status: options.status ?? "pending", items: [] },
    }),
    "utf8",
  );
  return path;
}

describe("activate", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-test-"));
    roots.push(root);
    return root;
  }

  it("flips pending to active and moves the file", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "pending" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Activated");

    const dest = join(root, "vbrief", "active", FIXTURE_NAME);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(src)).toBe(false);

    const payload = JSON.parse(readFileSync(dest, "utf8")) as {
      plan: { status: string };
      vBRIEFInfo: { updated: string };
    };
    expect(payload.plan.status).toBe("running");
    expect(payload.vBRIEFInfo.updated).toBe("2026-06-19T12:00:00Z");
  });

  it("accepts approved status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "approved" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "vbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as { plan: { status: string } };
    expect(payload.plan.status).toBe("running");
  });

  it("is idempotent for already-active running vBRIEFs", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "active", { status: "running" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("No-op");
    expect(existsSync(src)).toBe(true);
  });

  it("rejects proposed folder", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "proposed", { status: "proposed" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only pending/ vBRIEFs can be activated");
    expect(existsSync(src)).toBe(true);
  });

  it("rejects completed folder", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "completed", { status: "completed" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only pending/ vBRIEFs can be activated");
  });

  it("rejects active folder with blocked status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "active", { status: "blocked" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("task scope:unblock");
  });

  it("rejects ineligible pending status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "draft" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only ['approved', 'pending']");
  });

  it("rejects missing path", () => {
    const root = tempRoot();
    const result = activate(join(root, "missing.vbrief.json"), { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("vBRIEF not found");
  });

  it("rejects malformed json", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { rawOverride: "{ not json" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("is not valid JSON");
  });

  it("rejects missing plan", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { vBRIEFInfo: { version: "0.6" } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("lacks a `plan` object");
  });

  it("rejects missing plan.status", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { vBRIEFInfo: { version: "0.6" }, plan: { title: "T" } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("lacks `plan.status`");
  });

  it("rejects destination collision", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { status: "pending" });
    const activeDir = join(root, "vbrief", "active");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, FIXTURE_NAME), "{}", "utf8");
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Refusing to overwrite");
    expect(existsSync(src)).toBe(true);
  });

  it("creates vBRIEFInfo when absent", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { plan: { title: "T", status: "pending", items: [] } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
    const dest = join(root, "vbrief", "active", FIXTURE_NAME);
    const payload = JSON.parse(readFileSync(dest, "utf8")) as { vBRIEFInfo: { updated: string } };
    expect(payload.vBRIEFInfo.updated).toBe("2026-06-19T12:00:00Z");
  });

  it("rejects non-object vBRIEFInfo", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", {
      payloadOverride: { vBRIEFInfo: "bad", plan: { title: "T", status: "pending", items: [] } },
    });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("non-object `vBRIEFInfo`");
  });

  it("rejects top-level array json", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { rawOverride: "[]" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("top-level value is not a JSON object");
  });

  it("rejects top-level null json", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "pending", { rawOverride: "null" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("top-level value is not a JSON object");
  });

  it("rejects cancelled folder", () => {
    const root = tempRoot();
    const src = writeVbrief(root, "cancelled", { status: "cancelled" });
    const result = activate(src, { now: FIXED_NOW });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("only pending/ vBRIEFs can be activated");
  });
});
