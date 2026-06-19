import { describe, expect, it, vi } from "vitest";
import * as binary from "../scm/binary.js";
import * as wrappers from "./wrappers.js";

describe("captureExec", () => {
  it("returns stdout on success", () => {
    const result = wrappers.captureExec(
      process.execPath,
      ["-e", "process.stdout.write('ok')"],
      5000,
    );
    expect(result.returncode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("returns non-zero exit with captured streams", () => {
    const result = wrappers.captureExec(
      process.execPath,
      ["-e", "process.stderr.write('boom'); process.exit(3)"],
      5000,
    );
    expect(result.returncode).toBe(3);
    expect(result.stderr).toBe("boom");
  });

  it("maps ENOENT to -1", () => {
    const result = wrappers.captureExec("/nonexistent/binary-xyz", [], 1000);
    expect(result.returncode).toBe(-1);
    expect(result.stderr).toContain("executable not found");
  });

  it("maps ETIMEDOUT to -1", () => {
    const result = wrappers.captureExec(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], 1);
    expect(result.returncode).toBe(-1);
    expect(result.stderr).toContain("timed out after");
  });
});

describe("runGhMerge", () => {
  it("returns -1 when gh missing", () => {
    vi.spyOn(binary, "resolveBinary").mockImplementation(() => {
      throw new Error("missing");
    });
    const [rc, , stderr] = wrappers.runGhMerge(1370, "deftai/directive");
    expect(rc).toBe(-1);
    expect(stderr).toContain("gh CLI not found");
    vi.restoreAllMocks();
  });

  it("maps merge failure exit code", () => {
    vi.spyOn(binary, "resolveBinary").mockReturnValue(process.execPath);
    const [rc] = wrappers.runGhMerge(1370, "deftai/directive");
    expect(rc).not.toBe(0);
    vi.restoreAllMocks();
  });

  it("maps gh merge timeout via captureExec", () => {
    vi.spyOn(binary, "resolveBinary").mockReturnValue(process.execPath);
    const [rc, , stderr] = wrappers.runGhMerge(1370, null, { timeout: 0.001 });
    expect(rc).toBe(-1);
    expect(stderr).toContain("gh pr merge timed out after 0.001s");
    vi.restoreAllMocks();
  });

  it("omits repo flag when null", () => {
    vi.spyOn(binary, "resolveBinary").mockReturnValue(process.execPath);
    const [rc] = wrappers.runGhMerge(1370, null);
    expect(typeof rc).toBe("number");
    vi.restoreAllMocks();
  });
});

describe("runProtectedCheck", () => {
  it("invokes protected cli and returns triple", () => {
    const [rc] = wrappers.runProtectedCheck(1370, "deftai/directive", [1119]);
    expect(typeof rc).toBe("number");
  });

  it("uses custom node executable path", () => {
    const [rc, , stderr] = wrappers.runProtectedCheck(1370, null, [1119], {
      nodeExecutable: "/nonexistent/node-binary",
      timeout: 1,
    });
    expect(rc).toBe(-1);
    expect(stderr).toContain("executable not found");
  });
});

describe("runMonitor", () => {
  it("invokes monitor cli and returns triple", () => {
    const [rc, stdout] = wrappers.runMonitor(1370, "deftai/directive", 0);
    expect(typeof rc).toBe("number");
    expect(typeof stdout).toBe("string");
  });

  it("uses custom node executable path", () => {
    const [rc, , stderr] = wrappers.runMonitor(1370, "deftai/directive", 0, {
      nodeExecutable: "/nonexistent/node-binary",
    });
    expect(rc).toBe(-1);
    expect(stderr).toContain("executable not found");
  });
});
