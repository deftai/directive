import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./index.js";

describe("xbrief main (#3057)", () => {
  const writes: { out: string[]; err: string[] } = { out: [], err: [] };
  afterEach(() => {
    writes.out = [];
    writes.err = [];
    vi.restoreAllMocks();
  });

  function stubIo(): void {
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      writes.out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      writes.err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  }

  it("prints help for --help and unknown subcommand", () => {
    stubIo();
    expect(main(["--help"])).toBe(0);
    expect(writes.out.join("")).toContain("xbrief:create");
    expect(main(["nope"])).toBe(2);
    expect(writes.err.join("")).toContain("unknown xbrief subcommand");
    expect(main([])).toBe(2);
  });
});
