import { afterEach, describe, expect, it, vi } from "vitest";

const createCli = vi.hoisted(() => vi.fn(() => ({ exitCode: 0, stdout: "created\n", stderr: "" })));
const verifyCli = vi.hoisted(() => vi.fn(() => ({ exitCode: 0, stdout: "", stderr: "warn\n" })));

vi.mock("./create.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create.js")>();
  return { ...actual, runXbriefCreateCli: createCli };
});
vi.mock("./verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./verify.js")>();
  return { ...actual, runXbriefVerifyCli: verifyCli };
});

import { main } from "./index.js";

describe("xbrief main (#3057)", () => {
  const writes: { out: string[]; err: string[] } = { out: [], err: [] };
  afterEach(() => {
    writes.out = [];
    writes.err = [];
    vi.mocked(process.stdout.write).mockRestore?.();
    vi.mocked(process.stderr.write).mockRestore?.();
    createCli.mockReset();
    verifyCli.mockReset();
    createCli.mockImplementation(() => ({ exitCode: 0, stdout: "created\n", stderr: "" }));
    verifyCli.mockImplementation(() => ({ exitCode: 0, stdout: "", stderr: "warn\n" }));
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
    expect(main(["-h"])).toBe(0);
    expect(main(["nope"])).toBe(2);
    expect(writes.err.join("")).toContain("unknown xbrief subcommand");
    expect(main([])).toBe(2);
  });

  it("dispatches create/verify covering stdout and stderr branches (#3242 headroom)", () => {
    stubIo();
    createCli.mockReturnValue({ exitCode: 0, stdout: "ok-out\n", stderr: "" });
    expect(main(["create", "--format", "json", "--out", "x"])).toBe(0);
    expect(writes.out.join("")).toContain("ok-out");

    writes.out = [];
    writes.err = [];
    verifyCli.mockReturnValue({ exitCode: 1, stdout: "", stderr: "bad\n" });
    expect(main(["verify", "--format", "json", "--out", "x"])).toBe(1);
    expect(writes.err.join("")).toContain("bad");

    writes.out = [];
    writes.err = [];
    createCli.mockReturnValue({ exitCode: 0, stdout: "", stderr: "" });
    expect(main(["create"])).toBe(0);
    expect(writes.out.join("")).toBe("");
    expect(writes.err.join("")).toBe("");

    writes.out = [];
    writes.err = [];
    createCli.mockReturnValue({ exitCode: 0, stdout: "both-out\n", stderr: "both-err\n" });
    expect(main(["create"])).toBe(0);
    expect(writes.out.join("")).toContain("both-out");
    expect(writes.err.join("")).toContain("both-err");

    writes.out = [];
    writes.err = [];
    verifyCli.mockReturnValue({ exitCode: 0, stdout: "v-out\n", stderr: "v-err\n" });
    expect(main(["verify"])).toBe(0);
    expect(writes.out.join("")).toContain("v-out");
    expect(writes.err.join("")).toContain("v-err");
  });
});
