import { describe, expect, it } from "vitest";
import { LANE_COMMANDS, resolvePnpm, runTsLane, SKIP_NOTICE } from "./run-lane.js";

/** Records invocations and returns a scripted exit code per call. */
class Runner {
  private codes: number[];
  public calls: Array<{ argv: readonly string[]; cwd: string }> = [];

  constructor(codes: number[]) {
    this.codes = [...codes];
  }

  run = (argv: readonly string[], cwd: string): { status: number | null } => {
    this.calls.push({ argv, cwd });
    const code = this.codes.length > 0 ? (this.codes.shift() as number) : 0;
    return { status: code };
  };
}

describe("runTsLane", () => {
  it("skips with a notice when pnpm is absent", () => {
    const messages: string[] = [];
    const runner = new Runner([]);

    const rc = runTsLane("/repo", { pnpm: null, runner: runner.run, out: (m) => messages.push(m) });

    expect(rc).toBe(0);
    expect(runner.calls).toEqual([]);
    expect(messages.some((m) => m.includes("skipping the TypeScript lane"))).toBe(true);
    expect(messages[0]).toBe(SKIP_NOTICE);
  });

  it("runs all lane commands in order when pnpm is present", () => {
    const runner = new Runner([0, 0, 0]);

    const rc = runTsLane("/repo", {
      pnpm: "/usr/bin/pnpm",
      runner: runner.run,
      out: () => undefined,
    });

    expect(rc).toBe(0);
    expect(runner.calls.map((c) => c.argv)).toEqual(
      LANE_COMMANDS.map((cmd) => ["/usr/bin/pnpm", ...cmd]),
    );
    expect(runner.calls.every((c) => c.cwd === "/repo")).toBe(true);
  });

  it("fails fast on the first non-zero exit", () => {
    // lint passes, build fails -> test must NOT run, exit code propagates.
    const runner = new Runner([0, 2, 0]);
    const messages: string[] = [];

    const rc = runTsLane("/repo", {
      pnpm: "pnpm",
      runner: runner.run,
      out: (m) => messages.push(m),
    });

    expect(rc).toBe(2);
    expect(runner.calls).toHaveLength(2); // lint + build only; test skipped
    expect(messages.some((m) => m.includes("build` failed (exit 2)"))).toBe(true);
  });

  it("treats a null status (signal kill / OOM) as a hard failure", () => {
    const messages: string[] = [];
    const rc = runTsLane("/repo", {
      pnpm: "pnpm",
      runner: () => ({ status: null }),
      out: (m) => messages.push(m),
    });
    expect(rc).toBe(1);
    expect(messages.some((m) => m.includes("killed by a signal"))).toBe(true);
  });
});

describe("resolvePnpm", () => {
  it("returns null when PATH is empty", () => {
    expect(resolvePnpm({ env: { PATH: "" }, platform: "linux" })).toBeNull();
  });

  it("returns null when PATH is unset", () => {
    expect(resolvePnpm({ env: {}, platform: "linux" })).toBeNull();
  });

  it("finds pnpm on a posix PATH", () => {
    const found = resolvePnpm({
      env: { PATH: "/empty:/usr/local/bin" },
      platform: "linux",
      exists: (p) => p === "/usr/local/bin/pnpm",
    });
    expect(found).toBe("/usr/local/bin/pnpm");
  });

  it("returns null when pnpm is not on any PATH entry", () => {
    const found = resolvePnpm({
      env: { PATH: "/a:/b" },
      platform: "linux",
      exists: () => false,
    });
    expect(found).toBeNull();
  });

  it("uses PATHEXT and ; separator on win32", () => {
    const found = resolvePnpm({
      env: { Path: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      exists: (p) => p.endsWith(".CMD"),
    });
    expect(found?.endsWith("pnpm.CMD")).toBe(true);
  });

  it("falls back to a default PATHEXT on win32 when unset", () => {
    const found = resolvePnpm({
      env: { Path: "C:\\bin" },
      platform: "win32",
      exists: (p) => p.endsWith(".EXE"),
    });
    expect(found?.endsWith("pnpm.EXE")).toBe(true);
  });

  it("skips empty PATH segments", () => {
    const found = resolvePnpm({
      env: { PATH: "::/usr/bin" },
      platform: "linux",
      exists: (p) => p === "/usr/bin/pnpm",
    });
    expect(found).toBe("/usr/bin/pnpm");
  });
});
