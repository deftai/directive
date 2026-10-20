import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./migrate-category-b.js";

describe("migrate-category-b CLI (#1650)", () => {
  it("parses --project-root", () => {
    const args = parseArgs(["--project-root", "/tmp/project"]);
    expect(args.error).toBeUndefined();
    expect(args.projectRoot).toBe("/tmp/project");
  });

  it("parses --project-root=VALUE form", () => {
    expect(parseArgs(["--project-root=/tmp/p"]).projectRoot).toBe("/tmp/p");
  });

  it("returns 2 for unknown flags", () => {
    expect(run(["--not-real"])).toBe(2);
  });

  describe("run against a corpus", () => {
    let root: string;
    let outSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "catb-cli-"));
      mkdirSync(join(root, "vbrief"), { recursive: true });
      outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    afterEach(() => {
      outSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("migrates bare keys and reports them, then no-ops on a second run", () => {
      const pd = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
      writeFileSync(
        pd,
        `${JSON.stringify({ plan: { policy: { wipCap: 5 } } }, null, 2)}\n`,
        "utf8",
      );

      expect(run(["--project-root", root])).toBe(0);
      const plan = (JSON.parse(readFileSync(pd, "utf8")) as { plan: Record<string, unknown> }).plan;
      expect(plan["x-directive/policy"]).toEqual({ wipCap: 5 });

      expect(run(["--project-root", root])).toBe(0);
    });

    it("returns 1 on a bare/namespaced conflict", () => {
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const file = join(root, "vbrief", "conflict.vbrief.json");
      writeFileSync(
        file,
        `${JSON.stringify({ plan: { policy: {}, "x-directive/policy": {} } }, null, 2)}\n`,
        "utf8",
      );
      expect(run(["--project-root", root])).toBe(1);
      errSpy.mockRestore();
    });
  });
});
