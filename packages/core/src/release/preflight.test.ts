import { describe, expect, it, vi } from "vitest";
import { BRANCH_GATE_BYPASS_ENV, RELEASE_PREFLIGHT_ENV } from "./constants.js";
import { runReleaseCheck } from "./preflight.js";

describe("runReleaseCheck (#2022 Phase 1 native Step-5 pre-flight)", () => {
  it("runs the native TypeScript task check (not ci_local.py) on success", () => {
    const calls: Array<{ frameworkRoot: string; projectRoot: string }> = [];
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: (frameworkRoot, projectRoot) => {
        calls.push({ frameworkRoot, projectRoot });
        return 0;
      },
    });
    expect(ok).toBe(true);
    expect(msg).toContain("native TypeScript task check");
    expect(msg).not.toContain("ci_local");
  });

  it("dispatches in the framework-source context (frameworkRoot === projectRoot)", () => {
    const calls: Array<{ frameworkRoot: string; projectRoot: string }> = [];
    runReleaseCheck("/home/user/deft", {
      dispatchCheck: (frameworkRoot, projectRoot) => {
        calls.push({ frameworkRoot, projectRoot });
        return 0;
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.frameworkRoot).toBe("/home/user/deft");
    expect(calls[0]?.projectRoot).toBe("/home/user/deft");
  });

  it("forwards a non-zero task check exit as a failure", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: () => 42,
    });
    expect(ok).toBe(false);
    expect(msg).toBe("task check failed (exit 42)");
  });

  it("uses the real dispatchTaskCheck default when no dispatch seam is provided", () => {
    // No dispatchCheck seam -> the default dispatchTaskCheck runs for real.
    // A non-existent task binary makes spawnSync error (exit 2), exercising the
    // default-dispatch fallback without actually invoking `task`.
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const [ok, msg] = runReleaseCheck("/tmp/fake-fw", {
      checkSeams: { taskBin: "/absolutely-nonexistent-task-binary-xyz" },
    });
    expect(ok).toBe(false);
    expect(msg).toBe("task check failed (exit 2)");
    errWrite.mockRestore();
  });

  it("passes releaseCheckEnv into dispatchTaskCheck (#2386)", () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _pr, checkSeams) => {
        calls.push({ env: checkSeams?.env });
        return 0;
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env?.[BRANCH_GATE_BYPASS_ENV]).toBe("1");
    expect(calls[0]?.env?.[RELEASE_PREFLIGHT_ENV]).toBe("1");
  });
});
