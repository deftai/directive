import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./ownership-fix.js";

describe("ownership:fix CLI (#1617)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseArgs accepts project-root, owner, and json", () => {
    expect(parseArgs(["--project-root", "/tmp/p", "--owner", "1000:1000", "--json"])).toEqual({
      projectRoot: "/tmp/p",
      owner: "1000:1000",
      json: true,
    });
  });

  it("parseArgs swallows -- so documented task/cli forms work (#1617)", () => {
    expect(parseArgs(["--", "--project-root", ".", "--owner", "1000:1000"])).toEqual({
      projectRoot: ".",
      owner: "1000:1000",
      json: false,
    });
  });

  it("parseArgs rejects missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--owner"]).error).toMatch(/expected uid:gid/);
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized argument/);
  });

  it("run --help documents no blanket HOME chown", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(run(["--help"])).toBe(0);
    expect(chunks.join("")).toContain("No blanket HOME chown");
    expect(chunks.join("")).toContain("DEFT_PROJECT_OWNER");
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
});
