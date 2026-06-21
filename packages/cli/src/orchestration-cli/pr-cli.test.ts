import { describe, expect, it } from "vitest";
import { dispatch } from "../dispatch.js";
import { run as runClosingKeywords } from "../pr-closing-keywords.js";
import { run as runMergeReadiness } from "../pr-merge-readiness.js";
import { run as runProtectedIssues } from "../pr-protected-issues.js";
import { run as runWaitMergeable } from "../pr-wait-mergeable.js";
import { muteProcessStreams, silentIo } from "./helpers.js";

describe("deft-ts pr:* dispatcher (#1838 s4)", () => {
  it("routes pr orchestration verbs through the dispatcher", async () => {
    expect(await dispatch(["pr-merge-readiness", "--repo", "deftai/directive"], silentIo())).toBe(
      2,
    );
    expect(await dispatch(["pr-protected-issues", "--repo", "deftai/directive"], silentIo())).toBe(
      2,
    );
    expect(await dispatch(["pr-wait-mergeable", "--repo", "deftai/directive"], silentIo())).toBe(2);
    expect(await dispatch(["pr-closing-keywords"], silentIo())).toBe(2);
  });

  it("pr-merge-readiness rejects missing pr number with exit 2", async () => {
    expect(await dispatch(["pr-merge-readiness", "--repo", "deftai/directive"], silentIo())).toBe(
      2,
    );
  });

  it("pr-merge-readiness rejects unknown flags with exit 2", async () => {
    expect(
      await dispatch(
        ["pr-merge-readiness", "1", "--repo", "deftai/directive", "--nope"],
        silentIo(),
      ),
    ).toBe(2);
  });

  it("pr-protected-issues requires --pr with exit 2", async () => {
    expect(await dispatch(["pr-protected-issues", "--repo", "deftai/directive"], silentIo())).toBe(
      2,
    );
  });

  it("pr-wait-mergeable requires pr number with exit 2", async () => {
    expect(await dispatch(["pr-wait-mergeable", "--repo", "deftai/directive"], silentIo())).toBe(2);
  });

  it("pr-closing-keywords wrapper rejects missing input with exit 2", () => {
    expect(muteProcessStreams(() => runClosingKeywords([]))).toBe(2);
  });

  it("CLI wrappers propagate core exit codes for bad argv", () => {
    expect(muteProcessStreams(() => runMergeReadiness(["--json"]))).toBe(2);
    expect(muteProcessStreams(() => runProtectedIssues(["--repo", "deftai/directive"]))).toBe(2);
    expect(muteProcessStreams(() => runWaitMergeable(["--repo", "deftai/directive"]))).toBe(2);
  });
});
