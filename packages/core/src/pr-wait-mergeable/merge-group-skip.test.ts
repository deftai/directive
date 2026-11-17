import { describe, expect, it } from "vitest";
import {
  isMergeGroupEvent,
  MERGE_GROUP_SKIPPED_CHECKS,
  mergeGroupSkip,
  mergeGroupSkipNotice,
} from "./merge-group-skip.js";

describe("merge_group skip (#6295 item 2)", () => {
  it("detects only the merge_group event", () => {
    expect(isMergeGroupEvent({ GITHUB_EVENT_NAME: "merge_group" })).toBe(true);
    expect(isMergeGroupEvent({ GITHUB_EVENT_NAME: " merge_group " })).toBe(true);
    expect(isMergeGroupEvent({ GITHUB_EVENT_NAME: "pull_request" })).toBe(false);
    expect(isMergeGroupEvent({ GITHUB_EVENT_NAME: "push" })).toBe(false);
    expect(isMergeGroupEvent({})).toBe(false);
  });

  it("names exactly the PR-context checks (#6295 three, #6296 changelog)", () => {
    expect([...MERGE_GROUP_SKIPPED_CHECKS]).toEqual([
      "verify:closing-keywords",
      "verify:scope-provenance",
      "verify:intent-constraint",
      "verify:changelog-unreleased",
    ]);
  });

  it("returns a notice on merge_group and null elsewhere", () => {
    for (const check of MERGE_GROUP_SKIPPED_CHECKS) {
      expect(mergeGroupSkip(check, { GITHUB_EVENT_NAME: "merge_group" })).toBe(
        mergeGroupSkipNotice(check),
      );
      expect(mergeGroupSkip(check, { GITHUB_EVENT_NAME: "pull_request" })).toBeNull();
    }
    expect(mergeGroupSkipNotice("verify:scope-provenance")).toContain("skipped on merge_group");
  });
});
