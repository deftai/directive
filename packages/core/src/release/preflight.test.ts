import { describe, expect, it } from "vitest";
import {
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
  resolveProductFirstCheckMode,
} from "../product-first-done-gate/index.js";
import { SKIP_NOTICE } from "../ts-check-lane/run-lane.js";
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

  it("pins DEFT_CHECK_MODE=full and deletes AC-only and hygiene-advisory (#4230)", () => {
    const env = releaseCheckEnv({
      base: {
        [ENV_CHECK_MODE]: "rapid",
        [ENV_CHECK_AC_ONLY]: "1",
        [ENV_HYGIENE_ADVISORY]: "1",
      },
    });
    expect(env[ENV_CHECK_MODE]).toBe("full");
    expect(env[ENV_CHECK_AC_ONLY]).toBeUndefined();
    expect(env[ENV_HYGIENE_ADVISORY]).toBeUndefined();
    const resolved = resolveProductFirstCheckMode({
      environ: env,
      ceremonyDepth: "rapid",
      hardBudgetDetected: true,
    });
    expect(resolved.mode).toBe("full");
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

  it("does not treat SKIP_NOTICE plus status run as suite-ran", () => {
    const [ok, msg] = runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _proj, seams) => {
        seams?.onCheckComplete?.({
          exitCode: 0,
          gates: [{ id: "ts:check-lane", status: "run", exit_code: 0 }],
          suiteTeeText: SKIP_NOTICE,
        });
        return 0;
      },
    });
    expect(ok).toBe(false);
    expect(msg).toMatch(/did not run|SKIP_NOTICE/);
  });

  it("stamps a successful full-suite when the collector reports run without SKIP_NOTICE", () => {
    const [ok] = runReleaseCheck("/proj", {
      dispatchCheck: (_fw, _proj, seams) => {
        seams?.onCheckComplete?.({
          exitCode: 0,
          gates: [{ id: "ts:check-lane", status: "run", exit_code: 0 }],
          suiteTeeText: "Tests  12 passed\n",
        });
        return 0;
      },
    });
    expect(ok).toBe(true);
  });
});
