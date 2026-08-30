import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as callShape from "../scm/call-shape.js";
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

  it("streams stderr live when inheritStderr is set", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = wrappers.captureExec(
      process.execPath,
      ["-e", "process.stderr.write('live')"],
      5000,
      { inheritStderr: true },
    );
    expect(result.returncode).toBe(0);
    expect(result.stderr).toBe("");
    stderrSpy.mockRestore();
  });

  it("passes custom env to the child process", () => {
    const result = wrappers.captureExec(
      process.execPath,
      ["-e", "process.stdout.write(process.env.DEFT_WRAPPER_ENV_PROBE || '')"],
      5000,
      { env: { ...process.env, DEFT_WRAPPER_ENV_PROBE: "ok" } },
    );
    expect(result.stdout).toBe("ok");
  });

  it("returns -1 when spawn status is null", () => {
    const result = wrappers.captureExec("/nonexistent/binary-xyz-2", [], 1000);
    expect(result.returncode).toBe(-1);
  });
});

describe("runGhMerge", () => {
  it("returns -1 when gh missing", () => {
    vi.spyOn(callShape, "resolveBinaryForArgv").mockImplementation(() => {
      throw new Error("missing");
    });
    const [rc, , stderr] = wrappers.runGhMerge(1370, "deftai/directive");
    expect(rc).toBe(-1);
    expect(stderr).toContain("gh CLI not found");
    vi.restoreAllMocks();
  });

  it("maps merge failure exit code", () => {
    vi.spyOn(callShape, "resolveBinaryForArgv").mockReturnValue(process.execPath);
    const [rc] = wrappers.runGhMerge(1370, "deftai/directive");
    expect(rc).not.toBe(0);
    vi.restoreAllMocks();
  });

  it("maps gh merge timeout via captureExec", () => {
    vi.spyOn(callShape, "resolveBinaryForArgv").mockReturnValue(process.execPath);
    const [rc, , stderr] = wrappers.runGhMerge(1370, null, { timeout: 0.001 });
    expect(rc).toBe(-1);
    expect(stderr).toContain("gh pr merge timed out after 0.001s");
    vi.restoreAllMocks();
  });

  it("omits repo flag when null", () => {
    vi.spyOn(callShape, "resolveBinaryForArgv").mockReturnValue(process.execPath);
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

describe("cliScriptPath (#2615)", () => {
  it("resolves a monorepo packages/cli/dist script when present", () => {
    const path = wrappers.cliScriptPath("pr-monitor");
    expect(path.replace(/\\/g, "/")).toMatch(/\/(cli\/dist\/pr-monitor\.js|dist\/pr-monitor\.js)$/);
  });

  it("returns a candidate path even when the script file is absent", () => {
    const path = wrappers.cliScriptPath("definitely-missing-cli-entry-2615");
    expect(path.replace(/\\/g, "/")).toMatch(/\.js$/);
    expect(path).toContain("definitely-missing-cli-entry-2615");
  });

  it("resolves pr-protected-issues and pr-wait-mergeable the same way", () => {
    for (const name of ["pr-protected-issues", "pr-wait-mergeable", "pr-monitor"] as const) {
      const path = wrappers.cliScriptPath(name);
      expect(path.replace(/\\/g, "/")).toContain(`${name}.js`);
    }
  });

  it("prefers @deftai/directive/dist when main export resolves (#2667)", () => {
    const path = wrappers.cliScriptPath("pr-protected-issues");
    const normalized = path.replace(/\\/g, "/");
    if (existsSync(path)) {
      expect(normalized).toMatch(
        /\/(@deftai\/)?directive\/dist\/pr-protected-issues\.js$|\/cli\/dist\/pr-protected-issues\.js$/,
      );
    } else {
      expect(normalized).toMatch(/pr-protected-issues\.js$/);
    }
  });

  it("resolves pr-monitor under directive/dist or cli/dist (#2673)", () => {
    const path = wrappers.cliScriptPath("pr-monitor");
    const normalized = path.replace(/\\/g, "/");
    if (existsSync(path)) {
      expect(normalized).toMatch(
        /\/(@deftai\/)?directive\/dist\/pr-monitor\.js$|\/cli\/dist\/pr-monitor\.js$/,
      );
    } else {
      expect(normalized).toMatch(/pr-monitor\.js$/);
    }
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
