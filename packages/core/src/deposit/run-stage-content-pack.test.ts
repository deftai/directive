import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("run-stage-content-pack (#3937)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stages a pack from process.cwd() when invoked as the prepack runner", () => {
    const root = mkdtempSync(join(tmpdir(), "run-stage-"));
    created.push(root);
    const pkgDir = join(root, "packages", "content");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(join(root, "content", "coding"), { recursive: true });
    writeFileSync(join(root, "main.md"), "See [coding](./content/coding/coding.md).\n", "utf8");
    writeFileSync(join(root, "SKILL.md"), "# skill\n", "utf8");
    writeFileSync(join(root, "content", "coding", "coding.md"), "ok\n", "utf8");
    writeFileSync(join(pkgDir, "package.json"), '{"name":"@deftai/directive-content"}\n', "utf8");

    const runner = join(process.cwd(), "packages/core/src/deposit/run-stage-content-pack.ts");
    const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
    const result = spawnSync(process.execPath, [tsx, runner], {
      cwd: pkgDir,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout || "").toBe(0);
    expect(existsSync(join(pkgDir, "main.md"))).toBe(true);
    expect(readFileSync(join(pkgDir, "main.md"), "utf8")).toContain("](./coding/coding.md)");
  });
});
