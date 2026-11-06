import { describe, expect, it } from "vitest";
import { evaluateReleasePromoteLatestGate, runPromoteLatest } from "./pipeline.js";

describe("release-publish --promote-latest (#5852)", () => {
  it("refuses without grant or promote bypass", () => {
    const d = evaluateReleasePromoteLatestGate("0.129.0", process.cwd(), {
      grants: [],
      env: { DEFT_ALLOW_RELEASE_PUBLISH: "1" },
    });
    expect(d.allowed).toBe(false);
  });

  it("allows via DEFT_ALLOW_RELEASE_PROMOTE_LATEST", () => {
    const d = evaluateReleasePromoteLatestGate("0.129.0", process.cwd(), {
      grants: [],
      env: { DEFT_ALLOW_RELEASE_PROMOTE_LATEST: "1" },
    });
    expect(d.allowed).toBe(true);
  });

  it("dry-run dispatches after gate allows", () => {
    expect(
      runPromoteLatest(
        { version: "0.129.0", repo: "deftai/directive", projectRoot: process.cwd(), dryRun: true },
        { closedVerbEnv: { DEFT_ALLOW_RELEASE_PROMOTE_LATEST: "1" } } as never,
      ),
    ).toBe(0);
  });

  it("refuses prerelease versions before dispatch", () => {
    expect(
      runPromoteLatest(
        {
          version: "1.2.3-rc.1",
          repo: "deftai/directive",
          projectRoot: process.cwd(),
          dryRun: true,
        },
        { closedVerbEnv: { DEFT_ALLOW_RELEASE_PROMOTE_LATEST: "1" } } as never,
      ),
    ).toBe(1);
  });

  it("dry-run refuses when gate denies", () => {
    expect(
      runPromoteLatest(
        { version: "0.129.0", repo: "deftai/directive", projectRoot: process.cwd(), dryRun: true },
        { closedVerbEnv: {}, closedVerbGrants: [] } as never,
      ),
    ).toBe(1);
  });
});
