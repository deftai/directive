import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runText } from "../../swarm/subprocess.js";
import { sessionStartSpawnPlan } from "./evaluate.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const WIN32_NPM = "C:\\Users\\test\\AppData\\Roaming\\npm";

describe("sessionStartSpawnPlan (#4083)", () => {
  it("resolves deft.cmd on win32 instead of a bare deft argv0", () => {
    const plan = sessionStartSpawnPlan({
      platform: "win32",
      env: {
        PATH: WIN32_NPM,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      exists: (p) => /deft\.cmd$/i.test(p),
      isExecutable: () => true,
    });
    expect(plan.command).toBe("cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    const line = plan.args[3] ?? "";
    expect(line.toLowerCase()).toContain("deft.cmd");
    expect(line.toLowerCase()).toContain("session:start");
    expect(line.toLowerCase()).toContain("--read-only");
    expect(plan.command).not.toBe("deft");
    expect(line.split(/\s+/)[0]?.toLowerCase()).not.toBe("deft");
  });

  it("uses the PATH binary as argv0 on posix", () => {
    const plan = sessionStartSpawnPlan({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: (p) => p === "/usr/bin/deft",
      isExecutable: () => true,
    });
    expect(plan).toEqual({
      command: "/usr/bin/deft",
      args: ["session:start", "--read-only"],
    });
  });

  it("uses directive.cmd when deft is absent", () => {
    const plan = sessionStartSpawnPlan({
      platform: "win32",
      env: {
        PATH: WIN32_NPM,
        PATHEXT: ".CMD",
      },
      exists: (p) => /directive\.cmd$/i.test(p),
      isExecutable: () => true,
    });
    expect(plan.command).toBe("cmd.exe");
    expect(plan.args[3]?.toLowerCase()).toContain("directive.cmd");
    expect(plan.args[3]?.toLowerCase()).not.toContain("deft.cmd");
  });

  it("falls back to cliSpawnPlan of deft when PATH has no engine", () => {
    const plan = sessionStartSpawnPlan({
      platform: "win32",
      env: { PATH: "C:\\empty", PATHEXT: ".CMD" },
      exists: () => false,
      isExecutable: () => true,
    });
    expect(plan.command).toBe("cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toBe("deft session:start --read-only");
  });
});

describe("runText shell-false (#4083 / #2911)", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockReturnValue("");
  });

  it("passes shell: false to execFileSync and never shell: true", () => {
    runText(["deft", "session:start", "--read-only"]);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(execFileSync).mock.calls[0];
    expect(call?.[2]).toEqual(expect.objectContaining({ shell: false }));
    expect(call?.[2]).not.toEqual(expect.objectContaining({ shell: true }));
  });

  it("locks swarm/subprocess.ts against shell: true", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../swarm/subprocess.ts"),
      "utf8",
    );
    expect(src).toMatch(/shell:\s*false/);
    expect(src).not.toMatch(/shell:\s*true/);
  });
});
