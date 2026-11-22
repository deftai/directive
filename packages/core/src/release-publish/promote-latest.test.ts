import { describe, expect, it, vi } from "vitest";
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

  it("names the searched project root on the [promote-latest] deny line (#6864)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const root = process.cwd();
      expect(
        runPromoteLatest(
          { version: "0.129.0", repo: "deftai/directive", projectRoot: root, dryRun: true },
          { closedVerbEnv: {}, closedVerbGrants: [] } as never,
        ),
      ).toBe(1);
      const deny = spy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.startsWith("[promote-latest] denied code="));
      expect(deny).toBeDefined();
      expect(deny).toContain(`projectRoot=${root}\n`);
    } finally {
      spy.mockRestore();
    }
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
