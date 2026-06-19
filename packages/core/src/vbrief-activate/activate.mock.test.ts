import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("activate statSync failure branch", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports statSync failures after existsSync succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-activate-stat-"));
    roots.push(root);
    const path = join(root, "vbrief", "pending", "x.vbrief.json");
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "pending", items: [] },
      }),
      "utf8",
    );

    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: (target: string) => target === path || actual.existsSync(target),
        statSync: (target: string) => {
          if (target === path) {
            throw new Error("stat denied");
          }
          return actual.statSync(target);
        },
      };
    });

    const { activate } = await import("./activate.js");
    const result = activate(path);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Could not read vBRIEF");
    expect(result.message).toContain("stat denied");
  });
});
