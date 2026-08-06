import { describe, expect, it } from "vitest";
import {
  BODY_AC4_MARKDOWN_LINK_CLEAN,
  BODY_TIER2_P1_ONLY,
} from "../content-contracts/skills/greptile-detector.js";
import { GREPTILE_ERRORED_SENTINEL } from "../pr-merge-readiness/constants.js";
import type { RunGhResult } from "../pr-merge-readiness/types.js";
import { probeOnce } from "./probe.js";

/** The last_reviewed sha embedded in the BODY_AC4_* / BODY_TIER2_P1_ONLY fixtures. */
const FIXTURE_SHA = "abcdef1234567";
const OTHER_SHA = "9999999deadbee";

interface FakeGhConfig {
  headSha?: string | null;
  body?: string;
  checkRuns?: unknown[];
  headError?: boolean;
}

/** Route the canonical pr-merge-readiness gh calls to canned responses. */
function makeFakeGh(cfg: FakeGhConfig) {
  const ok = (stdout: string): RunGhResult => ({ returncode: 0, stdout, stderr: "" });
  const fail = (stderr: string): RunGhResult => ({ returncode: 1, stdout: "", stderr });
  return (cmd: readonly string[]): RunGhResult => {
    const joined = cmd.join(" ");
    if (cmd[1] === "pr" && cmd[2] === "view") {
      if (cfg.headError === true) return fail("no such PR");
      return ok(cfg.headSha === null ? "" : `${cfg.headSha ?? FIXTURE_SHA}\n`);
    }
    if (joined.includes("/pulls/")) {
      // REST HEAD fallback.
      if (cfg.headError === true) return fail("no such PR (REST)");
      return ok(JSON.stringify({ head: { sha: cfg.headSha ?? FIXTURE_SHA } }));
    }
    if (joined.includes("/issues/") && joined.includes("/comments") && joined.includes("--jq")) {
      return ok(cfg.body ?? "");
    }
    if (joined.includes("/commits/") && joined.includes("/check-runs")) {
      return ok(JSON.stringify({ check_runs: cfg.checkRuns ?? [] }));
    }
    return fail(`unexpected gh call: ${joined}`);
  };
}

const GREEN_CI = [
  { name: "TypeScript (build + lint + test)", status: "completed", conclusion: "success" },
];

describe("probeOnce (canonical greptile-detector integration)", () => {
  it("CLEAN body on a matching HEAD -> isClean, no blocking", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: GREEN_CI,
      }),
    );
    expect(probe.error).toBeNull();
    expect(probe.shaMatch).toBe(true);
    expect(probe.isClean).toBe(true);
    expect(probe.hasBlocking).toBe(false);
    expect(probe.confidence).toBe(5);
    expect(probe.ciReadyState).toBe("ready");
  });

  it("empty check-runs with clean Greptile -> ci_never_scheduled, not CLEAN (#3167)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: BODY_AC4_MARKDOWN_LINK_CLEAN, checkRuns: [] }),
    );
    expect(probe.ciReadyState).toBe("ci_never_scheduled");
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("ci_never_scheduled");
  });

  it("P1 findings on a matching HEAD -> hasBlocking, sha-matched, not clean", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: BODY_TIER2_P1_ONLY }),
    );
    expect(probe.hasBlocking).toBe(true);
    expect(probe.p1Count).toBeGreaterThanOrEqual(1);
    expect(probe.shaMatch).toBe(true);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("has_blocking");
  });

  it("clean body but HEAD moved past the review -> sha_match false, not clean (stale-review guard)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: OTHER_SHA, body: BODY_AC4_MARKDOWN_LINK_CLEAN }),
    );
    expect(probe.shaMatch).toBe(false);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("sha_match");
    expect(probe.found).toBe(true);
  });

  it("errored sentinel body -> errored true", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: GREPTILE_ERRORED_SENTINEL }),
    );
    expect(probe.errored).toBe(true);
    expect(probe.isClean).toBe(false);
  });

  it("empty body -> found false", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({ headSha: FIXTURE_SHA, body: "" }),
    );
    expect(probe.found).toBe(false);
    expect(probe.isClean).toBe(false);
  });

  it("failed CI check-run -> ci_failures counted, blocks clean", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
      }),
    );
    expect(probe.ciFailures).toBe(1);
    expect(probe.isClean).toBe(false);
    expect(probe.cleanGateHoldout).toBe("ci_failures");
    expect(probe.ciReadyState).toBe("ci_failures");
  });

  it("cancelled primary without green sibling -> ci_cancelled_no_failover (#3167)", () => {
    const probe = probeOnce(
      1056,
      "deftai/directive",
      makeFakeGh({
        headSha: FIXTURE_SHA,
        body: BODY_AC4_MARKDOWN_LINK_CLEAN,
        checkRuns: [
          {
            name: "TypeScript (blacksmith primary)",
            status: "completed",
            conclusion: "cancelled",
          },
        ],
      }),
    );
    expect(probe.ciReadyState).toBe("ci_cancelled_no_failover");
    expect(probe.isClean).toBe(false);
  });

  it("unresolvable HEAD -> config error probe", () => {
    const probe = probeOnce(1056, "deftai/directive", makeFakeGh({ headError: true }));
    expect(probe.error).not.toBeNull();
    expect(probe.headSha).toBeNull();
  });

  it("cannot resolve repo -> config error probe (no --repo, gh repo view fails)", () => {
    const gh = (cmd: readonly string[]): RunGhResult => {
      if (cmd[1] === "repo" && cmd[2] === "view") {
        return { returncode: 1, stdout: "", stderr: "not a repo" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const probe = probeOnce(1056, null, gh);
    expect(probe.error).toContain("could not resolve repo");
  });
});
