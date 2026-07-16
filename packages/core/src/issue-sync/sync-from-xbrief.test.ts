import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSyncComment,
  extractSyncSnapshot,
  fingerprintSyncSnapshot,
  hasMaterialChanges,
  resolveOriginIssue,
  SYNC_COMMENT_HEADER,
  syncFromXbrief,
} from "./sync-from-xbrief.js";

const ORIGIN_XBRIEF = {
  xBRIEFInfo: { version: "0.8" },
  plan: {
    title: "Keep linked GitHub issues in sync",
    status: "running",
    narratives: {
      Origin: "Ingested from https://github.com/deftai/directive/issues/2540",
      Acceptance: "Sync posts a comment when AC or status changes.",
    },
    items: [
      { title: "issue:sync-from-xbrief verb", status: "pending" },
      { title: "Skill obligation", status: "completed" },
    ],
    references: [
      {
        uri: "https://github.com/deftai/directive/issues/2540",
        type: "x-xbrief/github-issue",
        title: "Issue #2540",
      },
    ],
  },
};

describe("issue-sync resolveOriginIssue", () => {
  it("resolves github-issue origin from references", () => {
    const origin = resolveOriginIssue(ORIGIN_XBRIEF);
    expect(origin).toEqual({
      repo: "deftai/directive",
      number: 2540,
      uri: "https://github.com/deftai/directive/issues/2540",
    });
  });

  it("returns null when no github-issue reference exists", () => {
    expect(
      resolveOriginIssue({
        plan: {
          title: "No origin",
          references: [{ uri: "https://example.com/doc", type: "x-xbrief/web-page" }],
        },
      }),
    ).toBeNull();
  });

  it("uses fallback repo when reference uri lacks slug", () => {
    const origin = resolveOriginIssue(
      {
        plan: {
          narratives: { Origin: "Ingested from issue #99" },
          references: [{ type: "x-xbrief/github-issue", id: "#99" }],
        },
      },
      { fallbackRepo: "deftai/directive" },
    );
    expect(origin).toEqual({
      repo: "deftai/directive",
      number: 99,
      uri: "https://github.com/deftai/directive/issues/99",
    });
  });
});

describe("issue-sync material change detection", () => {
  it("extracts status, items, and acceptance into a fingerprint", () => {
    const snapshot = extractSyncSnapshot(ORIGIN_XBRIEF);
    expect(snapshot.status).toBe("running");
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.acceptance).toContain("Sync posts");
    expect(fingerprintSyncSnapshot(snapshot)).toMatch(/^[a-f0-9]{16}$/);
  });

  it("detects first sync as material", () => {
    expect(hasMaterialChanges(ORIGIN_XBRIEF)).toBe(true);
  });

  it("skips when fingerprint matches stored metadata", () => {
    const snapshot = extractSyncSnapshot(ORIGIN_XBRIEF);
    const data = {
      ...ORIGIN_XBRIEF,
      plan: {
        ...ORIGIN_XBRIEF.plan,
        metadata: {
          issueSync: { fingerprint: fingerprintSyncSnapshot(snapshot) },
        },
      },
    };
    expect(hasMaterialChanges(data)).toBe(false);
  });
});

describe("issue-sync buildSyncComment", () => {
  it("includes header, status, items, and acceptance", () => {
    const body = buildSyncComment(ORIGIN_XBRIEF, "xbrief/active/example.xbrief.json");
    expect(body).toContain(SYNC_COMMENT_HEADER);
    expect(body).toContain("**Status:** `running`");
    expect(body).toContain("issue:sync-from-xbrief verb");
    expect(body).toContain("Sync posts a comment");
  });
});

describe("issue-sync dry-run and missing origin", () => {
  it("dry-run prints comment without posting", () => {
    const out: string[] = [];
    const err: string[] = [];
    const runFn = vi.fn();
    const code = syncFromXbrief({
      xbriefPath: writeTempXbrief(ORIGIN_XBRIEF),
      dryRun: true,
      repo: "deftai/directive",
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
      runFn,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("dry-run would post comment");
    expect(out.join("\n")).toContain(SYNC_COMMENT_HEADER);
    expect(runFn).not.toHaveBeenCalled();
    expect(err).toEqual([]);
  });

  it("missing origin exits non-zero", () => {
    const err: string[] = [];
    const code = syncFromXbrief({
      xbriefPath: writeTempXbrief({
        plan: { title: "orphan", status: "running", items: [] },
      }),
      dryRun: true,
      writeErr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no linked GitHub issue origin");
  });
});

function writeTempXbrief(data: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-sync-"));
  const path = join(dir, "scope.xbrief.json");
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return path;
}
