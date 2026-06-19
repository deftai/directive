import { describe, expect, it } from "vitest";
import { runText } from "./subprocess.js";

describe("swarm subprocess", () => {
  it("returns error for empty command", () => {
    const result = runText([]);
    expect(result.returncode).toBe(-1);
    expect(result.stderr).toContain("empty");
  });

  it("captures successful stdout", () => {
    const result = runText(["node", "-e", "process.stdout.write('ok')"]);
    expect(result.returncode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("captures non-zero exit with stderr", () => {
    const result = runText(["node", "-e", "process.stderr.write('fail'); process.exit(3)"]);
    expect(result.returncode).toBe(3);
    expect(result.stderr).toContain("fail");
  });

  it("honors cwd option", () => {
    const result = runText(["node", "-p", "process.cwd()"], { cwd: "/tmp" });
    expect(result.stdout).toContain("/tmp");
  });

  it("handles missing binary", () => {
    const result = runText(["nonexistent-binary-abc-xyz"]);
    expect(result.returncode).toBe(-1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("captures thrown errors without exit status", () => {
    const result = runText(["node", "-e", "throw new Error('boom')"]);
    expect(result.returncode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
