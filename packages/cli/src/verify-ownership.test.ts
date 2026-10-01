import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-ownership.js";

describe("verify:ownership CLI (#1617)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseArgs accepts project-root, owner, and json", () => {
    expect(parseArgs(["--project-root=/tmp/p", "--owner=1000:1000", "--json"])).toEqual({
      projectRoot: "/tmp/p",
      owner: "1000:1000",
      json: true,
    });
  });

  it("parseArgs rejects missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--owner"]).error).toMatch(/expected uid:gid/);
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized argument/);
  });

  it("run --help mentions native Windows/macOS pass", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(run(["--help"])).toBe(0);
    expect(chunks.join("")).toContain("Native Windows/macOS");
  });

  it("run on native host exits 0", () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(run(["--project-root", process.cwd()])).toBe(0);
    expect(out.join("").length).toBeGreaterThan(0);
  });
});
