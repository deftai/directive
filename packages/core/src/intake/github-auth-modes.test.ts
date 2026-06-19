import { describe, expect, it } from "vitest";
import {
  FAILURE_INVALID_MODE,
  findInjectedToken,
  inferGithubAuthMode,
  validateGithubAuth,
} from "./github-auth-modes.js";
import { RUNTIME_MODE_CLOUD_HEADLESS } from "./platform-capabilities.js";

describe("github-auth-modes", () => {
  it("finds injected token env vars", () => {
    expect(findInjectedToken({ GH_TOKEN: "secret" })).toBe("secret");
    expect(findInjectedToken({})).toBeNull();
  });

  it("infers injected-token for cloud headless", () => {
    expect(inferGithubAuthMode({ runtimeMode: RUNTIME_MODE_CLOUD_HEADLESS })).toBe(
      "injected-token",
    );
  });

  it("rejects unknown auth mode", () => {
    const result = validateGithubAuth("bogus", { environ: {} });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INVALID_MODE);
  });

  it("validates host-gh with stub runner", () => {
    const result = validateGithubAuth("host-gh", {
      environ: {},
      runGh: () => ({ returncode: 0, stdout: '{"login":"octo"}', stderr: "", args: [] }),
    });
    expect(result.ok).toBe(true);
  });
});
