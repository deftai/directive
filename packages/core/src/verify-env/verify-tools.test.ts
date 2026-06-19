import { describe, expect, it } from "vitest";
import {
  detectPackageManager,
  detectPlatform,
  verificationResultToJson,
  verifyRequiredTools,
} from "./verify-tools.js";

function probeWith(...commands: string[]) {
  const available = new Set(commands);
  return (command: string) => (available.has(command) ? `/usr/bin/${command}` : null);
}

describe("verifyRequiredTools", () => {
  it("passes when all tools exist", () => {
    const lines: string[] = [];
    const result = verifyRequiredTools({
      platformId: "linux",
      probe: probeWith("git", "task", "uv", "python3", "gh", "apt-get"),
      outputFn: (line) => {
        lines.push(line);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["[deft tools] Required tools are available."]);
  });

  it("reports missing installable task with exit 1", () => {
    const lines: string[] = [];
    const result = verifyRequiredTools({
      includeTask: true,
      platformId: "linux",
      probe: probeWith("git", "uv", "python3", "gh", "apt-get"),
      outputFn: (line) => {
        lines.push(line);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)).toBe("[deft tools] Unresolved required tools: task.");
  });

  it("treats missing git as foundational exit 2", () => {
    const result = verifyRequiredTools({
      platformId: "linux",
      probe: probeWith("task", "uv", "python3", "gh", "apt-get"),
    });
    expect(result.exitCode).toBe(2);
  });

  it("serializes json with sorted keys", () => {
    const result = verifyRequiredTools({
      platformId: "linux",
      probe: probeWith("git", "uv", "python3", "gh", "apt-get"),
    });
    const json = verificationResultToJson(result);
    expect(json).toContain('"exit_code"');
    expect(JSON.parse(json)).toMatchObject({ exit_code: 0, platform: "linux" });
  });
});

describe("detectPlatform", () => {
  it("maps linux platform id", () => {
    expect(detectPlatform("linux")).toBe("linux");
  });
});

describe("detectPackageManager", () => {
  it("returns apt-get when present", () => {
    expect(detectPackageManager("linux", probeWith("apt-get"))).toBe("apt-get");
  });
});
