import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { runText } from "./subprocess.js";

describe("runText branch edges", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("treats non-string successful stdout as empty string", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("bytes") as unknown as string);
    expect(runText(["node", "-e", "1"])).toEqual({
      returncode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("maps ENOENT errors to returncode -1", () => {
    const err = Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    const result = runText(["missing-bin"]);
    expect(result.returncode).toBe(-1);
    expect(result.stderr).toContain("ENOENT");
  });

  it("maps ENOENT without message to command not found", () => {
    const err = Object.assign(new Error(), { code: "ENOENT", message: undefined });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    expect(runText(["missing-bin"]).stderr).toContain("command not found");
  });

  it("uses numeric status from thrown errors", () => {
    const err = Object.assign(new Error("fail"), {
      status: 7,
      stdout: "out",
      stderr: "err",
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    expect(runText(["node", "-e", "1"])).toEqual({
      returncode: 7,
      stdout: "out",
      stderr: "err",
    });
  });

  it("defaults non-numeric status and non-string streams", () => {
    const err = Object.assign(new Error("weird"), {
      status: "nope",
      stdout: Buffer.from("x"),
      stderr: Buffer.from("y"),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    expect(runText(["node", "-e", "1"])).toEqual({
      returncode: -1,
      stdout: "",
      stderr: "weird",
    });
  });

  it("falls back when thrown error has no message", () => {
    const err = Object.assign(new Error(), {
      status: undefined,
      stdout: undefined,
      stderr: undefined,
      message: undefined,
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    const result = runText(["node", "-e", "1"]);
    expect(result.returncode).toBe(-1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
