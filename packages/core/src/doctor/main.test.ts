import { describe, expect, it } from "vitest";
import { parseDoctorFlags } from "./flags.js";
import { cmdDoctor } from "./main.js";
import { createPlainSink } from "./output.js";

describe("cmdDoctor", () => {
  it("returns 2 for unknown flags", () => {
    expect(cmdDoctor(["--nope"])).toBe(2);
  });

  it("returns 0 for full json in deft repo", () => {
    const stdout: string[] = [];
    const write = (t: string) => stdout.push(t);
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = write as typeof process.stdout.write;
    try {
      expect(cmdDoctor(["--full", "--json"], { whichFn: () => "/usr/bin/x" })).toBe(0);
      expect(stdout.join("")).toContain('"status": "completed"');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("returns 1 when uv missing", () => {
    expect(cmdDoctor(["--full", "--json"], { whichFn: () => null })).toBe(1);
  });

  it("honours throttle skip when dirty", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const exit = cmdDoctor(["--json"], {
      whichFn: () => "/usr/bin/x",
      readState: () => ({
        lastRunAt: new Date("2026-01-01T10:00:00Z"),
        lastExitCode: 1,
        lastFindingCount: 2,
        lastErrorCount: 1,
      }),
      now: () => now,
    });
    expect(exit).toBe(1);
  });

  it("bypasses throttle with --full", () => {
    expect(
      cmdDoctor(["--full", "--json"], {
        whichFn: () => "/usr/bin/x",
        readState: () => ({
          lastRunAt: new Date(),
          lastExitCode: 0,
          lastFindingCount: 0,
          lastErrorCount: 0,
        }),
      }),
    ).toBe(0);
  });
});

describe("parseDoctorFlags", () => {
  it("parses project-root forms", () => {
    expect(parseDoctorFlags(["--project-root", "/tmp"]).projectRoot).toBe("/tmp");
    expect(parseDoctorFlags(["--project-root=/tmp"]).projectRoot).toBe("/tmp");
    expect(parseDoctorFlags(["--project-root"]).unknown[0]).toContain("missing value");
  });
});

describe("createPlainSink", () => {
  it("suppresses success in quiet mode but not final", () => {
    const lines: string[] = [];
    const sink = createPlainSink({ quietMode: true, write: (t) => lines.push(t) });
    sink.success("hidden");
    sink.finalSuccess("shown");
    expect(lines.join("")).toContain("shown");
    expect(lines.join("")).not.toContain("hidden");
  });
});
