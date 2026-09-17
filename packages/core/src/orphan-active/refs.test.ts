import { describe, expect, it } from "vitest";
import { collectGithubRefs } from "./refs.js";

const PR_URI = "https://github.com/deftai/directive-training/pull/5";
const ISSUE_URI = "https://github.com/deftai/directive/issues/4698";

describe("collectGithubRefs reserved subtypes (#4698)", () => {
  it("reports pull-request and does not collect it as a PR", () => {
    const { issues, prs, unknownReserved } = collectGithubRefs(
      {
        references: [{ uri: PR_URI, type: "x-xbrief/pull-request" }],
      },
      "deftai/directive-training",
    );
    expect(issues).toEqual([]);
    expect(prs).toEqual([]);
    expect(unknownReserved).toEqual([
      {
        type: "x-xbrief/pull-request",
        uri: PR_URI,
        nearestCanonical: "x-xbrief/github-pr",
      },
    ]);
  });

  it("still matches github-pr", () => {
    const { prs, unknownReserved } = collectGithubRefs(
      {
        references: [{ uri: PR_URI, type: "x-xbrief/github-pr" }],
      },
      "deftai/directive-training",
    );
    expect(prs).toEqual([{ repo: "deftai/directive-training", number: 5 }]);
    expect(unknownReserved).toEqual([]);
  });

  it("keeps engine-written closes and current-shape valid (not unknown)", () => {
    const { issues, prs, unknownReserved } = collectGithubRefs(
      {
        references: [
          { uri: ISSUE_URI, type: "x-xbrief/closes" },
          {
            uri: "https://github.com/deftai/directive/issues/4698#issuecomment-1",
            type: "x-xbrief/current-shape",
          },
        ],
      },
      "deftai/directive",
    );
    expect(issues).toEqual([]);
    expect(prs).toEqual([]);
    expect(unknownReserved).toEqual([]);
  });

  it("reports pull-request in a mixed github-issue plus pull-request plan", () => {
    const { issues, prs, unknownReserved } = collectGithubRefs(
      {
        references: [
          { uri: ISSUE_URI, type: "x-xbrief/github-issue" },
          { uri: PR_URI, type: "x-xbrief/pull-request" },
        ],
      },
      "deftai/directive",
    );
    expect(issues).toEqual([{ repo: "deftai/directive", number: 4698 }]);
    expect(prs).toEqual([]);
    expect(unknownReserved).toEqual([
      {
        type: "x-xbrief/pull-request",
        uri: PR_URI,
        nearestCanonical: "x-xbrief/github-pr",
      },
    ]);
  });
});
