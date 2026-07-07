import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateEpicStoryLinks } from "../vbrief-validate/epic-links.js";
import {
  applyLifecycleFixes,
  buildLifecycleReport,
  extractReferencesFromVbrief,
  formatMarkdown,
  IssueState,
  isTerminalLifecyclePath,
  parseIssueNumber,
  reconcile,
  resolveLifecycleAnchor,
  scanLifecycleAnchors,
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
    const map = new Map<number, string[]>([[1, ["proposed/a.xbrief.json"]]]);
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
    expect(isTerminalLifecyclePath("completed/foo.xbrief.json")).toBe(true);
    expect(isTerminalLifecyclePath("active/foo.xbrief.json")).toBe(false);
  });
});

describe("applyLifecycleFixes planRef rewrite (#1667)", () => {
  let root = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("rewrites child planRefs when parent moves to completed/", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-planref-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    mkdirSync(join(vbrief, "active"), { recursive: true });

    const parentName = "2026-01-01-parent.xbrief.json";
    const childName = "2026-01-01-child.xbrief.json";
    writeFileSync(
      join(vbrief, "proposed", parentName),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Parent epic",
            status: "proposed",
            items: [],
            references: [
              { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/55" },
              { type: "x-vbrief/plan", uri: `active/${childName}` },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      join(vbrief, "active", childName),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Child story",
            status: "running",
            items: [{ title: "slice", status: "running", planRef: `proposed/${parentName}` }],
            planRef: `proposed/${parentName}`,
            references: [
              { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/56" },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const anchors = scanLifecycleAnchors(vbrief);
    const report = buildLifecycleReport(
      anchors,
      new Map([
        [55, new IssueState("CLOSED", "COMPLETED")],
        [56, new IssueState("OPEN")],
      ]),
      false,
    );
    const [moved, skipped, failures] = applyLifecycleFixes(vbrief, report, root);
    expect(moved).toBe(1);
    expect(skipped).toBe(0);
    expect(failures).toEqual([]);

    const childPath = join(vbrief, "active", childName);
    const childData = JSON.parse(readFileSync(childPath, "utf8")) as {
      plan: { planRef: string; items: { planRef: string }[] };
    };
    expect(childData.plan.planRef).toBe(`completed/${parentName}`);
    expect(childData.plan.items[0]?.planRef).toBe(`completed/${parentName}`);

    const parentPath = join(vbrief, "completed", parentName);
    const all = new Map<string, Record<string, unknown>>();
    all.set(parentPath, JSON.parse(readFileSync(parentPath, "utf8")) as Record<string, unknown>);
    all.set(childPath, JSON.parse(readFileSync(childPath, "utf8")) as Record<string, unknown>);
    const display = new Map([
      [parentPath, `xbrief/completed/${parentName}`],
      [childPath, `xbrief/active/${childName}`],
    ]);
    expect(validateEpicStoryLinks(all, vbrief, display)).toEqual([]);
  });

  it("stamps updated into xBRIEFInfo (v0.8) without appending a stray vBRIEFInfo (#2346)", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-2346-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });

    const name = "2026-07-05-2337-task-aliases.xbrief.json";
    writeFileSync(
      join(xbrief, "active", name),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8", description: "Scope xBRIEF for #99" },
          plan: {
            title: "Story",
            status: "running",
            items: [{ title: "slice", status: "running" }],
            references: [
              { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/99" },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const anchors = scanLifecycleAnchors(xbrief);
    const report = buildLifecycleReport(
      anchors,
      new Map([[99, new IssueState("CLOSED", "COMPLETED")]]),
      false,
    );
    const [moved, , failures] = applyLifecycleFixes(xbrief, report, root);
    expect(moved).toBe(1);
    expect(failures).toEqual([]);

    const movedPath = join(xbrief, "completed", name);
    const parsed = JSON.parse(readFileSync(movedPath, "utf8")) as unknown;
    expect(typeof parsed === "object" && parsed !== null).toBe(true);
    const data = parsed as Record<string, unknown>;
    // The `updated` stamp lands on the existing xBRIEFInfo envelope...
    const xInfo = data.xBRIEFInfo as Record<string, unknown>;
    expect(xInfo.version).toBe("0.8");
    expect(typeof xInfo.updated).toBe("string");
    // ...and no stray, version-less vBRIEFInfo block is appended (the #2346 bug
    // that failed vbrief:validate with "'vBRIEFInfo.version' ... got 'undefined'").
    expect("vBRIEFInfo" in data).toBe(false);
  });
});
