import { describe, expect, it } from "vitest";
import {
  extractReferencesFromVbrief,
  formatMarkdown,
  IssueState,
  isTerminalLifecyclePath,
  parseIssueNumber,
  reconcile,
  resolveLifecycleAnchor,
} from "./reconcile-issues.js";

describe("reconcile-issues", () => {
  it("parses issue numbers from references", () => {
    expect(
      parseIssueNumber({
        type: "x-vbrief/github-issue",
        uri: "https://github.com/o/r/issues/123",
      }),
    ).toBe(123);
    expect(parseIssueNumber({ type: "github-issue", id: "#456" })).toBe(456);
  });

  it("walks nested item references", () => {
    const refs = extractReferencesFromVbrief({
      plan: {
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
        items: [
          {
            references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/2" }],
            subItems: [
              {
                references: [
                  { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/3" },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(refs).toHaveLength(3);
  });

  it("classifies linked vs closed", () => {
    const map = new Map<number, string[]>([[1, ["proposed/a.vbrief.json"]]]);
    const states = new Map<number, IssueState>([[1, new IssueState("OPEN")]]);
    const report = reconcile(map, states);
    expect(report.summary.linked_count).toBe(1);
    expect(report.no_open_issue).toHaveLength(0);
  });

  it("resolves lifecycle anchor planRef first", () => {
    expect(
      resolveLifecycleAnchor({
        plan: {
          planRef: "#99",
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
        },
      }),
    ).toEqual([99, "planRef"]);
  });

  it("formats markdown report", () => {
    const md = formatMarkdown({
      linked: [],
      no_open_issue: [],
      summary: { linked_count: 0, vbriefs_no_open_issue_count: 0 },
    });
    expect(md).toContain("# Issue Reconciliation Report");
  });

  it("detects terminal lifecycle paths", () => {
    expect(isTerminalLifecyclePath("completed/foo.vbrief.json")).toBe(true);
    expect(isTerminalLifecyclePath("active/foo.vbrief.json")).toBe(false);
  });
});
