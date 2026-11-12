import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import * as scm from "../scm/call.js";
import { stampLifecycleWrite } from "../scope/lifecycle-write.js";
import { validateEpicStoryLinks } from "../vbrief-validate/epic-links.js";
import {
  applyLifecycleFixes,
  attachCompletedStatusDrift,
  buildLifecycleReport,
  destinationFolder,
  extractReferencesFromVbrief,
  fetchIssueStates,
  fetchIssueStatesForApply,
  formatMarkdown,
  IssueState,
  isDeletedIssueState,
  isRestDeletedResult,
  isTerminalLifecyclePath,
  parseIssueNumber,
  reconcile,
  reconcileMain,
  repairCompletedStatusDrift,
  resolveLifecycleAnchor,
  scanCompletedStatusDrift,
  scanLifecycleAnchors,
} from "./reconcile-issues.js";

const itSymlink = it.skipIf(process.platform === "win32");

function completed(stdout = "", stderr = "", returncode = 0): CompletedProcess {
  return { args: [], returncode, stdout, stderr };
}

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

  it("fetchIssueStates uses REST and tolerates PR numbers mixed with issues (#2557)", () => {
    const states = fetchIssueStates("o/r", new Set([100, 401, 999]), {
      scmCall: (_src, verb, args) => {
        expect(verb).toBe("api");
        const path = args?.[0];
        if (path === "repos/o/r/issues/100") {
          return completed(JSON.stringify({ state: "open", state_reason: null }), "", 0);
        }
        if (path === "repos/o/r/issues/401") {
          return completed(
            JSON.stringify({
              state: "closed",
              state_reason: "completed",
              pull_request: { url: "https://github.com/o/r/pull/401" },
            }),
            "",
            0,
          );
        }
        if (path === "repos/o/r/issues/999") {
          return completed("", "gh: Not Found (HTTP 404)", 1);
        }
        throw new Error(`unexpected REST path: ${String(path)}`);
      },
    });
    expect(states).not.toBeNull();
    expect(states?.get(100)?.value).toBe("OPEN");
    expect(states?.get(401)?.value).toBe("CLOSED");
    expect(states?.get(401)?.stateReason).toBe("COMPLETED");
    expect(states?.get(999)?.value).toBe("NOT_FOUND");
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
    mkdirSync(join(xbrief, "proposed"), { recursive: true });

    const name = "2026-07-05-2337-task-aliases.xbrief.json";
    writeFileSync(
      join(xbrief, "proposed", name),
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

describe("completed/ status drift (#2578)", () => {
  let root = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("scanCompletedStatusDrift finds non-terminal status in completed/", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-drift-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    writeFileSync(
      join(xbrief, "completed", "drift.xbrief.json"),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "Drift", status: "running", items: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(scanCompletedStatusDrift(xbrief)).toEqual([
      { rel_path: "completed/drift.xbrief.json", status: "running" },
    ]);
  });

  it("repairCompletedStatusDrift stamps completed in place", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-drift-repair-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    const name = "drift.xbrief.json";
    writeFileSync(
      join(xbrief, "completed", name),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "Drift", status: "proposed", items: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const drift = scanCompletedStatusDrift(xbrief);
    const [repaired, skipped, failures] = repairCompletedStatusDrift(xbrief, drift);
    expect(repaired).toBe(1);
    expect(skipped).toBe(0);
    expect(failures).toEqual([]);

    const data = JSON.parse(readFileSync(join(xbrief, "completed", name), "utf8")) as {
      plan: { status: string };
    };
    expect(data.plan.status).toBe("completed");
  });

  it("formatMarkdown reports completed/ drift section", () => {
    const md = formatMarkdown(
      attachCompletedStatusDrift(
        {
          linked: [],
          no_open_issue: [],
          summary: { linked_count: 0, vbriefs_no_open_issue_count: 0 },
        },
        [{ rel_path: "completed/drift.xbrief.json", status: "running" }],
      ),
    );
    expect(md).toContain("(d) completed/ xBRIEFs with non-terminal plan.status");
    expect(md).toContain("completed/drift.xbrief.json");
  });

  it("scanCompletedStatusDrift returns empty when completed/ is absent", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-no-completed-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });
    expect(scanCompletedStatusDrift(xbrief)).toEqual([]);
  });

  it("repairCompletedStatusDrift skips already-terminal files", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-drift-skip-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    const name = "ok.xbrief.json";
    writeFileSync(
      join(xbrief, "completed", name),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "Done", status: "failed", items: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const [repaired, skipped, failures] = repairCompletedStatusDrift(xbrief, [
      { rel_path: `completed/${name}`, status: "running" },
    ]);
    expect(repaired).toBe(0);
    expect(skipped).toBe(1);
    expect(failures).toEqual([]);
  });

  it("repairCompletedStatusDrift reports malformed paths and missing files", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-drift-fail-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    writeFileSync(join(xbrief, "completed", "bad-json.xbrief.json"), "{not json", "utf8");

    const [, , failures] = repairCompletedStatusDrift(xbrief, [
      { rel_path: "no-folder.xbrief.json", status: "running" },
      { rel_path: "completed/missing.xbrief.json", status: "running" },
      { rel_path: "completed/bad-json.xbrief.json", status: "running" },
    ]);
    expect(failures.some((f) => f.includes("no folder"))).toBe(true);
    expect(failures.some((f) => f.includes("missing"))).toBe(true);
    expect(failures.some((f) => f.includes("failed to parse"))).toBe(true);
  });

  it("scanCompletedStatusDrift ignores terminal and empty statuses", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-drift-skip-scan-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    writeFileSync(
      join(xbrief, "completed", "done.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "Done", status: "completed" } }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      join(xbrief, "completed", "empty.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "Empty" } }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(xbrief, "completed", "bad-json.xbrief.json"), "not-json", "utf8");
    writeFileSync(
      join(xbrief, "completed", "no-plan.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" } }, null, 2)}\n`,
      "utf8",
    );
    expect(scanCompletedStatusDrift(xbrief)).toEqual([]);
  });

  it("repairCompletedStatusDrift stamps legacy vBRIEFInfo envelope", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-drift-legacy-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    const name = "legacy.xbrief.json";
    writeFileSync(
      join(xbrief, "completed", name),
      `${JSON.stringify(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: { title: "Legacy", status: "running", items: [{ title: "x", status: "running" }] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const [repaired] = repairCompletedStatusDrift(xbrief, scanCompletedStatusDrift(xbrief));
    expect(repaired).toBe(1);
    const data = JSON.parse(readFileSync(join(xbrief, "completed", name), "utf8")) as {
      vBRIEFInfo: { updated: string };
      plan: { status: string; items: { status: string }[] };
    };
    expect(data.plan.status).toBe("completed");
    expect(data.vBRIEFInfo.updated).toMatch(/Z$/);
    expect(data.plan.items[0]?.status).toBe("completed");
  });

  it("formatMarkdown sanitizes embedded newlines in drift status", () => {
    const md = formatMarkdown(
      attachCompletedStatusDrift(
        {
          linked: [],
          no_open_issue: [],
          summary: { linked_count: 0, vbriefs_no_open_issue_count: 0 },
        },
        [{ rel_path: "completed/drift.xbrief.json", status: "run\nning" }],
      ),
    );
    expect(md).toContain("plan.status='run ning'");
  });

  it("attachCompletedStatusDrift adds summary count", () => {
    const report = attachCompletedStatusDrift(
      {
        linked: [],
        no_open_issue: [],
        summary: { linked_count: 0, vbriefs_no_open_issue_count: 0 },
      },
      [{ rel_path: "completed/a.xbrief.json", status: "running" }],
    );
    expect(report.summary.completed_status_drift_count).toBe(1);
    expect(report.completed_status_drift).toHaveLength(1);
  });
});

describe("reconcile lifecycle apply symlink containment (#2632)", () => {
  let root = "";
  let escapeDir = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    if (escapeDir.length > 0) {
      rmSync(escapeDir, { recursive: true, force: true });
      escapeDir = "";
    }
  });

  itSymlink("applyLifecycleFixes refuses symlinked lifecycle xBRIEF writes", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-symlink-apply-"));
    escapeDir = mkdtempSync(join(tmpdir(), "reconcile-symlink-escape-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    const victim = join(escapeDir, "victim.xbrief.json");
    writeFileSync(
      victim,
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { status: "running", items: [] } })}\n`,
      "utf8",
    );
    const relPath = "active/story.xbrief.json";
    symlinkSync(victim, join(xbrief, "active", "story.xbrief.json"));

    const report = {
      linked: [],
      no_open_issue: [
        {
          issue: 1,
          state_reason: "COMPLETED",
          vbrief_files: [relPath],
        },
      ],
      summary: { linked_count: 0, vbriefs_no_open_issue_count: 1 },
    };
    const [moved, skipped, failures] = applyLifecycleFixes(xbrief, report, root);
    expect(moved).toBe(0);
    expect(skipped).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/projection write refused|symlink/);
    expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({
      xBRIEFInfo: { version: "0.8" },
      plan: { status: "running", items: [] },
    });
  });

  itSymlink("repairCompletedStatusDrift refuses symlinked completed xBRIEF writes", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-symlink-drift-"));
    escapeDir = mkdtempSync(join(tmpdir(), "reconcile-symlink-drift-escape-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    const victim = join(escapeDir, "victim.xbrief.json");
    writeFileSync(
      victim,
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { status: "running", items: [] } })}\n`,
      "utf8",
    );
    symlinkSync(victim, join(xbrief, "completed", "story.xbrief.json"));

    const [repaired, skipped, failures] = repairCompletedStatusDrift(
      xbrief,
      [{ rel_path: "completed/story.xbrief.json", status: "running" }],
      root,
    );
    expect(repaired).toBe(0);
    expect(skipped).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/projection write refused|symlink/);
    expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({
      xBRIEFInfo: { version: "0.8" },
      plan: { status: "running", items: [] },
    });
  });
});

/**
 * Criterion 6 of #3933: the two create-on-absent stamps in this module now
 * follow the shared lifecycle envelope policy -- stamp what exists, refuse an
 * envelope-less artifact by name instead of manufacturing a version-less
 * `vBRIEFInfo` that hides the real cause.
 */
describe("reconcile envelope policy (#3933)", () => {
  let root = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("applyLifecycleFixes refuses an envelope-less brief by name and leaves it in place", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-3933-move-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "proposed"), { recursive: true });
    const name = "2026-08-29-no-envelope.xbrief.json";
    const src = join(xbrief, "proposed", name);
    writeFileSync(
      src,
      `${JSON.stringify(
        {
          plan: {
            title: "No envelope",
            status: "running",
            items: [],
            references: [
              { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/77" },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const report = buildLifecycleReport(
      scanLifecycleAnchors(xbrief),
      new Map([[77, new IssueState("CLOSED", "COMPLETED")]]),
      false,
    );
    const [moved, , failures] = applyLifecycleFixes(xbrief, report, root);

    expect(moved).toBe(0);
    expect(failures.some((entry) => entry.includes("carries neither"))).toBe(true);
    const unchanged = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
    expect(Object.keys(unchanged)).toEqual(["plan"]);
    expect(existsSync(join(xbrief, "completed", name))).toBe(false);
  });

  it("repairCompletedStatusDrift refuses an envelope-less brief by name", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-3933-drift-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "completed"), { recursive: true });
    const name = "no-envelope.xbrief.json";
    writeFileSync(
      join(xbrief, "completed", name),
      `${JSON.stringify({ plan: { title: "No envelope", status: "running", items: [] } }, null, 2)}\n`,
      "utf8",
    );

    const [repaired, , failures] = repairCompletedStatusDrift(
      xbrief,
      scanCompletedStatusDrift(xbrief),
    );

    expect(repaired).toBe(0);
    expect(failures.some((entry) => entry.includes("carries neither"))).toBe(true);
    const unchanged = JSON.parse(readFileSync(join(xbrief, "completed", name), "utf8")) as {
      plan: { status: string };
    };
    expect(Object.keys(unchanged)).toEqual(["plan"]);
    expect(unchanged.plan.status).toBe("running");
  });
});

describe("fetchIssueStatesForApply (#4269)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses inventory for OPEN status and live-GETs only non-open non-terminal movers", () => {
    const perIssuePaths: string[] = [];
    let inventoryCalls = 0;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const states = fetchIssueStatesForApply(
      "o/r",
      [
        { rel_path: "active/open-a.xbrief.json", issue_number: 10, axis: "references" },
        { rel_path: "pending/open-b.xbrief.json", issue_number: 11, axis: "references" },
        { rel_path: "proposed/not-planned.xbrief.json", issue_number: 12, axis: "references" },
        { rel_path: "active/completed-closed.xbrief.json", issue_number: 13, axis: "references" },
        { rel_path: "completed/already-done.xbrief.json", issue_number: 14, axis: "references" },
        {
          rel_path: "cancelled/already-cancelled.xbrief.json",
          issue_number: 15,
          axis: "references",
        },
      ],
      {
        scmCall: (_src, verb, args) => {
          expect(verb).toBe("api");
          if (args?.includes("--paginate") === true && args?.includes("--slurp") === true) {
            inventoryCalls += 1;
            return completed(
              JSON.stringify([
                { number: 10, state: "open" },
                { number: 11, state: "open" },
              ]),
            );
          }
          const path = String(args?.[0] ?? "");
          perIssuePaths.push(path);
          if (path === "repos/o/r/issues/12") {
            return completed(JSON.stringify({ state: "closed", state_reason: "not_planned" }));
          }
          if (path === "repos/o/r/issues/13") {
            return completed(JSON.stringify({ state: "closed", state_reason: "completed" }));
          }
          throw new Error(`unexpected REST path: ${path}`);
        },
      },
    );
    expect(states).not.toBeNull();
    expect(inventoryCalls).toBe(1);
    expect(perIssuePaths).toEqual(["repos/o/r/issues/12", "repos/o/r/issues/13"]);
    expect(states?.get(10)?.value).toBe("OPEN");
    expect(states?.get(11)?.value).toBe("OPEN");
    expect(states?.get(12)?.value).toBe("CLOSED");
    expect(states?.get(12)?.stateReason).toBe("NOT_PLANNED");
    expect(states?.get(13)?.value).toBe("CLOSED");
    expect(states?.get(13)?.stateReason).toBe("COMPLETED");
    expect(states?.has(14)).toBe(false);
    expect(states?.has(15)).toBe(false);
    expect(destinationFolder(states?.get(12)?.stateReason)).toBe("cancelled");
    expect(destinationFolder(states?.get(13)?.stateReason)).toBe("completed");
    const progress = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(progress).toContain("[1/2] apply-lifecycle-fixes fetching state_reason for #12");
    expect(progress).toContain("[2/2] apply-lifecycle-fixes fetching state_reason for #13");
  });

  it("reuses one live GET when two non-terminal briefs share a closed issue", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let liveGets = 0;
    const states = fetchIssueStatesForApply(
      "o/r",
      [
        { rel_path: "active/one.xbrief.json", issue_number: 20, axis: "references" },
        { rel_path: "pending/two.xbrief.json", issue_number: 20, axis: "planRef" },
      ],
      {
        scmCall: (_src, _verb, args) => {
          if (args?.includes("--paginate") === true) {
            return completed(JSON.stringify([]));
          }
          liveGets += 1;
          expect(args?.[0]).toBe("repos/o/r/issues/20");
          return completed(JSON.stringify({ state: "closed", state_reason: "duplicate" }));
        },
      },
    );
    expect(states?.get(20)?.stateReason).toBe("DUPLICATE");
    expect(destinationFolder(states?.get(20)?.stateReason)).toBe("cancelled");
    expect(liveGets).toBe(1);
  });

  it("skips per-issue GET when every anchored brief is already terminal", () => {
    let inventoryCalls = 0;
    const perIssuePaths: string[] = [];
    const states = fetchIssueStatesForApply(
      "o/r",
      [
        { rel_path: "completed/done.xbrief.json", issue_number: 1, axis: "references" },
        { rel_path: "cancelled/dropped.xbrief.json", issue_number: 2, axis: "references" },
      ],
      {
        scmCall: (_src, verb, args) => {
          expect(verb).toBe("api");
          if (args?.includes("--paginate") === true && args?.includes("--slurp") === true) {
            inventoryCalls += 1;
            return completed(JSON.stringify([{ number: 1, state: "open" }]));
          }
          perIssuePaths.push(String(args?.[0] ?? ""));
          throw new Error(`unexpected REST path: `);
        },
      },
    );
    expect(inventoryCalls).toBe(1);
    expect(perIssuePaths).toEqual([]);
    expect(states?.get(1)?.value).toBe("OPEN");
    expect(states?.has(2)).toBe(false);
  });

  it("inventory OPEN overlay keeps terminal-on-disk still-open issues off NOT_FOUND", () => {
    const perIssuePaths: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const states = fetchIssueStatesForApply(
      "o/r",
      [
        { rel_path: "active/mover.xbrief.json", issue_number: 10, axis: "references" },
        { rel_path: "completed/still-open.xbrief.json", issue_number: 14, axis: "references" },
      ],
      {
        reportIssueNumbers: [10, 14, 99],
        scmCall: (_src, _verb, args) => {
          if (args?.includes("--paginate") === true && args?.includes("--slurp") === true) {
            return completed(
              JSON.stringify([
                { number: 10, state: "open" },
                { number: 14, state: "open" },
                { number: 99, state: "open" },
              ]),
            );
          }
          perIssuePaths.push(String(args?.[0] ?? ""));
          throw new Error(`unexpected REST path: `);
        },
      },
    );
    expect(perIssuePaths).toEqual([]);
    expect(states?.get(10)?.value).toBe("OPEN");
    expect(states?.get(14)?.value).toBe("OPEN");
    expect(states?.get(99)?.value).toBe("OPEN");
  });

  it("fails closed on malformed inventory JSON", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const states = fetchIssueStatesForApply(
      "o/r",
      [{ rel_path: "active/a.xbrief.json", issue_number: 1, axis: "references" }],
      {
        scmCall: (_src, _verb, args) => {
          if (args?.includes("--paginate") === true) {
            return completed(JSON.stringify({ not: "an array" }));
          }
          throw new Error(`unexpected REST args: ${String(args?.join(" "))}`);
        },
      },
    );
    expect(states).toBeNull();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toMatch(/inventory|array/i);
  });

  it("locks cancelled versus completed destination from state_reason", () => {
    expect(destinationFolder("NOT_PLANNED")).toBe("cancelled");
    expect(destinationFolder("DUPLICATE")).toBe("cancelled");
    expect(destinationFolder("COMPLETED")).toBe("completed");
    expect(destinationFolder(null)).toBe("completed");
    expect(destinationFolder(undefined)).toBe("completed");
  });
});

describe("applyLifecycleFixes unstamped active-to-completed refuse (#4508)", () => {
  let root = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("leaves the active blob unmutated and does not write lifecycleWrite", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-4508-refuse-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });
    const name = "2026-09-14-leftover.xbrief.json";
    const src = join(xbrief, "active", name);
    const original = `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8", description: "leftover active brief" },
        plan: {
          title: "Leftover",
          status: "running",
          items: [
            { title: "slice", status: "proposed" },
            { title: "other", status: "proposed" },
          ],
          acceptance: { commands: [], none_stated: true },
          references: [
            { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/3849" },
          ],
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(src, original, "utf8");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const [moved, skipped, failures] = applyLifecycleFixes(
      xbrief,
      buildLifecycleReport(
        scanLifecycleAnchors(xbrief),
        new Map([[3849, new IssueState("CLOSED", "COMPLETED")]]),
        false,
      ),
      root,
    );
    const stderrText = stderr.mock.calls.map((call) => String(call[0])).join("");
    stderr.mockRestore();

    expect(moved).toBe(0);
    expect(skipped).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("unstamped active/ to completed/ (#4508)");
    expect(readFileSync(src, "utf8")).toBe(original);
    expect(existsSync(join(xbrief, "completed", name))).toBe(false);
    const parsed = JSON.parse(original) as {
      plan: {
        status: string;
        items: { status: string }[];
        metadata?: { lifecycleWrite?: unknown };
      };
    };
    expect(parsed.plan.status).toBe("running");
    expect(parsed.plan.items.every((item) => item.status === "proposed")).toBe(true);
    expect(parsed.plan.metadata?.lifecycleWrite).toBeUndefined();
    expect(stderrText).toContain("unstamped active/ to completed/ (#4508)");
    expect(stderrText).toContain("left source unmutated");
  });

  it("still moves a stamped active brief to completed/", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-4508-stamped-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });
    const name = "2026-09-14-stamped.xbrief.json";
    const plan = {
      title: "Stamped leftover",
      status: "running",
      items: [{ title: "slice", status: "completed" }],
      references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/99" }],
      metadata: {},
    };
    stampLifecycleWrite(plan, "complete", "2026-09-14T00:00:00Z");
    writeFileSync(
      join(xbrief, "active", name),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
      "utf8",
    );

    const [moved, skipped, failures] = applyLifecycleFixes(
      xbrief,
      buildLifecycleReport(
        scanLifecycleAnchors(xbrief),
        new Map([[99, new IssueState("CLOSED", "COMPLETED")]]),
        false,
      ),
      root,
    );
    expect(moved).toBe(1);
    expect(skipped).toBe(0);
    expect(failures).toEqual([]);
    expect(existsSync(join(xbrief, "active", name))).toBe(false);
    const movedPath = join(xbrief, "completed", name);
    expect(existsSync(movedPath)).toBe(true);
    const movedData = JSON.parse(readFileSync(movedPath, "utf8")) as {
      plan: { status: string; metadata: { lifecycleWrite: { action: string } } };
    };
    expect(movedData.plan.status).toBe("completed");
    expect(movedData.plan.metadata.lifecycleWrite.action).toBe("complete");
  });

  it("refuses failed status and fail stamps instead of rewriting them completed", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-4508-failed-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });
    const failedName = "2026-09-15-failed.xbrief.json";
    const failStampName = "2026-09-15-fail-stamp.xbrief.json";
    writeFileSync(
      join(xbrief, "active", failedName),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Failed leftover",
            status: "failed",
            items: [{ title: "slice", status: "failed" }],
            references: [
              { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/11" },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const failPlan: Record<string, unknown> = {
      title: "Fail-stamped leftover",
      status: "failed",
      items: [{ title: "slice", status: "failed" }],
      references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/12" }],
      metadata: {},
    };
    stampLifecycleWrite(failPlan, "fail", "2026-09-15T00:00:00Z");
    writeFileSync(
      join(xbrief, "active", failStampName),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: failPlan }, null, 2)}\n`,
      "utf8",
    );

    const [moved, skipped, failures] = applyLifecycleFixes(
      xbrief,
      buildLifecycleReport(
        scanLifecycleAnchors(xbrief),
        new Map([
          [11, new IssueState("CLOSED", "COMPLETED")],
          [12, new IssueState("CLOSED", "COMPLETED")],
        ]),
        false,
      ),
      root,
    );
    expect(moved).toBe(0);
    expect(skipped).toBe(0);
    expect(failures).toHaveLength(2);
    expect(existsSync(join(xbrief, "active", failedName))).toBe(true);
    expect(existsSync(join(xbrief, "active", failStampName))).toBe(true);
    expect(existsSync(join(xbrief, "completed", failedName))).toBe(false);
    expect(existsSync(join(xbrief, "completed", failStampName))).toBe(false);
    const failedBlob = JSON.parse(readFileSync(join(xbrief, "active", failedName), "utf8")) as {
      plan: { status: string };
    };
    expect(failedBlob.plan.status).toBe("failed");
  });

  it("still moves a legacy completedAt active brief to completed/", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-4508-legacy-"));
    const xbrief = join(root, "xbrief");
    mkdirSync(join(xbrief, "active"), { recursive: true });
    const name = "2026-09-15-legacy-completedAt.xbrief.json";
    writeFileSync(
      join(xbrief, "active", name),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "Legacy complete",
            status: "running",
            items: [{ title: "slice", status: "completed" }],
            references: [
              { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/13" },
            ],
            metadata: { completedAt: "2026-08-20T00:00:00Z" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const [moved, skipped, failures] = applyLifecycleFixes(
      xbrief,
      buildLifecycleReport(
        scanLifecycleAnchors(xbrief),
        new Map([[13, new IssueState("CLOSED", "COMPLETED")]]),
        false,
      ),
      root,
    );
    expect(moved).toBe(1);
    expect(skipped).toBe(0);
    expect(failures).toEqual([]);
    expect(existsSync(join(xbrief, "active", name))).toBe(false);
    expect(existsSync(join(xbrief, "completed", name))).toBe(true);
  });
});

describe("deleted issues -- HTTP 410 (#5912)", () => {
  let root = "";
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const r of restores.splice(0)) r();
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  const GONE_STDOUT = JSON.stringify({
    message: "This issue was deleted",
    documentation_url: "https://docs.github.com/rest/issues/issues#get-an-issue",
    status: "410",
  });

  function issueRef(n: number): Record<string, unknown> {
    return { type: "x-xbrief/github-issue", uri: `https://github.com/o/r/issues/${n}` };
  }

  function writeBrief(dir: string, folder: string, name: string, plan: Record<string, unknown>) {
    mkdirSync(join(dir, folder), { recursive: true });
    const path = join(dir, folder, name);
    writeFileSync(
      path,
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { items: [], ...plan } }, null, 2)}\n`,
      "utf8",
    );
    return path;
  }

  /** Stub gh: per-issue REST routes; everything else (open inventory) is an empty list. */
  function stubGh(routes: Record<number, CompletedProcess>): string[] {
    const seen: string[] = [];
    const spy = vi.spyOn(scm, "call").mockImplementation((_src, _verb, args) => {
      const path = String(args?.[0] ?? "");
      seen.push(path);
      const m = /^repos\/o\/r\/issues\/(\d+)$/.exec(path);
      if (m?.[1]) {
        const routed = routes[Number(m[1])];
        if (routed) return routed;
        return completed("", "gh: Not Found (HTTP 404)", 1);
      }
      return completed("[]", "", 0);
    });
    restores.push(() => spy.mockRestore());
    return seen;
  }

  function captureStd(): { out: () => string; err: () => string } {
    let out = "";
    let err = "";
    const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    restores.push(() => {
      o.mockRestore();
      e.mockRestore();
    });
    return { out: () => out, err: () => err };
  }

  it("maps 410 (stdout JSON or stderr) to DELETED, 404 to NOT_FOUND, other failures to null", () => {
    const routes: Record<string, CompletedProcess> = {
      "repos/o/r/issues/1": completed(GONE_STDOUT, "gh: This issue was deleted (HTTP 410)", 1),
      "repos/o/r/issues/2": completed("", "gh: This issue was deleted (HTTP 410)", 1),
      "repos/o/r/issues/3": completed("", "gh: Not Found (HTTP 404)", 1),
    };
    const states = fetchIssueStates("o/r", new Set([1, 2, 3]), {
      scmCall: (_s, _v, args) => routes[String(args?.[0])] ?? completed("", "boom", 1),
    });
    expect(states?.get(1)?.value).toBe("DELETED");
    expect(states?.get(2)?.value).toBe("DELETED");
    expect(states?.get(3)?.value).toBe("NOT_FOUND");
    expect(isDeletedIssueState(states?.get(1))).toBe(true);
    expect(isRestDeletedResult(completed("{not json", "gh: Server Error (HTTP 500)", 1))).toBe(
      false,
    );

    const err = captureStd();
    expect(
      fetchIssueStates("o/r", new Set([4]), {
        scmCall: () => completed("", "gh: Server Error (HTTP 500)", 1),
      }),
    ).toBeNull();
    expect(err.err()).toContain("gh REST failed fetching issue #4");
  });

  it("report mode exits 0 and names deleted (410) apart from missing (404)", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-report-"));
    const xbrief = join(root, "xbrief");
    writeBrief(xbrief, "active", "gone.xbrief.json", { references: [issueRef(20)] });
    writeBrief(xbrief, "pending", "missing.xbrief.json", { references: [issueRef(30)] });
    stubGh({ 20: completed(GONE_STDOUT, "gh: This issue was deleted (HTTP 410)", 1) });
    const std = captureStd();
    expect(
      reconcileMain({ vbriefDir: xbrief, repo: "o/r", projectRoot: root, format: "json" }),
    ).toBe(0);
    const report = JSON.parse(std.out()) as {
      no_open_issue: Array<{ issue_number: number; state: string; note: string }>;
      summary: Record<string, number>;
    };
    const gone = report.no_open_issue.find((e) => e.issue_number === 20);
    const missing = report.no_open_issue.find((e) => e.issue_number === 30);
    expect(gone?.state).toBe("DELETED");
    expect(gone?.note).toContain("deleted (HTTP 410)");
    expect(gone?.note).toContain("#5126");
    expect(missing?.state).toBe("NOT_FOUND");
    expect(missing?.note).toBe("Issue does not exist (HTTP 404)");
    expect(report.summary.deleted_issue_count).toBe(1);

    const md = formatMarkdown(
      reconcile(
        new Map([[20, ["active/gone.xbrief.json"]]]),
        new Map([[20, new IssueState("DELETED")]]),
      ),
    );
    expect(md).toContain("- **Deleted issues (HTTP 410)**: 1");
    expect(md).toContain("- #20 -- `active/gone.xbrief.json` (Issue was deleted (HTTP 410)");
  });

  it("leaves proposed/pending/active briefs anchored to DELETED byte-identical; not failures", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-inplace-"));
    const xbrief = join(root, "xbrief");
    const paths = ["proposed", "pending", "active"].map((folder, i) =>
      writeBrief(xbrief, folder, `${folder}.xbrief.json`, {
        status: folder === "active" ? "running" : folder,
        references: [issueRef(40 + i)],
      }),
    );
    const before = paths.map((p) => readFileSync(p, "utf8"));
    const report = buildLifecycleReport(
      scanLifecycleAnchors(xbrief),
      new Map([
        [40, new IssueState("DELETED")],
        [41, new IssueState("DELETED")],
        [42, new IssueState("DELETED")],
      ]),
      false,
    );
    expect(report.summary.deleted_issue_count).toBe(3);
    const [moved, skipped, failures, deletedSkips] = applyLifecycleFixes(xbrief, report, root);
    expect(moved).toBe(0);
    expect(skipped).toBe(0);
    expect(failures).toEqual([]);
    expect(deletedSkips).toHaveLength(3);
    expect(deletedSkips[0]).toContain("#5126");
    expect(paths.map((p) => readFileSync(p, "utf8"))).toEqual(before);
    expect(existsSync(join(xbrief, "completed"))).toBe(false);
    expect(existsSync(join(xbrief, "cancelled"))).toBe(false);
  });

  it("DELETED wins over a CLOSED entry ordered ahead of it for the same brief", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-wins-"));
    const xbrief = join(root, "xbrief");
    const rel = "pending/multi.xbrief.json";
    const path = writeBrief(xbrief, "pending", "multi.xbrief.json", {
      references: [issueRef(5), issueRef(6)],
    });
    const before = readFileSync(path, "utf8");
    const report = {
      linked: [],
      no_open_issue: [
        { issue_number: 5, vbrief_files: [rel], state: "CLOSED", state_reason: "NOT_PLANNED" },
        { issue_number: 6, vbrief_files: [rel], state: "DELETED", state_reason: null },
      ],
      summary: { linked_count: 0, vbriefs_no_open_issue_count: 2 },
    };
    const [moved, , failures, deletedSkips] = applyLifecycleFixes(xbrief, report, root);
    expect(moved).toBe(0);
    expect(failures).toEqual([]);
    expect(deletedSkips).toEqual([expect.stringContaining("deleted issue #6")]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(xbrief, "cancelled"))).toBe(false);
  });

  it("end-to-end: multi-ref brief anchored to DELETED with a lower CLOSED ref stays put, exit 0", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-e2e-"));
    const xbrief = join(root, "xbrief");
    const path = writeBrief(xbrief, "active", "multi.xbrief.json", {
      status: "running",
      planRef: "#20",
      references: [issueRef(10), issueRef(20)],
    });
    const before = readFileSync(path, "utf8");
    stubGh({
      10: completed(JSON.stringify({ state: "closed", state_reason: "completed" })),
      20: completed(GONE_STDOUT, "gh: This issue was deleted (HTTP 410)", 1),
    });
    const std = captureStd();
    expect(
      reconcileMain({
        vbriefDir: xbrief,
        repo: "o/r",
        projectRoot: root,
        format: "json",
        applyLifecycleFixes: true,
      }),
    ).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(xbrief, "completed"))).toBe(false);
    expect(std.err()).toContain("deleted-skipped=1, failures=0");
    expect(std.err()).toContain("DELETED (skipped, not a failure): active/multi.xbrief.json");
  });

  function writeParentAndChild(
    childFolder: string,
    childRefs: Record<string, unknown>[],
    childStatus?: string,
  ) {
    const xbrief = join(root, "xbrief");
    const parent = writeBrief(xbrief, "proposed", "parent.xbrief.json", {
      status: "proposed",
      references: [
        issueRef(55),
        { type: "x-xbrief/plan", uri: `${childFolder}/child.xbrief.json` },
      ],
    });
    const child = writeBrief(xbrief, childFolder, "child.xbrief.json", {
      status: childStatus ?? (childFolder === "completed" ? "completed" : "running"),
      planRef: "proposed/parent.xbrief.json",
      references: childRefs,
    });
    return { xbrief, parent, child };
  }

  it("probe refuses a CLOSED parent move when a terminal child is DELETED (exit 0)", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-probe-del-"));
    // Drifted status: completed/ drift repair must not rewrite a protected child either.
    const { xbrief, parent, child } = writeParentAndChild("completed", [issueRef(57)], "running");
    const before = [readFileSync(parent, "utf8"), readFileSync(child, "utf8")];
    const seen = stubGh({
      55: completed(JSON.stringify({ state: "closed", state_reason: "completed" })),
      57: completed(GONE_STDOUT, "gh: This issue was deleted (HTTP 410)", 1),
    });
    const std = captureStd();
    expect(
      reconcileMain({
        vbriefDir: xbrief,
        repo: "o/r",
        projectRoot: root,
        applyLifecycleFixes: true,
      }),
    ).toBe(0);
    expect(seen).toContain("repos/o/r/issues/57");
    expect([readFileSync(parent, "utf8"), readFileSync(child, "utf8")]).toEqual(before);
    expect(existsSync(join(xbrief, "completed", "parent.xbrief.json"))).toBe(false);
    expect(std.err()).toContain(
      "child completed/child.xbrief.json is anchored to deleted issue #57",
    );
  });

  it("probe refuses when the child GET does not resolve (exit 1, nothing written)", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-probe-unres-"));
    // Terminal child: not a mover, so only the probe GETs it.
    const { xbrief, parent, child } = writeParentAndChild("completed", [issueRef(58)], "running");
    const before = [readFileSync(parent, "utf8"), readFileSync(child, "utf8")];
    stubGh({
      55: completed(JSON.stringify({ state: "closed", state_reason: "completed" })),
      58: completed("", "gh: Server Error (HTTP 502)", 1),
    });
    const std = captureStd();
    expect(
      reconcileMain({
        vbriefDir: xbrief,
        repo: "o/r",
        projectRoot: root,
        applyLifecycleFixes: true,
      }),
    ).toBe(1);
    expect([readFileSync(parent, "utf8"), readFileSync(child, "utf8")]).toEqual(before);
    expect(std.err()).toContain("issue #58 state did not resolve");
  });

  it("returns protected paths for DELETED skips and refused related moves", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-protected-"));
    const { xbrief } = writeParentAndChild("completed", [issueRef(71)], "running");
    writeBrief(xbrief, "pending", "gone.xbrief.json", { references: [issueRef(70)] });
    const report = buildLifecycleReport(
      scanLifecycleAnchors(xbrief),
      new Map([
        [55, new IssueState("CLOSED", "COMPLETED")],
        [70, new IssueState("DELETED")],
        [71, new IssueState("DELETED")],
      ]),
      false,
    );
    const [moved, , failures, deletedSkips, protectedRels] = applyLifecycleFixes(
      xbrief,
      report,
      root,
    );
    expect(moved).toBe(0);
    expect(failures).toEqual([]);
    expect(deletedSkips).toHaveLength(3);
    expect([...protectedRels].sort()).toEqual([
      "completed/child.xbrief.json",
      "pending/gone.xbrief.json",
      "proposed/parent.xbrief.json",
    ]);
  });

  it("a protected child with a CLOSED anchor and a DELETED second ref does not move alone", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-child-alone-"));
    const { xbrief, parent, child } = writeParentAndChild(
      "pending",
      [issueRef(60), issueRef(61)],
      "pending",
    );
    const before = [readFileSync(parent, "utf8"), readFileSync(child, "utf8")];
    const states = new Map([
      [55, new IssueState("CLOSED", "COMPLETED")],
      [60, new IssueState("CLOSED", "COMPLETED")],
      [61, new IssueState("DELETED")],
    ]);
    const report = buildLifecycleReport(scanLifecycleAnchors(xbrief), states, false);
    const [moved, , failures, deletedSkips] = applyLifecycleFixes(xbrief, report, root, {
      issueStates: states,
    });
    expect(moved).toBe(0);
    expect(failures).toEqual([]);
    expect(deletedSkips).toHaveLength(2);
    expect([readFileSync(parent, "utf8"), readFileSync(child, "utf8")]).toEqual(before);
    expect(existsSync(join(xbrief, "completed"))).toBe(false);
  });

  it("a move that would rewrite a brief protected by another refusal is refused too", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-fixpoint-"));
    const xbrief = join(root, "xbrief");
    const planRef = (folder: string, name: string) => ({
      type: "x-xbrief/plan",
      uri: `${folder}/${name}`,
    });
    const shared = writeBrief(xbrief, "pending", "shared.xbrief.json", {
      planRef: "proposed/b.xbrief.json",
      references: [issueRef(63)],
    });
    const gone = writeBrief(xbrief, "pending", "gone.xbrief.json", {
      planRef: "proposed/b.xbrief.json",
      references: [issueRef(64)],
    });
    const b = writeBrief(xbrief, "proposed", "b.xbrief.json", {
      references: [
        issueRef(56),
        planRef("pending", "shared.xbrief.json"),
        planRef("pending", "gone.xbrief.json"),
      ],
    });
    const a = writeBrief(xbrief, "proposed", "a.xbrief.json", {
      references: [issueRef(55), planRef("pending", "shared.xbrief.json")],
    });
    const paths = [a, b, shared, gone];
    const before = paths.map((p) => readFileSync(p, "utf8"));
    const states = new Map([
      [55, new IssueState("CLOSED", "COMPLETED")],
      [56, new IssueState("CLOSED", "COMPLETED")],
      [63, new IssueState("OPEN")],
      [64, new IssueState("DELETED")],
    ]);
    const report = buildLifecycleReport(scanLifecycleAnchors(xbrief), states, false);
    const [moved, , failures, deletedSkips, protectedRels] = applyLifecycleFixes(
      xbrief,
      report,
      root,
      { issueStates: states },
    );
    expect(moved).toBe(0);
    expect(failures).toEqual([]);
    expect(deletedSkips.some((d) => d.startsWith("proposed/a.xbrief.json:"))).toBe(true);
    expect(protectedRels.has("proposed/a.xbrief.json")).toBe(true);
    expect(paths.map((p) => readFileSync(p, "utf8"))).toEqual(before);
  });

  it("issue-less child is not probed; the parent moves and the run exits 0", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-probe-none-"));
    const { xbrief, child } = writeParentAndChild("active", []);
    const seen = stubGh({
      55: completed(JSON.stringify({ state: "closed", state_reason: "completed" })),
    });
    captureStd();
    expect(
      reconcileMain({
        vbriefDir: xbrief,
        repo: "o/r",
        projectRoot: root,
        applyLifecycleFixes: true,
      }),
    ).toBe(0);
    expect(existsSync(join(xbrief, "completed", "parent.xbrief.json"))).toBe(true);
    expect(seen.filter((p) => /issues\/\d+$/.test(p) && !p.endsWith("/55"))).toEqual([]);
    const childData = JSON.parse(readFileSync(child, "utf8")) as { plan: { planRef: string } };
    expect(childData.plan.planRef).toBe("completed/parent.xbrief.json");
  });

  it("without a probe, an unknown child issue is unresolved and nothing moves", () => {
    root = mkdtempSync(join(tmpdir(), "reconcile-5912-noprobe-"));
    const { xbrief, parent } = writeParentAndChild("active", [issueRef(59)]);
    const before = readFileSync(parent, "utf8");
    const report = buildLifecycleReport(
      [{ rel_path: "proposed/parent.xbrief.json", issue_number: 55, axis: "references" }],
      new Map([[55, new IssueState("CLOSED", "COMPLETED")]]),
      false,
    );
    const [moved, , failures, deletedSkips] = applyLifecycleFixes(xbrief, report, root);
    expect(moved).toBe(0);
    expect(deletedSkips).toEqual([]);
    expect(failures).toEqual([expect.stringContaining("issue #59 state did not resolve")]);
    expect(readFileSync(parent, "utf8")).toBe(before);
  });
});
