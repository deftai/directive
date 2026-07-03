import { describe, expect, it } from "vitest";
import { computeGateResult } from "./compute.js";
import type { RunGhFn } from "./types.js";

const HEAD = "abc1234567890def1234567890abcdef12345678";
const OLD = "1111111111111111111111111111111111111111";

const GREEN_CHECKS = JSON.stringify({
  check_runs: [
    { name: "TypeScript (build + lint + test)", status: "completed", conclusion: "success" },
  ],
});

function cleanGreptileBody(sha: string): string {
  return (
    "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
    `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${sha})\n`
  );
}

interface FakeOpts {
  readonly commentBody?: string;
  readonly mergeableState?: string;
  readonly mergeable?: boolean | null;
  readonly checks?: string;
}

function fakeRunGh(opts: FakeOpts): RunGhFn {
  const checks = opts.checks ?? GREEN_CHECKS;
  return (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("headRefOid")) {
      return { returncode: 0, stdout: `${HEAD}\n`, stderr: "" };
    }
    if (joined.includes("/comments")) {
      return { returncode: 0, stdout: opts.commentBody ?? "", stderr: "" };
    }
    if (joined.includes("/check-runs")) {
      return { returncode: 0, stdout: checks, stderr: "" };
    }
    if (joined.includes("/pulls/")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          state: "open",
          merged: false,
          mergeable: opts.mergeable ?? true,
          mergeable_state: opts.mergeableState ?? "clean",
          head: { sha: HEAD },
        }),
        stderr: "",
      };
    }
    return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}

describe("computeGateResult #2260 reconciliation", () => {
  it("merges when verdict is ABSENT but GitHub is CLEAN + MERGEABLE", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "clean", mergeable: true }),
    );
    expect(result.via).toBe("primary");
    expect(result.failures).toEqual([]);
    const override = (result.partialData as Record<string, unknown>).verdict_override as Record<
      string,
      unknown
    >;
    expect(override.reason).toBe("verdict-absent");
    const mergeability = (result.partialData as Record<string, unknown>).mergeability as Record<
      string,
      unknown
    >;
    expect(mergeability.mergeable_state).toBe("clean");
  });

  it("merges when verdict is STALE (rebased head SHA) but GitHub is CLEAN", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(OLD), mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures).toEqual([]);
    const override = (result.partialData as Record<string, unknown>).verdict_override as Record<
      string,
      unknown
    >;
    expect(override.reason).toBe("verdict-stale-head-sha");
  });

  it("does NOT merge when verdict absent but GitHub is UNSTABLE (not clean)", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "unstable", mergeable: true }),
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
    const mergeability = (result.partialData as Record<string, unknown>).mergeability as Record<
      string,
      unknown
    >;
    expect(mergeability.mergeable_state).toBe("unstable");
  });

  it("does NOT merge a genuine P0/P1 on the current head even when GitHub is CLEAN", () => {
    const body =
      "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
      `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n` +
      '### P0 findings (1)\n<img alt="P0" />\n';
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: body, mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("respects disableMergeabilityReconcile", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "clean", mergeable: true }),
      { disableMergeabilityReconcile: true },
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("clean canonical verdict + green CI still merges via existing path", () => {
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: cleanGreptileBody(HEAD), mergeableState: "clean", mergeable: true }),
    );
    expect(result.failures).toEqual([]);
    // No override needed — the verdict itself was clean.
    expect((result.partialData as Record<string, unknown>).verdict_override).toBeUndefined();
  });

  it("uses injectable fetchMergeabilityFn seam", () => {
    let called = false;
    const result = computeGateResult(
      2258,
      "deftai/directive",
      fakeRunGh({ commentBody: "", mergeableState: "unstable", mergeable: false }),
      {
        fetchMergeabilityFn: () => {
          called = true;
          return { mergeableState: "clean", mergeable: true, error: null };
        },
      },
    );
    expect(called).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
