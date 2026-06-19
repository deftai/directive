import { describe, expect, it } from "vitest";
import { computeGateResult } from "./compute.js";
import {
  CONFIDENCE_RE,
  GREPTILE_ERRORED_SENTINEL,
  INFORMAL_CLEAN_DIAGNOSTIC,
  VIA_FALLBACK1,
  VIA_FALLBACK2,
  VIA_PRIMARY,
} from "./constants.js";
import { evaluateGates } from "./evaluate.js";
import { emptyVerdict, isInformalCleanMissingCanonicalFields, parseGreptileBody } from "./parse.js";
import type { GreptileVerdict, RunGhFn } from "./types.js";

const HEAD = "abc1234567890def1234567890abcdef12345678";

function cleanBody(sha = HEAD, confidence = 5): string {
  return (
    "## Greptile Summary\n\n" +
    "No P0 or P1 issues found in this PR.\n\n" +
    `**Confidence Score: ${confidence}/5**\n\n` +
    `Last reviewed commit: [chore](https://github.com/deftai/directive/commit/${sha})\n`
  );
}

function verdict(overrides: Partial<GreptileVerdict> = {}): GreptileVerdict {
  return { ...emptyVerdict(), found: true, lastReviewedSha: HEAD, confidence: 5, ...overrides };
}

describe("parseGreptileBody", () => {
  it("returns not-found for empty and whitespace bodies", () => {
    for (const body of ["", "\n", "\n\n\n\n", "   ", "\t", " \n \t \n "]) {
      const v = parseGreptileBody(body);
      expect(v.found).toBe(false);
      expect(v.lastReviewedSha).toBeNull();
      expect(v.confidence).toBeNull();
    }
  });

  it("parses clean body fields", () => {
    const sha = "deadbeef1234567890deadbeef1234567890abcd";
    const v = parseGreptileBody(cleanBody(sha, 5));
    expect(v.found).toBe(true);
    expect(v.errored).toBe(false);
    expect(v.lastReviewedSha).toBe(sha);
    expect(v.confidence).toBe(5);
    expect(v.p0Count).toBe(0);
    expect(v.p1Count).toBe(0);
  });

  it("does not false-positive P0/P1 from clean summary prose", () => {
    const v = parseGreptileBody(cleanBody());
    expect(v.p0Count).toBe(0);
    expect(v.p1Count).toBe(0);
  });

  it("counts badge findings", () => {
    const body =
      '<img alt="P0" src="x"> a\n<img alt="P1" src="x"> b\n<img alt="P2" src="x"> c\n' +
      `**Confidence Score: 2/5**\n\n` +
      `Last reviewed commit: [x](https://github.com/o/r/commit/aaaaaaa)\n`;
    const v = parseGreptileBody(body);
    expect(v.p0Count).toBe(1);
    expect(v.p1Count).toBe(1);
    expect(v.p2Count).toBe(1);
    expect(v.confidence).toBe(2);
  });

  it("uses section heading fallback without badges", () => {
    const body =
      "### P0 findings (0)\n\n### P1 findings (1)\n\n### P2 findings (5)\n\n" +
      "**Confidence Score: 4/5**\n\n" +
      "Last reviewed commit: [x](https://github.com/o/r/commit/bbbbbbb)\n";
    const v = parseGreptileBody(body);
    expect(v.p1Count).toBe(1);
    expect(v.p2Count).toBe(5);
  });

  it("detects errored sentinel", () => {
    expect(parseGreptileBody(GREPTILE_ERRORED_SENTINEL).errored).toBe(true);
  });

  it("takes last SHA match not first", () => {
    const body =
      "quoted: Last reviewed commit: [x](https://github.com/o/r/commit/bbbbbbb)\n" +
      "**Confidence Score: 4/5**\n\n" +
      "<sub>Last reviewed commit: [real](https://github.com/o/r/commit/d65eb9f41c2bfd8c)</sub>\n";
    expect(parseGreptileBody(body).lastReviewedSha).toBe("d65eb9f41c2bfd8c");
  });

  it("skips heading fallback when details format present", () => {
    const body =
      "<details><summary>Summary</summary>\n\nNo P0 or P1 issues found.\n\n" +
      '```python\nbody = "### P1 findings (1)\\n"\n```\n\n' +
      "**Confidence Score: 5/5**\n\n</details>\n\n" +
      "<sub>Last reviewed commit: [fix](https://github.com/o/r/commit/85c0b1de994a)</sub>\n";
    const v = parseGreptileBody(body);
    expect(v.p1Count).toBe(0);
    expect(v.lastReviewedSha).toBe("85c0b1de994a");
  });

  it("detects informal clean missing canonical fields", () => {
    const body =
      "Both previously flagged issues are now resolved.\n\n" +
      "The current diff is clean. looks solid. Good to proceed.\n";
    const v = parseGreptileBody(body);
    expect(v.informalClean).toBe(true);
  });

  it("isInformalClean helper respects canonical fields", () => {
    const v = parseGreptileBody(cleanBody());
    expect(isInformalCleanMissingCanonicalFields(v, cleanBody())).toBe(false);
  });
});

describe("evaluateGates", () => {
  it("passes when all gates clean", () => {
    expect(evaluateGates(1, HEAD, verdict())).toEqual([]);
  });

  it("fails when no greptile comment", () => {
    const failures = evaluateGates(
      1,
      HEAD,
      verdict({ found: false, lastReviewedSha: null, confidence: null }),
    );
    expect(failures.some((f) => f.includes("No Greptile rolling-summary"))).toBe(true);
  });

  it("fails on errored state", () => {
    expect(
      evaluateGates(1, HEAD, verdict({ errored: true })).some((f) => f.includes("ERRORED")),
    ).toBe(true);
  });

  it("fails on stale sha", () => {
    expect(
      evaluateGates(
        1,
        "bbbbbbb00000000000000000000000000000000",
        verdict({ lastReviewedSha: "aaaaaaa" }),
      ).some((f) => f.includes("stale")),
    ).toBe(true);
  });

  it("allows short sha prefix match", () => {
    expect(evaluateGates(1, HEAD, verdict({ lastReviewedSha: "abc1234" }))).toEqual([]);
  });

  it("fails on low confidence", () => {
    expect(
      evaluateGates(1, HEAD, verdict({ confidence: 3 })).some((f) =>
        f.includes("confidence is 3/5"),
      ),
    ).toBe(true);
  });

  it("passes confidence 4", () => {
    expect(evaluateGates(1, HEAD, verdict({ confidence: 4 }))).toEqual([]);
  });

  it("fails on P1 findings", () => {
    expect(
      evaluateGates(1, HEAD, verdict({ p1Count: 1 })).some((f) => f.includes("P1 findings")),
    ).toBe(true);
  });

  it("passes P2-only", () => {
    expect(evaluateGates(1, HEAD, verdict({ p2Count: 5 }))).toEqual([]);
  });

  it("emits informal clean diagnostic", () => {
    const failures = evaluateGates(
      1,
      HEAD,
      verdict({ informalClean: true, lastReviewedSha: null, confidence: null }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(INFORMAL_CLEAN_DIAGNOSTIC.slice(0, 40));
    expect(failures[0]).toContain("@greptileai review");
  });
});

describe("computeGateResult layered fallbacks", () => {
  function installFakeGh(
    responses: Record<string, { returncode: number; stdout?: string; stderr?: string }>,
  ): RunGhFn {
    const classify = (cmd: readonly string[]): string => {
      const joined = cmd.join(" ");
      if (joined.includes("nameWithOwner")) return "repo-view";
      if (joined.includes("headRefOid")) return "head-sha";
      if (joined.includes("/check-runs")) return "check-runs";
      if (joined.includes("/pulls/") && !joined.includes("/comments")) return "pr-view-rest";
      if (joined.includes("/issues/") && joined.includes("/comments") && cmd.includes("--jq"))
        return "comments-jq";
      if (joined.includes("/issues/") && joined.includes("/comments")) return "comments-rest";
      return "unknown";
    };
    return (cmd) => {
      const label = classify(cmd);
      const resp = responses[label] ?? { returncode: 1, stderr: `unexpected ${label}` };
      return {
        returncode: resp.returncode,
        stdout: resp.stdout ?? "",
        stderr: resp.stderr ?? "",
      };
    };
  }

  it("primary clean via primary", () => {
    const result = computeGateResult(
      1363,
      "deftai/directive",
      installFakeGh({
        "head-sha": { returncode: 0, stdout: `${HEAD}\n` },
        "comments-jq": { returncode: 0, stdout: cleanBody() },
      }),
    );
    expect(result.via).toBe(VIA_PRIMARY);
    expect(result.failures).toEqual([]);
    expect(result.headSha).toBe(HEAD);
  });

  it("primary blocked stays primary", () => {
    const result = computeGateResult(
      1363,
      "deftai/directive",
      installFakeGh({
        "head-sha": { returncode: 0, stdout: `${HEAD}\n` },
        "comments-jq": { returncode: 0, stdout: cleanBody(HEAD, 3) },
      }),
    );
    expect(result.via).toBe(VIA_PRIMARY);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("fallback1 when jq fails", () => {
    const rest = JSON.stringify([{ user: { login: "greptile-apps[bot]" }, body: cleanBody() }]);
    const result = computeGateResult(
      1363,
      "deftai/directive",
      installFakeGh({
        "head-sha": { returncode: 0, stdout: `${HEAD}\n` },
        "comments-jq": { returncode: 1, stderr: "rate-limited" },
        "comments-rest": { returncode: 0, stdout: rest },
      }),
    );
    expect(result.via).toBe(VIA_FALLBACK1);
    expect(result.failures).toEqual([]);
    expect(result.partialData.primary_error).toBeDefined();
  });

  it("fallback2 never clean", () => {
    const result = computeGateResult(
      1363,
      "deftai/directive",
      installFakeGh({
        "head-sha": { returncode: 0, stdout: `${HEAD}\n` },
        "comments-jq": { returncode: 1 },
        "comments-rest": { returncode: 1 },
        "pr-view-rest": {
          returncode: 0,
          stdout: JSON.stringify({
            state: "open",
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: HEAD },
          }),
        },
        "check-runs": {
          returncode: 0,
          stdout: JSON.stringify({
            check_runs: [{ name: "Greptile Review", status: "completed", conclusion: "success" }],
          }),
        },
      }),
    );
    expect(result.via).toBe(VIA_FALLBACK2);
    expect(result.failures.some((f) => f.includes("fallback2 is a coarse signal"))).toBe(true);
  });

  it("total failure returns via error", () => {
    const result = computeGateResult(
      1363,
      "deftai/directive",
      installFakeGh({
        "head-sha": { returncode: 1, stderr: "down" },
        "pr-view-rest": { returncode: 1, stderr: "down" },
      }),
    );
    expect(result.via).toBe("error");
    expect(result.error).toBeTruthy();
    expect(result.partialData.primary_error).toBeDefined();
  });
});

describe("constants regex sanity", () => {
  it("confidence regex is case-insensitive", () => {
    expect(CONFIDENCE_RE.test("confidence score: 4 / 5")).toBe(true);
  });
});
