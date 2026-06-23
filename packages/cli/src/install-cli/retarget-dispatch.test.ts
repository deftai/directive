/**
 * Wave 8.5 s7 — retarget specs for install/migrate CLI tail tests whose
 * underlying surfaces survive on the deft-ts dispatcher (#1838 Bucket C).
 *
 * Python parity oracles stay in tests/cli/ until Wave 9 (#1731).
 */
import { runToolchainCheck } from "@deftai/directive-core/verify-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch, resetHandlerCacheForTests, resolveCanonicalVerb } from "../dispatch.js";

afterEach(() => {
  resetHandlerCacheForTests();
  vi.restoreAllMocks();
});

describe("retarget: toolchain-check (tests/cli/test_task_scripts.py TestToolchainCheck)", () => {
  it("exits 1 when tools are missing (mirrors test_missing_tool_exits_nonzero)", () => {
    const result = runToolchainCheck(() => ({ error: "not-found", message: "" }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("Missing tools:");
    expect(result.lines.join("\n")).toContain("NOT FOUND");
  });

  it("exits 0 when every tool reports a version (mirrors test_happy_path_all_tools_present)", () => {
    const result = runToolchainCheck(() => ({
      returncode: 0,
      stdout: "tool v1.0.0\n",
      stderr: "",
    }));
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("All required tools available");
  });

  it("reports missing tool names in output (mirrors test_missing_tool_reports_name)", () => {
    let call = 0;
    const result = runToolchainCheck(
      (_command) => {
        call += 1;
        if (call === 1) {
          return { returncode: 0, stdout: "ok\n", stderr: "" };
        }
        return { error: "not-found", message: "" };
      },
      [
        { name: "go", command: ["go", "version"] },
        { name: "uv", command: ["uv", "--version"] },
      ],
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("uv: NOT FOUND");
  });

  it("deft-ts toolchain-check propagates exit 1 from the handler", async () => {
    const handler = vi.fn(() => 1);
    vi.doMock("../toolchain-check.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    const code = await dispatch(["toolchain-check"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("resolves task-style toolchain:check alias to toolchain-check", () => {
    expect(resolveCanonicalVerb("toolchain:check")).toBe("toolchain-check");
  });

  it("deft-ts toolchain:check alias dispatches the same handler", async () => {
    const handler = vi.fn(() => 0);
    vi.doMock("../toolchain-check.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    const code = await dispatch(["toolchain:check"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("retarget: doctor (tests/cli/test_cmd_doctor.py)", () => {
  it("deft-ts doctor routes argv through the doctor CLI module", async () => {
    const handler = vi.fn(() => 0);
    vi.doMock("../doctor.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    const code = await dispatch(["doctor", "--session", "--json"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(handler).toHaveBeenCalledWith(["--session", "--json"]);
  });

  it("deft-ts doctor alias propagates non-zero exit codes", async () => {
    const handler = vi.fn(() => 3);
    vi.doMock("../doctor.js", () => ({ run: handler }));
    resetHandlerCacheForTests();

    const code = await dispatch(["doctor"], {
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(code).toBe(3);
  });

  it("resolveCanonicalVerb maps doctor to itself", () => {
    expect(resolveCanonicalVerb("doctor")).toBe("doctor");
  });
});
