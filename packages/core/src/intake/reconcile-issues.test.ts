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
import { afterEach, describe, expect, it } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import { validateEpicStoryLinks } from "../vbrief-validate/epic-links.js";
import {
  applyLifecycleFixes,
  attachCompletedStatusDrift,
  buildLifecycleReport,
  extractReferencesFromVbrief,
  fetchIssueStates,
  formatMarkdown,
  IssueState,
  isTerminalLifecyclePath,
  parseIssueNumber,
  reconcile,
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
    mkdirSync(join(xbrief, "active"), { recursive: true });
    const name = "2026-08-29-no-envelope.xbrief.json";
    const src = join(xbrief, "active", name);
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
