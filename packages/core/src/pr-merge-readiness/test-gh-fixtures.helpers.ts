/**
 * Test-only gh doubles for pr-monitor / merge-readiness suites (#2652).
 * Not part of the production CLI surface; excluded from coverage via `*.helpers.ts`.
 */
import type { RunGhFn } from "./types.js";

/** Empty GraphQL reviewThreads page for inline Greptile findings (#2620 / #2652). */
export const EMPTY_REVIEW_THREADS_GRAPHQL = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  },
});

/** Prepend a graphql reviewThreads stub to any hermetic runGh test double. */
export function withGraphqlInlineStub(runGh: RunGhFn): RunGhFn {
  return (cmd) => {
    if (cmd.join(" ").includes("graphql")) {
      return { returncode: 0, stdout: EMPTY_REVIEW_THREADS_GRAPHQL, stderr: "" };
    }
    return runGh(cmd);
  };
}

export interface FakeRunGhOptions {
  readonly headSha?: string;
  readonly headOk?: boolean;
  readonly commentsBody?: string;
  readonly commentsOk?: boolean;
}

/** Hermetic runGh stub for monitor / merge-readiness unit tests (#2260 / #2652). */
export function fakeRunGhForMonitor(options: FakeRunGhOptions = {}): RunGhFn {
  const headSha = options.headSha ?? "abc1234567890def1234567890abcdef12345678";
  const headOk = options.headOk ?? true;
  const commentsOk = options.commentsOk ?? true;
  const commentsBody = options.commentsBody ?? "";

  return (cmd) => {
    if (!headOk) {
      return { returncode: 1, stdout: "", stderr: "all-down" };
    }
    const joined = cmd.join(" ");
    if (joined.includes("graphql")) {
      return { returncode: 0, stdout: EMPTY_REVIEW_THREADS_GRAPHQL, stderr: "" };
    }
    if (joined.includes("headRefOid")) {
      return { returncode: 0, stdout: `${headSha}\n`, stderr: "" };
    }
    if (joined.includes("/comments")) {
      return commentsOk
        ? { returncode: 0, stdout: commentsBody, stderr: "" }
        : { returncode: 1, stdout: "", stderr: "boom" };
    }
    if (joined.includes("/check-runs")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          check_runs: [
            {
              name: "TypeScript (build + lint + test)",
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (joined.includes("/rules/branches/") || joined.includes("/protection")) {
      return { returncode: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    }
    if (joined.includes("/pulls/")) {
      return {
        returncode: 0,
        stdout: JSON.stringify({
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { sha: headSha },
          base: { ref: "master" },
        }),
        stderr: "",
      };
    }
    return { returncode: 1, stdout: "", stderr: `unexpected: ${joined}` };
  };
}
