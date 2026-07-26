import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "./hook-bin.js";

const itSymlink = it.skipIf(process.platform === "win32");

function ensureHookBinDistBuilt(hookBinPath: string, hookSrcPath: string): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  if (!existsSync(hookBinPath) || statSync(hookSrcPath).mtimeMs > statSync(hookBinPath).mtimeMs) {
    execFileSync("pnpm", ["exec", "tsc", "-b", "packages/cli"], { cwd: repoRoot, stdio: "pipe" });
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("deft-hook executable", () => {
  const hookBinPath = join(dirname(fileURLToPath(import.meta.url)), "../dist/hook-bin.js");
  const hookSrcPath = join(dirname(fileURLToPath(import.meta.url)), "hook-bin.ts");

  beforeAll(() => {
    ensureHookBinDistBuilt(hookBinPath, hookSrcPath);
  });

  it("uses the direct hook dispatcher instead of the general CLI router", () => {
    const source = readFileSync(new URL("./hook-bin.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin: Record<string, string> };

    expect(source).toContain('import { run } from "./hook-dispatch.js"');
    expect(source).toContain("isDirectEntrypoint");
    expect(source).not.toContain("routeAndDispatch");
    expect(manifest.bin["deft-hook"]).toBe("./dist/hook-bin.js");
  });

  it("runs the hook dispatcher without entering the general router", () => {
    expect(main([])).toBe(2);
  });

  itSymlink(
    "runs main through an npm-style bin symlink and emits Cursor allow JSON (#2846)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "deft-hook-symlink-"));
      temps.push(dir);
      const linkPath = join(dir, "deft-hook");
      symlinkSync(hookBinPath, linkPath);

      const payload = JSON.stringify({ tool_name: "Read", workspace_root: "/project" });
      const result = spawnSync(
        process.execPath,
        [linkPath, "--host=cursor", "--event=tool.before"],
        {
          input: payload,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
    },
  );

  itSymlink(
    "denies through an npm-style bin symlink instead of silent empty stdout (#2846)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "deft-hook-symlink-"));
      temps.push(dir);
      const linkPath = join(dir, "deft-hook");
      symlinkSync(hookBinPath, linkPath);

      const result = spawnSync(
        process.execPath,
        [linkPath, "--host=cursor", "--event=tool.before"],
        {
          input: "",
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      const decision = JSON.parse(result.stdout);
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("stdin was empty");
    },
  );
});
