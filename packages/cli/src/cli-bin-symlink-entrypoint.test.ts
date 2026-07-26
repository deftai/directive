import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const itSymlink = it.skipIf(process.platform === "win32");

const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CLI_SRC_DIR, "../../..");
const HOOK_BIN_PATH = join(CLI_SRC_DIR, "../dist/hook-bin.js");
const VERIFY_ENCODING_PATH = join(CLI_SRC_DIR, "../dist/verify-encoding.js");

function ensureCliDistBuilt(): void {
  const tscBin = join(REPO_ROOT, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [tscBin, "-b", "packages/cli"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
}

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

describe("CLI bin symlink entrypoints (#2846)", () => {
  beforeAll(() => {
    ensureCliDistBuilt();
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
    expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
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
