import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { defaultNpmViewVersion } from "./npm-view.js";

function successfulSpawn() {
  return {
    status: 0,
    stdout: "0.84.0\n",
    stderr: "",
    pid: 1,
    output: [null, "0.84.0\n", ""] as (string | null)[],
    signal: null,
    error: undefined,
  };
}

describe("defaultNpmViewVersion (#2808 / #4345)", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("isolates public lookup with cwd + --userconfig, not --registry", () => {
    let userconfigPath = "";
    let spawnCwd = "";
    let npmrc = "";
    vi.mocked(spawnSync).mockImplementation((_cmd, args, options) => {
      const argv = args as string[];
      const opts = options as { cwd?: string };
      const flag = argv.find((token) => token.startsWith("--userconfig="));
      userconfigPath = flag?.slice("--userconfig=".length) ?? "";
      spawnCwd = opts.cwd ?? "";
      npmrc = readFileSync(userconfigPath, "utf8");
      return successfulSpawn();
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: true, version: "0.84.0" });
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
    const [, argv, opts] = vi.mocked(spawnSync).mock.calls[0] as [
      string,
      string[],
      { cwd?: string; encoding?: string; shell?: boolean; timeout?: number; windowsHide?: boolean },
    ];
    expect(argv[0]).toBe("view");
    expect(argv[1]).toBe("@deftai/directive");
    expect(argv[2]).toBe("version");
    expect(argv).toContain("--ignore-scripts");
    expect(argv.some((token) => token.startsWith("--userconfig="))).toBe(true);
    expect(argv).not.toContain("--registry=https://registry.npmjs.org/");
    expect(spawnCwd.length).toBeGreaterThan(0);
    expect(spawnCwd).not.toBe(process.cwd());
    expect(opts.cwd).toBe(spawnCwd);
    expect(userconfigPath.startsWith(spawnCwd)).toBe(true);
    expect(npmrc).toContain("@deftai:registry=https://registry.npmjs.org/");
    expect(npmrc).not.toMatch(/@deftai\/directive[^*]*:registry/);
    expect(opts).toMatchObject({
      encoding: "utf8",
      shell: false,
      timeout: 15_000,
      windowsHide: true,
    });
    expect(existsSync(spawnCwd)).toBe(false);
  });

  it("honors timeoutMs for the session-start probe", () => {
    vi.mocked(spawnSync).mockReturnValue(successfulSpawn());

    expect(defaultNpmViewVersion({ timeoutMs: 5_000 })).toEqual({
      ok: true,
      version: "0.84.0",
    });
    const opts = vi.mocked(spawnSync).mock.calls[0]?.[2] as { timeout?: number };
    expect(opts.timeout).toBe(5_000);
  });

  it("returns unavailable when the public registry lookup fails", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "0.84.0\n",
      stderr: "network unavailable",
      pid: 1,
      output: [null, "0.84.0\n", "network unavailable"],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("returns unavailable when spawnSync reports proc.error", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("returns unavailable on empty version payload", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "\n",
      stderr: "",
      pid: 1,
      output: [null, "\n", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("uses first line when npm prints multi-line stdout", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "1.2.3\nextra noise\n",
      stderr: "",
      pid: 1,
      output: [null, "1.2.3\nextra noise\n", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: true, version: "1.2.3" });
  });

  it("treats non-string stdout as empty version", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from("1.0.0") as unknown as string,
      stderr: "",
      pid: 1,
      output: [null, Buffer.from("1.0.0"), ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("returns unavailable when spawnSync throws", () => {
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("spawn boom");
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });
});
