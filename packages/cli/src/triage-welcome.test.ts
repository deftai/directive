import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./triage-welcome.js";

describe("triage:welcome CLI arg parsing (#2295)", () => {
  it("defaults onboard/preset/wipCap to off/null", () => {
    const args = parseArgs([]);
    expect(args.error).toBeUndefined();
    expect(args.onboard).toBe(false);
    expect(args.preset).toBeNull();
    expect(args.wipCap).toBeNull();
  });

  it("parses --onboard with --preset and --wip-cap (spaced form)", () => {
    const args = parseArgs(["--onboard", "--preset", "mid", "--wip-cap", "8"]);
    expect(args.error).toBeUndefined();
    expect(args.onboard).toBe(true);
    expect(args.preset).toBe("mid");
    expect(args.wipCap).toBe(8);
  });

  it("parses the --flag=value form", () => {
    const args = parseArgs(["--onboard", "--preset=mega", "--wip-cap=12"]);
    expect(args.preset).toBe("mega");
    expect(args.wipCap).toBe(12);
  });

  it("errors when --preset is missing its value", () => {
    const args = parseArgs(["--preset"]);
    expect(args.error).toContain("--preset");
  });

  it("errors on the empty equals form --preset= (no silent default)", () => {
    const args = parseArgs(["--onboard", "--preset="]);
    expect(args.error).toContain("--preset");
    expect(args.preset).toBeNull();
  });

  it("errors when --wip-cap is not an integer", () => {
    const args = parseArgs(["--wip-cap", "lots"]);
    expect(args.error).toContain("--wip-cap");
  });
});

describe("triage:welcome CLI --help discoverability (#2302 item 3)", () => {
  function captureRun(argv: string[]): { rc: number; out: string } {
    const chunks: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const rc = run(argv);
      return { rc, out: chunks.join("") };
    } finally {
      process.stdout.write = origOut;
    }
  }

  it("prints onboarding flags for --help without touching the filesystem", () => {
    const { rc, out } = captureRun(["--help"]);
    expect(rc).toBe(0);
    expect(out).toContain("task triage:welcome");
    expect(out).toContain("--onboard");
    expect(out).toContain("--preset");
    expect(out).toContain("--wip-cap");
  });

  it("also intercepts the -h short flag", () => {
    const { rc, out } = captureRun(["-h"]);
    expect(rc).toBe(0);
    expect(out).toContain("--onboard");
  });
});
