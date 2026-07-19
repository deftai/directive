import { describe, expect, it } from "vitest";
import { RELEASE_CHECK_TIMEOUT_MS } from "./constants.js";
import { releaseCheckEnv, runReleaseCheck } from "./preflight.js";

describe("releaseCheckEnv", () => {
  it("sets preflight env and scrubs ambient coverage debt", () => {
    const env = releaseCheckEnv({
      base: { DEFT_ALLOW_COVERAGE_DEBT: "999" },
      allowCoverageDebtIssue: null,
    });
    expect(env.DEFT_RELEASE_PREFLIGHT).toBe("1");
    expect(env.DEFT_ALLOW_COVERAGE_DEBT).toBeUndefined();
  });

  it("forwards allow-coverage-debt issue when supplied", () => {
    const env = releaseCheckEnv({ allowCoverageDebtIssue: 2573 });
    expect(env.DEFT_ALLOW_COVERAGE_DEBT).toBe("2573");
  });
});

describe("runReleaseCheck", () => {
  it("returns ok when task check exits 0", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: () => 0,
    });
    expect(ok).toBe(true);
    expect(msg).toContain("task check");
  });

  it("returns timeout message on exit 124 (#2652)", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _proj, seams) => {
        expect(seams?.timeoutMs).toBe(RELEASE_CHECK_TIMEOUT_MS);
        return 124;
      },
    });
    expect(ok).toBe(false);
    expect(msg).toContain("timed out");
    expect(msg).toContain("RELEASING.md");
  });

  it("returns generic failure for other non-zero exits", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: () => 42,
    });
    expect(ok).toBe(false);
    expect(msg).toContain("exit 42");
  });
});
