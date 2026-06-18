import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writeProjectDefinition(root: string, plan: Record<string, unknown>): void {
  const dir = join(root, "vbrief");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "T", status: "running", items: [], ...plan },
    }),
    "utf8",
  );
}

function writeVbrief(root: string, folder: "pending" | "active", name: string): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { status: "approved", title: "T", items: [] },
    }),
    "utf8",
  );
}

function makeRepo(options: {
  plan?: Record<string, unknown>;
  pendingFiles?: number;
  activeFiles?: number;
}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-wip-cap-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (options.plan !== undefined) {
    writeProjectDefinition(root, options.plan);
  }
  for (let i = 0; i < (options.pendingFiles ?? 0); i += 1) {
    writeVbrief(root, "pending", `pending-${i}.vbrief.json`);
  }
  for (let i = 0; i < (options.activeFiles ?? 0); i += 1) {
    writeVbrief(root, "active", `active-${i}.vbrief.json`);
  }
  return root;
}

describe("evaluate", () => {
  it("returns exit 0 with success banner when within cap", () => {
    const root = makeRepo({ plan: { policy: { wipCap: 5 } }, pendingFiles: 2 });
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.stream).toBe("stdout");
    expect(result.message).toBe(
      "✓ verify:wip-cap: 2/5 in pending/+active/ (within cap; source=typed).",
    );
  });

  it("uses default cap and source when PROJECT-DEFINITION is absent", () => {
    const root = makeRepo({});
    const result = evaluate(root);
    expect(result.code).toBe(0);
    expect(result.message).toContain("(within cap; source=default).");
    expect(result.message).toContain("0/10");
  });

  it("returns exit 1 with refusal text when over cap", () => {
    const root = makeRepo({
      plan: { policy: { wipCap: 2 } },
      pendingFiles: 1,
      activeFiles: 1,
    });
    const result = evaluate(root);
    expect(result.code).toBe(1);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("❌ verify:wip-cap: 2/2");
    expect(result.message).toContain("Drain the WIP set before merging");
    expect(result.message).toContain(`project_root=${root}`);
  });

  it("returns exit 0 with over-cap warning when --allow-over-cap", () => {
    const root = makeRepo({
      plan: { policy: { wipCap: 1 } },
      pendingFiles: 2,
    });
    const result = evaluate(root, { allowOverCap: true });
    expect(result.code).toBe(0);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("⚠ verify:wip-cap: 2/1");
    expect(result.message).toContain("--allow-over-cap was passed");
  });

  it("returns exit 2 for malformed wipCap", () => {
    const root = makeRepo({ plan: { policy: { wipCap: -1 } } });
    const result = evaluate(root);
    expect(result.code).toBe(2);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("❌ verify:wip-cap: PROJECT-DEFINITION malformed:");
    expect(result.message).toContain("plan.policy.wipCap must be a non-negative integer");
  });

  it("suppresses banners when quiet", () => {
    const within = makeRepo({ plan: { policy: { wipCap: 3 } }, pendingFiles: 1 });
    expect(evaluate(within, { quiet: true })).toEqual({
      code: 0,
      message: "",
      stream: "none",
    });

    const over = makeRepo({ plan: { policy: { wipCap: 1 } }, pendingFiles: 2 });
    expect(evaluate(over, { allowOverCap: true, quiet: true })).toEqual({
      code: 0,
      message: "",
      stream: "none",
    });
  });

  it("still emits refusal when quiet and over cap without allow flag", () => {
    const root = makeRepo({ plan: { policy: { wipCap: 1 } }, pendingFiles: 2 });
    const result = evaluate(root, { quiet: true });
    expect(result.code).toBe(1);
    expect(result.stream).toBe("stderr");
    expect(result.message).toContain("❌ verify:wip-cap:");
  });
});

describe("wip-cap index re-exports", () => {
  it("exports evaluate from the barrel", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.evaluate).toBe("function");
  });
});
