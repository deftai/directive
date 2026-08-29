import { describe, expect, it } from "vitest";
import { resolveCaptureFailureStderr, SUBPROCESS_MAX_BUFFER } from "./max-buffer.js";

describe("SUBPROCESS_MAX_BUFFER", () => {
  it("sits well above Node's 1 MB default", () => {
    expect(SUBPROCESS_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });
});

describe("resolveCaptureFailureStderr (#3903)", () => {
  it("stands in the error message for a spawnSync overflow", () => {
    // Observed shape of an ENOBUFS abort: no status, empty stderr, reason only
    // on the error.
    expect(
      resolveCaptureFailureStderr({
        captured: "",
        status: null,
        message: "spawnSync ghx ENOBUFS",
      }),
    ).toBe("spawnSync ghx ENOBUFS");
  });

  it("stands in the error message for an execFileSync throw with no status", () => {
    expect(
      resolveCaptureFailureStderr({
        captured: "",
        status: undefined,
        message: "spawnSync git ENOBUFS",
      }),
    ).toBe("spawnSync git ENOBUFS");
  });

  it("keeps empty stderr when the process exited with a status", () => {
    // A quiet non-zero exit chose to say nothing; "Command failed: ..." would
    // invent a reason the process never gave.
    expect(
      resolveCaptureFailureStderr({
        captured: "",
        status: 3,
        message: "Command failed: git rev-parse --verify -q missing",
      }),
    ).toBe("");
  });

  it("keeps whitespace-only stderr from a status exit", () => {
    expect(resolveCaptureFailureStderr({ captured: "  \n", status: 1, message: "boom" })).toBe(
      "  \n",
    );
  });

  it("keeps captured stderr over the error message", () => {
    expect(
      resolveCaptureFailureStderr({
        captured: "fatal: not a git repository",
        status: null,
        message: "Command failed",
      }),
    ).toBe("fatal: not a git repository");
  });

  it("returns the captured value when no message is available", () => {
    expect(
      resolveCaptureFailureStderr({ captured: "", status: undefined, message: undefined }),
    ).toBe("");
  });
});
