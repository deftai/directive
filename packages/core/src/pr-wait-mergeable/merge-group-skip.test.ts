import { describe, expect, it } from "vitest";
import {
  isMergeGroupEvent,
  MERGE_GROUP_CHANGE_SET_CHECKS,
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

  it("names exactly the skipped checks (#6295 three, #6296 changelog, #7147 class checks)", () => {
    expect([...MERGE_GROUP_SKIPPED_CHECKS]).toEqual([
      "verify:closing-keywords",
      "verify:scope-provenance",
      "verify:intent-constraint",
      "verify:changelog-unreleased",
      "verify:class-checks",
    ]);
    expect([...MERGE_GROUP_CHANGE_SET_CHECKS]).toEqual([
      "verify:changelog-unreleased",
      "verify:class-checks",
    ]);
  });

  it("gives change-set checks their own reason and never says the check already ran (#7147)", () => {
    for (const check of MERGE_GROUP_CHANGE_SET_CHECKS) {
      const notice = mergeGroupSkipNotice(check);
      expect(notice).toContain(`${check}: skipped on merge_group`);
      expect(notice).toContain("change-set check");
      expect(notice).toContain("every PR queued ahead");
      expect(notice).toContain("runs on the PR head instead");
      expect(notice).not.toMatch(/already ran|PR-context/);
    }
  });

  it("keeps the three PR-context notices unchanged", () => {
    for (const check of [
      "verify:closing-keywords",
      "verify:scope-provenance",
      "verify:intent-constraint",
    ] as const) {
      expect(mergeGroupSkipNotice(check)).toBe(
        `${check}: skipped on merge_group (#6295) -- PR-context check; ` +
          "it ran on the PR head and body at the PR's last CI run.",
      );
    }
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
