import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRunGh } from "./gh.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

vi.mock("../scm/call-shape.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scm/call-shape.js")>();
  return { ...actual, resolveBinaryForArgv: () => "ghx" };
});

vi.mock("../scm/spawn-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scm/spawn-status.js")>();
  return { ...actual, ghxSpawnFallbackBinary: () => "gh" };
});

type ExecOpts = { env?: NodeJS.ProcessEnv };

describe("defaultRunGh ghx fallback keeps plain env (#6023)", () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.unstubAllEnvs();
  });

  it("passes the plain child env on the first run and on the gh retry", () => {
    vi.stubEnv("CLICOLOR_FORCE", "1");
    vi.stubEnv("FORCE_COLOR", "1");
    const spawnErr = Object.assign(new Error("spawn ghx ENOENT"), { code: "ENOENT" });
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => {
        throw spawnErr;
      })
      .mockImplementationOnce(() => '{"state":"closed"}');
    const result = defaultRunGh(["gh", "api", "repos/deftai/directive/issues/6023"]);
    expect(result).toEqual({ returncode: 0, stdout: '{"state":"closed"}', stderr: "" });
    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(["ghx", "gh"]);
    for (const call of calls) {
      const env = (call[2] as ExecOpts).env;
      expect(env).toBeDefined();
      expect(env?.CLICOLOR_FORCE).toBeUndefined();
      expect(env?.FORCE_COLOR).toBeUndefined();
      expect(env?.NO_COLOR).toBe("1");
    }
    expect(process.env.CLICOLOR_FORCE).toBe("1");
  });
});
