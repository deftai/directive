import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const itSymlink = it.skipIf(process.platform === "win32");

const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK_BIN_PATH = join(CLI_SRC_DIR, "../dist/hook-bin.js");
const VERIFY_ENCODING_PATH = join(CLI_SRC_DIR, "../dist/verify-encoding.js");

const DIST_BUILD_HINT =
  "packages/cli/dist is missing — run `task check` or `pnpm --filter @deftai/directive-cli run build` before this suite";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-bin-symlink-"));
  temps.push(root);
  writeFileSync(join(root, "f.txt"), content);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

describe.sequential("CLI bin symlink entrypoints (#2846)", () => {
  beforeAll(() => {
    if (!existsSync(HOOK_BIN_PATH) || !existsSync(VERIFY_ENCODING_PATH)) {
      throw new Error(DIST_BUILD_HINT);
    }
  });

  itSymlink("deft-hook emits Cursor allow JSON through an npm-style bin symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-hook-symlink-"));
    temps.push(dir);
    const linkPath = join(dir, "deft-hook");
    symlinkSync(HOOK_BIN_PATH, linkPath);

    const payload = JSON.stringify({ tool_name: "Read", workspace_root: "/project" });
    const result = spawnSync(process.execPath, [linkPath, "--host=cursor", "--event=tool.before"], {
      input: payload,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    // code is on the wire for agent-readable verdict classes (#2864).
    expect(JSON.parse(result.stdout)).toEqual({ permission: "allow", code: "not-direct-write" });
  });

  itSymlink("deft-hook denies through a bin symlink instead of silent empty stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "deft-hook-symlink-"));
    temps.push(dir);
    const linkPath = join(dir, "deft-hook");
    symlinkSync(HOOK_BIN_PATH, linkPath);

    const result = spawnSync(process.execPath, [linkPath, "--host=cursor", "--event=tool.before"], {
      input: "",
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout);
    expect(decision.permission).toBe("deny");
    expect(decision.code).toBe("stdin-empty");
    expect(decision.user_message).toContain("stdin was empty");
  });

  itSymlink("deft-verify-encoding runs through an npm-style bin symlink", () => {
    const root = gitRepo("clean ascii\n");
    const dir = mkdtempSync(join(tmpdir(), "deft-verify-encoding-link-"));
    temps.push(dir);
    const linkPath = join(dir, "deft-verify-encoding");
    symlinkSync(VERIFY_ENCODING_PATH, linkPath);

    const result = spawnSync(process.execPath, [linkPath, "--all", "--project-root", root], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no mojibake");
  });
});
