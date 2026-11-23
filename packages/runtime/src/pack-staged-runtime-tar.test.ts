/**
 * #7172: pack-staged-runtime runs tar in the tarball's folder with a bare archive
 * name, and picks System32 bsdtar on win32 (same fix as tip materialize, #6703).
 * Under Git Bash, GNU tar reads `C:` in an archive path as a remote host.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_SCRIPT = join(HERE, "..", "scripts", "pack-staged-runtime.mjs");

interface TarCall {
  cmd: string;
  args: string[];
  options: { cwd?: string; encoding?: string; env?: NodeJS.ProcessEnv };
}

type RunTar = (
  flag: string,
  tgz: string,
  rest?: string[],
  opts?: { env?: NodeJS.ProcessEnv },
  deps?: {
    spawnSync?: (cmd: string, args: string[], options: TarCall["options"]) => unknown;
    platform?: string;
    env?: Record<string, string>;
    existsSync?: (p: string) => boolean;
  },
) => unknown;

async function loadRunTar(): Promise<RunTar> {
  const mod = (await import(pathToFileURL(PACK_SCRIPT).href)) as { runTar: RunTar };
  return mod.runTar;
}

describe("pack-staged-runtime tar invocation on win32 (#7172)", () => {
  // join keeps it platform-native so dirname/basename split it on every runner.
  const tgz = join("C:\\", "Users", "me", "AppData", "Local", "Temp", "pack-1", "deftai-directive-runtime-1.0.0.tgz");
  const win32 = {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    existsSync: () => true,
  };

  it.each([
    ["-xzf", ["-C", "C:\\x\\work"]],
    ["-czf", ["-C", "C:\\x\\work", "package"]],
    ["-xOf", ["package/package.json"]],
    ["-tzf", []],
  ])("%s uses System32 bsdtar, the tarball folder as cwd, and a bare archive name", async (flag, rest) => {
    const runTar = await loadRunTar();
    const calls: TarCall[] = [];
    runTar(flag, tgz, rest, { env: { COPYFILE_DISABLE: "1" } }, {
      ...win32,
      spawnSync: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.cmd).toBe("C:\\Windows\\System32\\tar.exe");
    expect(call.args).toEqual([flag, "deftai-directive-runtime-1.0.0.tgz", ...rest]);
    expect(call.args[1]).not.toContain(":");
    expect(call.options.cwd).toBe(dirname(tgz));
    expect(call.options.encoding).toBe("utf8");
    expect(call.options.env).toEqual({ COPYFILE_DISABLE: "1" });
  });

  it("uses plain tar off win32", async () => {
    const runTar = await loadRunTar();
    const calls: TarCall[] = [];
    runTar("-tzf", "/tmp/pack-1/rt.tgz", [], {}, {
      platform: "linux",
      spawnSync: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls[0].cmd).toBe("tar");
    expect(calls[0].args).toEqual(["-tzf", "rt.tgz"]);
    expect(calls[0].options.cwd).toBe("/tmp/pack-1");
  });
});
