import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./ownership-doctor.js";

describe("ownership:doctor CLI (#1617)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseArgs accepts project-root, owner, and json", () => {
    expect(parseArgs(["--project-root", "/tmp/p", "--owner", "1000:1000", "--json"])).toEqual({
      projectRoot: "/tmp/p",
      owner: "1000:1000",
      json: true,
    });
    expect(parseArgs(["--project-root=/tmp/q", "--owner=1001:1001"]).projectRoot).toBe("/tmp/q");
  });

  it("parseArgs swallows -- so recovery forms work (#1617)", () => {
    expect(parseArgs(["--", "--project-root", ".", "--json"])).toEqual({
      projectRoot: ".",
      owner: null,
      json: true,
    });
  });

  it("parseArgs rejects missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--owner"]).error).toMatch(/expected uid:gid/);
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized argument/);
  });

  it("run --help prints classifier and exits 0", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(run(["--help"])).toBe(0);
    expect(chunks.join("")).toContain("wsl-root-runtime-ownership-guard");
    expect(chunks.join("")).toContain("ownership:doctor");
  });

  it("run rejects bad argv with exit 2", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    expect(run(["--wat"])).toBe(2);
    expect(err.join("")).toMatch(/unrecognized argument/);
  });

  it("run on native host exits 0 without blocking", () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(run(["--project-root", process.cwd()])).toBe(0);
    expect(out.join("")).toMatch(/status=/);
  });
});
