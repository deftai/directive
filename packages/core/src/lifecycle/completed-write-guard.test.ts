import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_TWIN_RESTAMP_REMEDIATION,
  CLOSED_ISSUE_PARK_REMEDIATION,
  COMPLETED_WRITE_GUARD_MAX_BYTES,
  evaluateCompletedWriteGuard,
  scanCompletedWriteCorpus,
  UNPAIRED_ACTIVE_DELETE_REMEDIATION,
} from "./completed-write-guard.js";

function isolatedGitEnv(projectRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.DEFT_BASE_REF;
  delete env.GITHUB_BASE_REF;
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(projectRoot));
  env.GIT_AUTHOR_NAME = "t";
  env.GIT_AUTHOR_EMAIL = "t@t.test";
  env.GIT_COMMITTER_NAME = "t";
  env.GIT_COMMITTER_EMAIL = "t@t.test";
  return env;
}

function gitOk(args: string[], cwd: string): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnv(cwd),
  });
  expect(r.status, `${args.join(" ")}\n${r.stderr ?? ""}${r.stdout ?? ""}`).toBe(0);
}

function husk(status = "completed"): string {
  return JSON.stringify({
    xBRIEFInfo: { version: "0.8" },
    plan: {
      title: "husk",
      status,
      metadata: { kind: "fix" },
    },
  });
}

function stamped(status = "completed"): string {
  const action = status === "failed" ? "fail" : status === "cancelled" ? "cancel" : "complete";
  return JSON.stringify({
    xBRIEFInfo: { version: "0.8" },
    plan: {
      title: "stamped",
      status,
      metadata: {
        lifecycleWrite: {
          action,
          writtenAt: "2026-08-25T00:00:00Z",
        },
      },
    },
  });
}

function runningSource(title = "stamped"): string {
  return JSON.stringify({
    xBRIEFInfo: { version: "0.8" },
    plan: { title, status: "running" },
  });
}

describe("evaluateCompletedWriteGuard (#3679)", () => {
  it("refuses a newly added completed/ husk", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-husk.xbrief.json", "src/app.ts"],
      payloads: new Map([["xbrief/completed/2026-08-25-husk.xbrief.json", husk()]]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/unguarded completed\/ add/);
    expect(result.message).toMatch(/leftover land PR \(#3476\)/);
    expect(result.findings).toHaveLength(1);
  });

  it("accepts a newly added completed/ blob with a transition write", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-ok.xbrief.json"],
      payloads: new Map([["xbrief/completed/2026-08-25-ok.xbrief.json", stamped()]]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("accepts a failed completion without provenance", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-fail.xbrief.json"],
      payloads: new Map([["xbrief/completed/2026-08-25-fail.xbrief.json", husk("failed")]]),
    });
    expect(result.code).toBe(0);
  });

  it("ignores added files outside completed/", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/active/story.xbrief.json", "CHANGELOG.md"],
      payloads: new Map([["xbrief/active/story.xbrief.json", husk()]]),
    });
    expect(result.code).toBe(0);
  });

  it("refuses an added completed/ blob with unreadable plan JSON", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-bad.xbrief.json"],
      payloads: new Map([["xbrief/completed/2026-08-25-bad.xbrief.json", "{not json"]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.detail).toMatch(/unreadable plan/);
  });

  it("refuses an added completed/ blob that is missing on disk", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-missing.xbrief.json"],
    });
    expect(result.code).toBe(1);
    expect(result.findings[0]?.detail).toMatch(/unreadable$/);
  });

  it("accepts a vbrief/completed stamp the same as xbrief/", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["vbrief/completed/2026-08-25-ok.xbrief.json"],
      payloads: new Map([["vbrief/completed/2026-08-25-ok.xbrief.json", stamped()]]),
    });
    expect(result.code).toBe(0);
  });

  it("skips when the project root is not a git working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-nongit-"));
    try {
      const result = evaluateCompletedWriteGuard(root);
      expect(result.code).toBe(0);
      expect(result.message).toMatch(/skipped -- not a git working tree/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an over-limit completed/ artifact through the controlled path", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-oversize-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      const rel = "xbrief/completed/2026-08-25-huge.xbrief.json";
      writeFileSync(join(root, rel), "x".repeat(COMPLETED_WRITE_GUARD_MAX_BYTES + 1), "utf8");
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.detail).toContain(rel);
      expect(result.findings[0]?.detail).toContain(
        `${String(COMPLETED_WRITE_GUARD_MAX_BYTES)}-byte read limit`,
      );
      expect(result.message).toMatch(/unguarded completed\/ add/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a stamped completed/ artifact under the read limit from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-undersize-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      const rel = "xbrief/completed/2026-08-25-ok.xbrief.json";
      writeFileSync(join(root, rel), stamped(), "utf8");
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a newly added completed/ path that is not a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-dir-"));
    try {
      const rel = "xbrief/completed/2026-08-25-dir.xbrief.json";
      mkdirSync(join(root, rel), { recursive: true });
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings[0]?.detail).toMatch(/not a regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a newly added completed/ symlink without following it", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-link-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      const target = join(root, "target.json");
      writeFileSync(target, husk(), "utf8");
      const rel = "xbrief/completed/2026-08-25-link.xbrief.json";
      try {
        symlinkSync(target, join(root, rel));
      } catch {
        return;
      }
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings[0]?.detail).toMatch(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a completed/ path whose parent directory is a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-parent-link-"));
    try {
      const realDir = join(root, "real-completed");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "2026-08-25-link.xbrief.json"), husk(), "utf8");
      mkdirSync(join(root, "xbrief"), { recursive: true });
      const rel = "xbrief/completed/2026-08-25-link.xbrief.json";
      try {
        symlinkSync(realDir, join(root, "xbrief", "completed"), "dir");
      } catch {
        return;
      }
      const result = evaluateCompletedWriteGuard(root, { addedFiles: [rel] });
      expect(result.code).toBe(1);
      expect(result.findings[0]?.detail).toMatch(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a git tree has no merge-base ref", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-nobase-"));
    try {
      const init = spawnSync("git", ["init", "-q", "-b", "deft-no-base"], {
        cwd: root,
        encoding: "utf8",
        env: isolatedGitEnv(root),
      });
      expect(init.status, String(init.stderr ?? "")).toBe(0);
      const result = evaluateCompletedWriteGuard(root);
      expect(result.code).toBe(2);
      expect(result.message).toMatch(
        /no merge-base ref found|base ref .* not found|Pass --base-ref/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the base ref has no merge-base with HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-unrelated-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      gitOk(["checkout", "--orphan", "other"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "other"], root);
      const result = evaluateCompletedWriteGuard(root, { baseRef: "master" });
      expect(result.code).toBe(2);
      expect(result.message).toMatch(
        /committed change-set unavailable|no merge base|Pass --base-ref/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scanCompletedWriteCorpus (#3679)", () => {
  it("reports historical husks as findings and ignores stamped files", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-corpus-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "husk.xbrief.json"), husk(), "utf8");
      writeFileSync(join(dir, "ok.xbrief.json"), stamped(), "utf8");
      const result = scanCompletedWriteCorpus(root);
      expect(result.scanned).toBe(2);
      expect(result.findings.map((f) => f.relPath)).toEqual(["xbrief/completed/husk.xbrief.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips unreadable and invalid corpus blobs without counting them as husks", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-corpus-bad-"));
    try {
      const dir = join(root, "xbrief", "completed");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "empty-dir-placeholder.xbrief.json"), "[", "utf8");
      mkdirSync(join(dir, "dir-not-file.xbrief.json"));
      const result = scanCompletedWriteCorpus(root);
      expect(result.scanned).toBe(2);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluateCompletedWriteGuard (#3766 active deletion)", () => {
  const active = "xbrief/active/2026-08-25-story.xbrief.json";
  const completed = "xbrief/completed/2026-08-25-story.xbrief.json";
  const ISSUE_URI = "https://github.com/deftai/directive/issues/4784";
  const OTHER_ISSUE_URI = "https://github.com/deftai/directive/issues/3766";

  function withOrigin(
    raw: string,
    uri: string,
    extra?: {
      items?: Array<Record<string, unknown>>;
      narratives?: Record<string, string>;
      id?: string;
    },
  ): string {
    const data = JSON.parse(raw) as {
      plan: {
        items?: Array<Record<string, unknown>>;
        narratives?: Record<string, string>;
        references?: Array<{ type: string; uri: string }>;
        id?: string;
      };
    };
    data.plan.references = [{ type: "x-xbrief/github-issue", uri }];
    if (extra?.items !== undefined) {
      data.plan.items = extra.items;
    }
    if (extra?.narratives !== undefined) {
      data.plan.narratives = extra.narratives;
    }
    if (extra?.id !== undefined) {
      data.plan.id = extra.id;
    }
    return JSON.stringify(data);
  }

  function expectPaired(srcJson: string, destJson: string): void {
    const shapes = [`D\t${active}\nA\t${completed}`, `R100\t${active}\t${completed}`];
    for (const nameStatus of shapes) {
      const result = evaluateCompletedWriteGuard("/tmp/proj", {
        nameStatus,
        payloads: new Map([
          [completed, destJson],
          [active, srcJson],
        ]),
      });
      expect(result.code, nameStatus).toBe(0);
      expect(result.findings, nameStatus).toHaveLength(0);
    }
  }

  it("rejects an unaccompanied delete of an active brief", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}`,
    });
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.relPath).toBe(active);
    expect(result.message).toMatch(/no paired stamped destination/);
  });

  it("accepts a rename from active/ to a stamped completed/ destination", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${completed}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("rejects a rename whose dest title does not match the source", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${completed}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource("victim")],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("accepts a delete of active/ paired with a stamped completed/ add", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${completed}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("pairs a same-title dest whose plan.items titles differ", () => {
    expectPaired(
      withOrigin(runningSource(), ISSUE_URI, {
        items: [{ title: "story-item", status: "pending" }],
      }),
      withOrigin(stamped(), ISSUE_URI, {
        items: [{ title: "other-item", status: "pending" }],
      }),
    );
  });

  it("pairs a same-title dest whose narratives differ", () => {
    expectPaired(
      withOrigin(runningSource(), ISSUE_URI, {
        narratives: { Overview: "original" },
      }),
      withOrigin(stamped(), ISSUE_URI, {
        narratives: { Overview: "replacement" },
      }),
    );
  });

  it("rejects a copied stamp under the same basename with a different title", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${completed}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource("victim")],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("rejects a copied stamp under the same basename with a different origin", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${completed}`,
      payloads: new Map([
        [completed, withOrigin(stamped(), OTHER_ISSUE_URI)],
        [active, withOrigin(runningSource(), ISSUE_URI)],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("pairs a LifecycleRepair narrative add when title, origin, pairingKey, and complete stamp match", () => {
    expectPaired(
      withOrigin(runningSource(), ISSUE_URI, {
        narratives: { Overview: "original" },
      }),
      withOrigin(stamped(), ISSUE_URI, {
        narratives: { Overview: "original", LifecycleRepair: "added" },
      }),
    );
  });

  it("pairs a renamed item title when title, origin, pairingKey, and complete stamp match", () => {
    expectPaired(
      withOrigin(runningSource(), ISSUE_URI, {
        items: [{ title: "old-item", status: "pending" }],
      }),
      withOrigin(stamped(), ISSUE_URI, {
        items: [{ title: "renamed-item", status: "completed" }],
      }),
    );
  });

  it("pairs an added clause_1 item when title, origin, pairingKey, and complete stamp match", () => {
    expectPaired(
      withOrigin(runningSource(), ISSUE_URI, {
        items: [{ title: "story-item", status: "pending" }],
      }),
      withOrigin(stamped(), ISSUE_URI, {
        items: [
          { title: "story-item", status: "completed" },
          { id: "clause_1", title: "clause_1", status: "pending" },
        ],
      }),
    );
  });

  it("pairs when plan.id differs but title, origin, pairingKey, and complete stamp match", () => {
    expectPaired(
      withOrigin(runningSource(), ISSUE_URI, { id: "github.issue.123" }),
      withOrigin(stamped(), ISSUE_URI, { id: "github.issue.999" }),
    );
  });

  it("rejects a same-identity dest under a different basename", () => {
    const other = "xbrief/completed/2026-08-25-other.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${other}`,
      payloads: new Map([
        [other, withOrigin(stamped(), ISSUE_URI)],
        [active, withOrigin(runningSource(), ISSUE_URI)],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("rejects an unstamped cancelled dest as authorization for an active delete", () => {
    const cancelled = "xbrief/cancelled/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${cancelled}`,
      payloads: new Map([[cancelled, husk()]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
    expect(result.message).toMatch(/no paired stamped destination/);
  });

  it("rejects a cancelled dest even when plan.status is cancelled", () => {
    const cancelled = "xbrief/cancelled/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${cancelled}`,
      payloads: new Map([[cancelled, husk("cancelled")]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
    expect(result.message).toMatch(/no paired stamped destination/);
  });

  it("rejects a rename from active/ to an unstamped cancelled dest", () => {
    const cancelled = "xbrief/cancelled/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${cancelled}`,
      payloads: new Map([[cancelled, husk("cancelled")]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("accepts a rename from active/ to a cancel-stamped cancelled dest", () => {
    const cancelled = "xbrief/cancelled/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${cancelled}`,
      payloads: new Map([
        [cancelled, stamped("cancelled")],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("refuses a cancel stamp added under completed/", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      addedFiles: ["xbrief/completed/2026-08-25-ok.xbrief.json"],
      payloads: new Map([["xbrief/completed/2026-08-25-ok.xbrief.json", stamped("cancelled")]]),
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/unguarded completed\/ add/);
  });

  it("accepts a rename from active/ to proposed/ with plan.status proposed", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "stamped",
        status: "proposed",
        items: [{ title: "clause", status: "pending", id: "clause.1" }],
      },
    });
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("accepts a rename from active/ to proposed/ with plan.status draft", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "stamped", status: "draft" },
    });
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("accepts D+A from active/ to proposed/ with matching identity", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "stamped", status: "proposed" },
    });
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("rejects a rename from active/ to proposed/ when plan.status is cancelled", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "stamped", status: "cancelled" },
    });
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
    expect(result.message).toMatch(/no paired stamped destination/);
  });

  it("pairs proposed dest when metadata is null or an array", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    for (const metadata of [null, []]) {
      const dest = JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "stamped", status: "proposed", metadata },
      });
      const result = evaluateCompletedWriteGuard("/tmp/proj", {
        nameStatus: `R100\t${active}\t${proposed}`,
        payloads: new Map([
          [proposed, dest],
          [active, runningSource()],
        ]),
      });
      expect(result.code, JSON.stringify(metadata)).toBe(0);
    }
  });

  it("pairs proposed dest when lifecycleWrite stamp is null or an array", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    for (const lifecycleWrite of [null, []]) {
      const dest = JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "stamped",
          status: "proposed",
          metadata: { lifecycleWrite },
        },
      });
      const result = evaluateCompletedWriteGuard("/tmp/proj", {
        nameStatus: `R100\t${active}\t${proposed}`,
        payloads: new Map([
          [proposed, dest],
          [active, runningSource()],
        ]),
      });
      expect(result.code, JSON.stringify(lifecycleWrite)).toBe(0);
    }
  });

  it("does not pair an unreadable proposed dest", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([[active, runningSource()]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("rejects a proposed dest that carries a cancel stamp", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "stamped",
        status: "proposed",
        metadata: {
          lifecycleWrite: { action: "cancel", writtenAt: "2026-08-25T00:00:00Z" },
        },
      },
    });
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("refuses a matching identity park to proposed/ when the GitHub issue is closed", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = withOrigin(
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "stamped", status: "proposed" },
      }),
      ISSUE_URI,
    );
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, withOrigin(runningSource(), ISSUE_URI)],
      ]),
      issueStates: new Map([[ISSUE_URI.toLowerCase(), "closed"]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
    expect(result.message).toMatch(/origin GitHub issue is closed/);
    expect(result.message).toContain(CLOSED_ISSUE_PARK_REMEDIATION);
  });

  it("accepts a matching identity park to proposed/ when the GitHub issue is open", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = withOrigin(
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "stamped", status: "proposed" },
      }),
      ISSUE_URI,
    );
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, withOrigin(runningSource(), ISSUE_URI)],
      ]),
      issueStates: new Map([[ISSUE_URI.toLowerCase(), "open"]]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("refuses cached closure when the live issue lookup fails", () => {
    const root = mkdtempSync(join(tmpdir(), "closed-park-cache-"));
    try {
      const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
      const dest = withOrigin(
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "stamped", status: "proposed" },
        }),
        ISSUE_URI,
      );
      const cacheDir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "4784");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "raw.json"),
        JSON.stringify({ number: 4784, state: "closed" }),
        "utf8",
      );
      const result = evaluateCompletedWriteGuard(root, {
        nameStatus: `D\t${active}\nA\t${proposed}`,
        payloads: new Map([
          [proposed, dest],
          [active, withOrigin(runningSource(), ISSUE_URI)],
        ]),
        runGh: () => ({ returncode: 1, stdout: "" }),
      });
      expect(result.code).toBe(1);
      expect(result.message).toContain(CLOSED_ISSUE_PARK_REMEDIATION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses live open state over stale cached closure", () => {
    const root = mkdtempSync(join(tmpdir(), "reopened-park-cache-"));
    try {
      const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
      const dest = withOrigin(
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "stamped", status: "proposed" },
        }),
        ISSUE_URI,
      );
      const cacheDir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "4784");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "raw.json"), JSON.stringify({ state: "closed" }), "utf8");

      const result = evaluateCompletedWriteGuard(root, {
        nameStatus: `D\t${active}\nA\t${proposed}`,
        payloads: new Map([
          [proposed, dest],
          [active, withOrigin(runningSource(), ISSUE_URI)],
        ]),
        runGh: () => ({ returncode: 0, stdout: JSON.stringify({ state: "open" }) }),
      });

      expect(result.code).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the issue URI hostname for a GitHub Enterprise lookup", () => {
    const enterpriseUri = "https://github.example.com:8443/acme/widgets/issues/42";
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = withOrigin(
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "stamped", status: "proposed" },
      }),
      enterpriseUri,
    );
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, withOrigin(runningSource(), enterpriseUri)],
      ]),
      runGh: (args) => {
        mutableCalls.push([...args]);
        return { returncode: 0, stdout: JSON.stringify({ state: "open" }) };
      },
    });
    expect(result.code).toBe(0);
    expect(calls).toEqual([
      ["gh", "api", "--hostname", "github.example.com:8443", "repos/acme/widgets/issues/42"],
    ]);
  });

  it("does not reuse github.com cached state for an Enterprise issue", () => {
    const root = mkdtempSync(join(tmpdir(), "enterprise-cache-host-"));
    try {
      const enterpriseUri = "https://ghe.example:8443/acme/widgets/issues/42";
      const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
      const dest = withOrigin(
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "stamped", status: "proposed" },
        }),
        enterpriseUri,
      );
      const cacheDir = join(root, ".deft-cache", "github-issue", "acme", "widgets", "42");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "raw.json"),
        JSON.stringify({
          state: "closed",
          html_url: "https://github.com/acme/widgets/issues/42",
        }),
        "utf8",
      );

      const result = evaluateCompletedWriteGuard(root, {
        nameStatus: `D\t${active}\nA\t${proposed}`,
        payloads: new Map([
          [proposed, dest],
          [active, withOrigin(runningSource(), enterpriseUri)],
        ]),
        runGh: () => ({ returncode: 1, stdout: "" }),
      });

      expect(result.code).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses cached Enterprise state only when its URL matches the requested host", () => {
    const root = mkdtempSync(join(tmpdir(), "enterprise-cache-match-"));
    try {
      const enterpriseUri = "https://ghe.example:8443/acme/widgets/issues/42";
      const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
      const dest = withOrigin(
        JSON.stringify({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "stamped", status: "proposed" },
        }),
        enterpriseUri,
      );
      const cacheDir = join(root, ".deft-cache", "github-issue", "acme", "widgets", "42");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "raw.json"),
        JSON.stringify({ state: "closed", html_url: enterpriseUri }),
        "utf8",
      );

      const result = evaluateCompletedWriteGuard(root, {
        nameStatus: `D\t${active}\nA\t${proposed}`,
        payloads: new Map([
          [proposed, dest],
          [active, withOrigin(runningSource(), enterpriseUri)],
        ]),
        runGh: () => ({ returncode: 1, stdout: "" }),
      });

      expect(result.code).toBe(1);
      expect(result.message).toContain(CLOSED_ISSUE_PARK_REMEDIATION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses proposed park when the live issue is closed", () => {
    const proposed = "xbrief/proposed/2026-08-25-story.xbrief.json";
    const dest = withOrigin(
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "stamped", status: "proposed" },
      }),
      ISSUE_URI,
    );
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `R100\t${active}\t${proposed}`,
      payloads: new Map([
        [proposed, dest],
        [active, withOrigin(runningSource(), ISSUE_URI)],
      ]),
      runGh: () => ({ returncode: 0, stdout: JSON.stringify({ state: "closed" }) }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain(CLOSED_ISSUE_PARK_REMEDIATION);
  });

  it("accepts a delete of active/ paired with a cancel-stamped cancelled dest of the same title", () => {
    const cancelled = "xbrief/cancelled/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${cancelled}`,
      payloads: new Map([
        [cancelled, stamped("cancelled")],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("rejects a stamped dest in the other lifecycle root as pairing", () => {
    const vbriefCompleted = "vbrief/completed/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nA\t${vbriefCompleted}`,
      payloads: new Map([[vbriefCompleted, stamped()]]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("halts lone-D cleanup naming scope:complete or leave untracked", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}`,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("scope:complete");
    expect(result.message).toContain("scope:cancel");
    expect(result.message).toMatch(/untracked/);
    expect(result.message).toContain(UNPAIRED_ACTIVE_DELETE_REMEDIATION);
  });

  it("pairs persist-on-complete clause:N dest against recovered HEAD src", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-persist-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
      const srcRel = "xbrief/active/2026-08-25-story.xbrief.json";
      const destRel = "xbrief/completed/2026-08-25-story.xbrief.json";
      const src = {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "stamped",
          status: "running",
          items: [{ title: "story-item", status: "pending" }],
          references: [{ type: "x-xbrief/github-issue", uri: ISSUE_URI }],
        },
      };
      writeFileSync(join(root, srcRel), JSON.stringify(src), "utf8");
      gitOk(["add", srcRel], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "track active"], root);
      gitOk(["rm", "-f", srcRel], root);
      const dest = {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "stamped",
          status: "completed",
          items: [
            { title: "story-item", status: "completed" },
            { id: "clause.1", title: "clause.1", status: "pending" },
          ],
          references: [{ type: "x-xbrief/github-issue", uri: ISSUE_URI }],
          metadata: {
            lifecycleWrite: {
              action: "complete",
              writtenAt: "2026-08-25T00:00:00Z",
            },
          },
        },
      };
      writeFileSync(join(root, destRel), JSON.stringify(dest), "utf8");
      const result = evaluateCompletedWriteGuard(root, { baseRef: "master" });
      expect(result.code).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unaccompanied active delete discovered from git", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-active-del-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      const dir = join(root, "xbrief", "active");
      mkdirSync(dir, { recursive: true });
      const rel = "xbrief/active/2026-08-25-other.xbrief.json";
      writeFileSync(join(root, rel), husk("running"), "utf8");
      gitOk(["add", rel], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "track active"], root);
      gitOk(["rm", "-f", rel], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "delete active"], root);
      const result = evaluateCompletedWriteGuard(root, { baseRef: "HEAD~1" });
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.relPath === rel)).toBe(true);
      expect(result.message).toMatch(/no paired stamped destination/);
      expect(result.message).toContain("scope:complete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a lone active deletion when the completed twin is already on the base (#4906)", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-base-twin-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
      writeFileSync(join(root, active), withOrigin(runningSource(), ISSUE_URI), "utf8");
      writeFileSync(join(root, completed), withOrigin(stamped(), ISSUE_URI), "utf8");
      gitOk(["add", active, completed], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "track twin"], root);
      const base = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: isolatedGitEnv(root),
      });
      expect(base.status).toBe(0);
      gitOk(["rm", "-f", active], root);
      const result = evaluateCompletedWriteGuard(root, { baseRef: base.stdout.trim() });
      expect(result.code).toBe(1);
      expect(result.findings.some((f) => f.relPath === active)).toBe(true);
      expect(result.message).toContain(ACTIVE_TWIN_RESTAMP_REMEDIATION);
      expect(result.message).not.toContain(UNPAIRED_ACTIVE_DELETE_REMEDIATION);
      expect(result.message).not.toContain("task scope:complete");
      expect(result.message).not.toContain("task scope:cancel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an active deletion paired with a complete-stamped completed modification (#4906)", () => {
    const injected = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource()],
      ]),
    });
    expect(injected.code).toBe(0);
    expect(injected.findings).toHaveLength(0);

    const root = mkdtempSync(join(tmpdir(), "completed-write-restamp-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
      writeFileSync(join(root, active), withOrigin(runningSource(), ISSUE_URI), "utf8");
      writeFileSync(join(root, completed), withOrigin(stamped(), ISSUE_URI), "utf8");
      gitOk(["add", active, completed], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "track twin"], root);
      const base = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: isolatedGitEnv(root),
      });
      expect(base.status).toBe(0);
      const modified = JSON.parse(withOrigin(stamped(), ISSUE_URI)) as {
        plan: { metadata: { lifecycleWrite: { writtenAt: string } } };
      };
      modified.plan.metadata.lifecycleWrite.writtenAt = "2026-09-22T18:00:00Z";
      writeFileSync(join(root, completed), JSON.stringify(modified), "utf8");
      gitOk(["rm", "-f", active], root);
      const shown = spawnSync(
        "git",
        ["diff", "-M", "--name-status", "--diff-filter=ARDM", "HEAD"],
        { cwd: root, encoding: "utf8", env: isolatedGitEnv(root) },
      );
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain("D\t" + active);
      expect(shown.stdout).toContain("M\t" + completed);
      expect(shown.stdout).not.toMatch(/^R/m);
      const result = evaluateCompletedWriteGuard(root, { baseRef: base.stdout.trim() });
      expect(result.code, result.message).toBe(0);
      expect(result.findings).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an active deletion when a committed completed restamp is restored to the merge-base blob (#4906)", () => {
    const root = mkdtempSync(join(tmpdir(), "completed-write-undone-restamp-"));
    try {
      gitOk(["init", "-q", "-b", "master"], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"], root);
      mkdirSync(join(root, "xbrief", "active"), { recursive: true });
      mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
      const originalCompleted = withOrigin(stamped(), ISSUE_URI);
      writeFileSync(join(root, active), withOrigin(runningSource(), ISSUE_URI), "utf8");
      writeFileSync(join(root, completed), originalCompleted, "utf8");
      gitOk(["add", active, completed], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "track twin"], root);
      const base = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        env: isolatedGitEnv(root),
      });
      expect(base.status).toBe(0);
      const baseSha = base.stdout.trim();
      const modified = JSON.parse(originalCompleted) as {
        plan: { metadata: { lifecycleWrite: { writtenAt: string } } };
      };
      modified.plan.metadata.lifecycleWrite.writtenAt = "2026-09-22T18:00:00Z";
      writeFileSync(join(root, completed), JSON.stringify(modified), "utf8");
      gitOk(["add", completed], root);
      gitOk(["-c", "commit.gpgsign=false", "commit", "-m", "restamp completed"], root);
      writeFileSync(join(root, completed), originalCompleted, "utf8");
      gitOk(["rm", "-f", active], root);
      const shown = spawnSync(
        "git",
        ["diff", "-M", "--name-status", "--diff-filter=ARDM", baseSha],
        { cwd: root, encoding: "utf8", env: isolatedGitEnv(root) },
      );
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain("D\t" + active);
      expect(shown.stdout).not.toContain(completed);
      const result = evaluateCompletedWriteGuard(root, { baseRef: baseSha });
      expect(result.code, result.message).toBe(1);
      expect(result.findings.some((f) => f.relPath === active)).toBe(true);
      expect(result.message).toContain(ACTIVE_TWIN_RESTAMP_REMEDIATION);
      expect(result.message).not.toContain(UNPAIRED_ACTIVE_DELETE_REMEDIATION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a completed modification whose identity does not match the active deletion (#4906)", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource("victim")],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("refuses an active deletion when the completed path is deleted in the same candidate (#4906)", () => {
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}\nD\t${completed}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("refuses an active deletion when the completed path is renamed away in the same candidate (#4906)", () => {
    const elsewhere = "xbrief/cancelled/2026-08-25-story.xbrief.json";
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}\nR100\t${completed}\t${elsewhere}`,
      payloads: new Map([
        [completed, stamped()],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("does not let an unstamped or non-complete modification authorize an active deletion (#4906)", () => {
    const unstamped = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}`,
      payloads: new Map([
        [completed, husk()],
        [active, runningSource("husk")],
      ]),
    });
    expect(unstamped.code).toBe(1);
    expect(unstamped.findings.some((f) => f.relPath === active)).toBe(true);

    const failed = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}`,
      payloads: new Map([
        [completed, stamped("failed")],
        [active, runningSource()],
      ]),
    });
    expect(failed.code).toBe(1);
    expect(failed.findings.some((f) => f.relPath === active)).toBe(true);

    const legacy = JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "stamped",
        status: "completed",
        metadata: { completedAt: "2026-08-25T00:00:00Z" },
      },
    });
    const legacyResult = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}`,
      payloads: new Map([
        [completed, legacy],
        [active, runningSource()],
      ]),
    });
    expect(legacyResult.code).toBe(1);
    expect(legacyResult.findings.some((f) => f.relPath === active)).toBe(true);
  });

  it("caps a completed modification and does not authorize the active deletion (#4906)", () => {
    const huge = "x".repeat(COMPLETED_WRITE_GUARD_MAX_BYTES + 1);
    const result = evaluateCompletedWriteGuard("/tmp/proj", {
      nameStatus: `D\t${active}\nM\t${completed}`,
      payloads: new Map([
        [completed, huge],
        [active, runningSource()],
      ]),
    });
    expect(result.code).toBe(1);
    expect(result.findings.some((f) => f.detail.includes("byte read limit"))).toBe(true);
    expect(result.findings.some((f) => f.relPath === active)).toBe(true);
  });
});
