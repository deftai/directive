import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunGhApiFn } from "../intake/github-body.js";
import {
  buildSyncComment,
  extractSyncSnapshot,
  fingerprintSyncSnapshot,
  hasMaterialChanges,
  resolveOriginIssue,
  SYNC_COMMENT_HEADER,
  sanitizeMarkdownInline,
  syncFromXbrief,
} from "./sync-from-xbrief.js";
import { parseArgs } from "./sync-from-xbrief-cli.js";

function mockCommentRunFn(id: number): RunGhApiFn {
  let lastBody = "";
  const fn: RunGhApiFn = (args, options) => {
    if (args.includes("--method")) {
      if (options?.inputText) {
        const parsed = JSON.parse(options.inputText) as { body?: string };
        if (typeof parsed.body === "string") lastBody = parsed.body;
      }
      return { id };
    }
    return { id, body: lastBody };
  };
  return vi.fn(fn) as unknown as RunGhApiFn;
}

const itSymlink = it.skipIf(process.platform === "win32");
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

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

const CROSS_REPO_XBRIEF = {
  ...ORIGIN_XBRIEF,
  plan: {
    ...ORIGIN_XBRIEF.plan,
    references: [
      {
        uri: "https://github.com/other/victim/issues/99",
        type: "x-xbrief/github-issue",
        title: "Issue #99",
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

  it("sanitizes embedded newlines in inline markdown fields", () => {
    const body = buildSyncComment(
      {
        plan: {
          title: "Broken\nTitle",
          status: "running",
          items: [{ title: "Item\nOne", status: "pending" }],
        },
      },
      "xbrief/active/example.xbrief.json",
    );
    expect(body).toContain("**Scope:** Broken Title");
    expect(body).toContain("Item One");
    expect(body).not.toMatch(/\*\*Scope:\*\* Broken\nTitle/);
  });
});

describe("issue-sync sanitizeMarkdownInline", () => {
  it("collapses newlines to spaces", () => {
    expect(sanitizeMarkdownInline("a\nb")).toBe("a b");
  });
});

describe("issue-sync cli parseArgs", () => {
  it("errors when --repo is missing its value", () => {
    expect(parseArgs(["--repo"]).error).toContain("--repo");
  });
});

describe("issue-sync dry-run and missing origin", () => {
  it("dry-run prints comment without posting", () => {
    const out: string[] = [];
    const err: string[] = [];
    const runFn = vi.fn();
    const { xbriefPath } = writeTempXbrief(ORIGIN_XBRIEF);
    const code = syncFromXbrief({
      xbriefPath,
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
    const { xbriefPath } = writeTempXbrief({
      plan: { title: "orphan", status: "running", items: [] },
    });
    const code = syncFromXbrief({
      xbriefPath,
      dryRun: true,
      writeErr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no linked GitHub issue origin");
  });

  it("skips posting when fingerprint matches stored metadata", () => {
    const snapshot = extractSyncSnapshot(ORIGIN_XBRIEF);
    const { xbriefPath, projectRoot } = writeTempXbrief({
      ...ORIGIN_XBRIEF,
      plan: {
        ...ORIGIN_XBRIEF.plan,
        metadata: {
          issueSync: { fingerprint: fingerprintSyncSnapshot(snapshot) },
        },
      },
    });
    const out: string[] = [];
    const runFn = vi.fn();
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      repo: "deftai/directive",
      writeOut: (line) => out.push(line),
      runFn,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("nothing to post");
    expect(runFn).not.toHaveBeenCalled();
  });

  it("posts comment and persists fingerprint on happy path", () => {
    const { xbriefPath, projectRoot } = writeTempXbrief(ORIGIN_XBRIEF);
    const runFn = mockCommentRunFn(999);
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      repo: "deftai/directive",
      runFn,
    });
    expect(code).toBe(0);
    expect(runFn).toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(xbriefPath, "utf8")) as Record<string, unknown>;
    const plan = saved.plan as Record<string, unknown>;
    const metadata = plan.metadata as Record<string, unknown>;
    const issueSync = metadata.issueSync as Record<string, unknown>;
    expect(issueSync.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(issueSync.issueNumber).toBe(2540);
  });

  it("reports fingerprint persistence failure separately after posting", () => {
    const { xbriefPath, projectRoot } = writeTempXbrief(ORIGIN_XBRIEF);
    const err: string[] = [];
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      repo: "deftai/directive",
      runFn: mockCommentRunFn(1001),
      writeFingerprint: () => {
        throw new Error("read-only");
      },
      writeErr: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("comment posted (id: 1001)");
    expect(err.join("\n")).toContain("failed to persist sync fingerprint");
    expect(err.join("\n")).not.toContain("failed to post comment");
  });

  it("refuses cross-repo comment mutation without allowCrossRepo (#2633)", () => {
    const err: string[] = [];
    const runFn = vi.fn();
    const { xbriefPath, projectRoot } = writeTempXbrief(CROSS_REPO_XBRIEF);
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      repo: "deftai/directive",
      writeErr: (line) => err.push(line),
      runFn,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/refusing cross-repo mutation/);
    expect(runFn).not.toHaveBeenCalled();
  });

  it("allows cross-repo comment mutation when allowCrossRepo is set (#2633)", () => {
    const { xbriefPath, projectRoot } = writeTempXbrief(CROSS_REPO_XBRIEF);
    const runFn = mockCommentRunFn(1002);
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      repo: "deftai/directive",
      allowCrossRepo: true,
      runFn,
    });
    expect(code).toBe(0);
    expect(runFn).toHaveBeenCalled();
  });

  it("allows cross-repo comment mutation when target is allowlisted (#2633)", () => {
    const { xbriefPath, projectRoot } = writeTempXbrief(CROSS_REPO_XBRIEF);
    const runFn = mockCommentRunFn(1003);
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      repo: "deftai/directive",
      repoAllowlist: ["other/victim"],
      runFn,
    });
    expect(code).toBe(0);
    expect(runFn).toHaveBeenCalled();
  });

  it("refuses cross-repo dry-run without allowCrossRepo (#2633)", () => {
    const err: string[] = [];
    const runFn = vi.fn();
    const { xbriefPath, projectRoot } = writeTempXbrief(CROSS_REPO_XBRIEF);
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      dryRun: true,
      repo: "deftai/directive",
      writeErr: (line) => err.push(line),
      runFn,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/refusing cross-repo mutation/);
    expect(runFn).not.toHaveBeenCalled();
  });

  it("allows same-repo sync when --repo is a full GitHub URL (#2633)", () => {
    const { xbriefPath, projectRoot } = writeTempXbrief(ORIGIN_XBRIEF);
    const runFn = mockCommentRunFn(1004);
    const code = syncFromXbrief({
      xbriefPath,
      projectRoot,
      repo: "https://github.com/deftai/directive",
      runFn,
    });
    expect(code).toBe(0);
    expect(runFn).toHaveBeenCalled();
  });

  itSymlink(
    "refuses fingerprint persist when xBRIEF is a symlink outside the project (#2710)",
    () => {
      const root = mkdtempSync(join(tmpdir(), "issue-sync-project-"));
      tempRoots.push(root);
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      writeFileSync(
        join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
        `${JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "Project", status: "running", items: [] },
        })}\n`,
        "utf8",
      );
      const escapeDir = mkdtempSync(join(tmpdir(), "issue-sync-escape-"));
      tempRoots.push(escapeDir);
      const victim = join(escapeDir, "scope.xbrief.json");
      writeFileSync(victim, `${JSON.stringify(ORIGIN_XBRIEF, null, 2)}\n`, "utf8");
      const linkedPath = join(root, "xbrief", "active", "scope.xbrief.json");
      symlinkSync(victim, linkedPath);

      const runFn = mockCommentRunFn(2001);
      const err: string[] = [];
      const code = syncFromXbrief({
        xbriefPath: linkedPath,
        projectRoot: root,
        repo: "deftai/directive",
        runFn,
        writeErr: (line) => err.push(line),
      });
      expect(code).toBe(1);
      expect(runFn).toHaveBeenCalled();
      expect(err.join("\n")).toMatch(/projection write refused|symlink/);
      expect(readFileSync(victim, "utf8")).not.toContain('"issueSync"');
    },
  );
});

function writeTempXbrief(data: Record<string, unknown>): {
  xbriefPath: string;
  projectRoot: string;
} {
  const projectRoot = mkdtempSync(join(tmpdir(), "issue-sync-"));
  tempRoots.push(projectRoot);
  mkdirSync(join(projectRoot, "xbrief", "active"), { recursive: true });
  writeFileSync(
    join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Fixture", status: "running", items: [] },
    })}\n`,
    "utf8",
  );
  const xbriefPath = join(projectRoot, "xbrief", "active", "scope.xbrief.json");
  writeFileSync(xbriefPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { xbriefPath, projectRoot };
}
