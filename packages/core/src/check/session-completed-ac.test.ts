import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newRitualStatePayload, writeRitualState } from "../session/ritual-sentinel.js";
import {
  type CollectedChangeSet,
  collectLifecycleChangeSet,
  evaluateLifecycleMaintenanceEligibility,
  gitPathToProjectRel,
  isLifecycleMaintenancePath,
  resolveSessionCompletedVerifyAcTarget,
  SESSION_COMPLETED_AC_REMEDIATION,
  writeSessionCompletedMarker,
} from "./session-completed-ac.js";

function writeCompleted(
  root: string,
  name: string,
  meta: Record<string, unknown>,
  dirName = "xbrief",
): string {
  const dir = join(root, dirName, "completed");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: name,
        status: "completed",
        metadata: meta,
      },
    }),
    "utf8",
  );
  return path;
}

describe("resolveSessionCompletedVerifyAcTarget (#3357)", () => {
  it("returns none when no completed briefs exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-none-"));
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none when session is unknown even if completed briefs exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-unk-"));
    writeCompleted(root, "old.xbrief.json", {
      completedAt: "2026-01-01T00:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        env: {},
      }),
    ).toEqual({ kind: "none" });
  });

  it("targets the most recent same-session completed brief", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-hit-"));
    writeCompleted(root, "older.xbrief.json", {
      completedAt: "2026-08-14T10:00:00Z",
      completedSessionId: "sess-1",
    });
    const latest = writeCompleted(root, "newer.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-1",
    });
    writeCompleted(root, "other-session.xbrief.json", {
      completedAt: "2026-08-14T13:00:00Z",
      completedSessionId: "sess-2",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
      }),
    ).toEqual({ kind: "target", path: latest });
  });

  it("does not mix DEFT_SESSION_ID with a different ritual startedAt", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-mix-"));
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "ritual-sess",
        gitHead: "abc1234",
        worktreePath: root,
        startedAt: new Date("2026-08-14T10:00:00Z"),
      }),
    );
    writeCompleted(root, "unstamped.xbrief.json", {
      completedAt: "2026-08-14T11:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        env: { DEFT_SESSION_ID: "env-sess" },
      }),
    ).toEqual({ kind: "none" });
  });

  it("does not select a newer brief stamped for a different session", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-other-"));
    const ours = writeCompleted(root, "ours.xbrief.json", {
      completedAt: "2026-08-14T11:00:00Z",
      completedSessionId: "sess-1",
    });
    writeCompleted(root, "theirs.xbrief.json", {
      completedAt: "2026-08-14T13:00:00Z",
      completedSessionId: "sess-2",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
        sessionStartedAt: new Date("2026-08-14T10:00:00Z"),
      }),
    ).toEqual({ kind: "target", path: ours });
  });

  it("matches completedAt after session start when session id was not stamped", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-time-"));
    writeCompleted(root, "before.xbrief.json", {
      completedAt: "2026-08-14T09:00:00Z",
    });
    const during = writeCompleted(root, "during.xbrief.json", {
      completedAt: "2026-08-14T11:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-time",
        sessionStartedAt: new Date("2026-08-14T10:00:00Z"),
      }),
    ).toEqual({ kind: "target", path: during });
  });

  it("returns cannot when the last-completed marker is malformed even if other briefs exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-bad-marker-"));
    writeCompleted(root, "other.xbrief.json", {
      completedAt: "2026-08-14T10:00:00Z",
      completedSessionId: "sess-other",
    });
    mkdirSync(join(root, ".deft", "cache"), { recursive: true });
    writeFileSync(join(root, ".deft", "cache", "last-completed.json"), "{not-json", "utf8");
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
      }),
    ).toEqual({ kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION });
  });

  it("returns cannot when this session marker path is unreadable even if other briefs exist", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-marker-"));
    writeCompleted(root, "other.xbrief.json", {
      completedAt: "2026-08-14T10:00:00Z",
      completedSessionId: "sess-other",
    });
    const dest = join(root, "xbrief", "completed", "ours-broken.xbrief.json");
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeFileSync(dest, "{not-json", "utf8");
    writeSessionCompletedMarker(root, {
      path: dest,
      sessionId: "sess-1",
      completedAt: "2026-08-14T12:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
      }),
    ).toEqual({ kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION });
  });

  it("ignores historical completed briefs that have plan but no metadata (#3375)", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-legacy-"));
    const dir = join(root, "xbrief", "completed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "legacy.xbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "legacy", status: "completed", items: [] },
      }),
      "utf8",
    );
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
        sessionStartedAt: new Date("2026-08-14T22:14:06Z"),
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns cannot when an unreadable completed brief exists beside another session", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-mixed-"));
    writeCompleted(root, "other.xbrief.json", {
      completedAt: "2026-08-14T10:00:00Z",
      completedSessionId: "sess-other",
    });
    const dest = join(root, "xbrief", "completed", "ours-broken.xbrief.json");
    writeFileSync(dest, "{not-json", "utf8");
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
      }),
    ).toEqual({ kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION });
  });

  it("returns cannot with the single remediation when every completed brief is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-bad-"));
    const dir = join(root, "xbrief", "completed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.xbrief.json"), "{not-json", "utf8");
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-bad",
      }),
    ).toEqual({ kind: "cannot", message: SESSION_COMPLETED_AC_REMEDIATION });
  });
});

function changeSet(
  entries: readonly { path: string; addedOrRenamed?: boolean; addedOrModified?: boolean }[],
): CollectedChangeSet {
  const flagsByPath = new Map(
    entries.map((e) => [
      e.path,
      {
        addedOrRenamed: e.addedOrRenamed === true,
        addedOrModified: e.addedOrModified === true,
      },
    ]),
  );
  return { ok: true, paths: entries.map((e) => e.path), flagsByPath };
}

describe("lifecycle-maintenance eligibility (#5477)", () => {
  it("admits the published set including plan-sequence and registry files", () => {
    expect(isLifecycleMaintenancePath(".deft/plan-sequence.json")).toBe(true);
    expect(isLifecycleMaintenancePath("xbrief/PROJECT-DEFINITION.xbrief.json")).toBe(true);
    expect(isLifecycleMaintenancePath("xbrief/specification.xbrief.json")).toBe(true);
    expect(isLifecycleMaintenancePath("CHANGELOG.md")).toBe(true);
    expect(isLifecycleMaintenancePath("xbrief/completed/a.xbrief.json")).toBe(true);
    expect(isLifecycleMaintenancePath("src/service.ts")).toBe(false);
    expect(isLifecycleMaintenancePath("server.js")).toBe(false);
    expect(isLifecycleMaintenancePath("app/api/route.ts")).toBe(false);
    expect(isLifecycleMaintenancePath("package.json")).toBe(false);
    expect(isLifecycleMaintenancePath(".deft/test-boundary.policy.json")).toBe(false);
  });

  it("keeps targeting for lifecycle-only out-of-diff walks (rapid waives #4866)", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-life-skip-"));
    const target = writeCompleted(root, "done.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-1",
    });
    writeSessionCompletedMarker(root, {
      path: target,
      sessionId: "sess-1",
      completedAt: "2026-08-14T12:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
        changeSet: changeSet([
          { path: ".deft/plan-sequence.json", addedOrModified: true },
          { path: "xbrief/PROJECT-DEFINITION.xbrief.json", addedOrModified: true },
          { path: "xbrief/specification.xbrief.json", addedOrModified: true },
        ]),
      }),
    ).toEqual({ kind: "target", path: target });
    expect(
      evaluateLifecycleMaintenanceEligibility({
        projectRoot: root,
        walkTargetAbsOrRel: target,
        changeSet: changeSet([
          { path: ".deft/plan-sequence.json", addedOrModified: true },
          { path: "xbrief/PROJECT-DEFINITION.xbrief.json", addedOrModified: true },
          { path: "xbrief/specification.xbrief.json", addedOrModified: true },
        ]),
      }),
    ).toEqual({ kind: "skip-targeting" });
  });

  it("keeps targeting when an unmatched product path is present", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-life-prod-"));
    const target = writeCompleted(root, "done.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-1",
    });
    writeSessionCompletedMarker(root, {
      path: target,
      sessionId: "sess-1",
      completedAt: "2026-08-14T12:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
        changeSet: changeSet([
          { path: ".deft/plan-sequence.json", addedOrModified: true },
          { path: "src/service.ts", addedOrModified: true },
        ]),
      }),
    ).toEqual({ kind: "target", path: target });
  });

  it("keeps targeting for unmatched executables and policy rewrites", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-life-exe-"));
    const target = writeCompleted(root, "done.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-1",
    });
    for (const bad of ["server.js", "app/api/route.ts", ".deft/test-boundary.policy.json"]) {
      expect(
        resolveSessionCompletedVerifyAcTarget({
          projectRoot: root,
          sessionId: "sess-1",
          changeSet: changeSet([{ path: bad, addedOrModified: true }]),
        }),
      ).toEqual({ kind: "target", path: target });
    }
  });

  it("keeps targeting when merge-base collection fails", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-life-fail-"));
    const target = writeCompleted(root, "done.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-1",
    });
    writeSessionCompletedMarker(root, {
      path: target,
      sessionId: "sess-1",
      completedAt: "2026-08-14T12:00:00Z",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
        changeSet: { ok: false, reason: "no merge-base ref" },
      }),
    ).toEqual({ kind: "target", path: target });
  });

  it("keeps targeting when the walk target itself is added or renamed", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-life-add-"));
    const target = writeCompleted(root, "done.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-1",
    });
    const rel = "xbrief/completed/done.xbrief.json";
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
        changeSet: changeSet([
          { path: rel, addedOrRenamed: true, addedOrModified: true },
          { path: "CHANGELOG.md", addedOrModified: true },
        ]),
      }),
    ).toEqual({ kind: "target", path: target });
  });

  it("names the in-diff completed overlay for leftover-complete shapes", () => {
    const decision = evaluateLifecycleMaintenanceEligibility({
      projectRoot: "/repo",
      walkTargetAbsOrRel: "xbrief/completed/done.xbrief.json",
      changeSet: changeSet([
        {
          path: "xbrief/completed/done.xbrief.json",
          addedOrRenamed: true,
          addedOrModified: true,
        },
        { path: "CHANGELOG.md", addedOrModified: true },
      ]),
    });
    expect(decision).toEqual({
      kind: "in-diff-completed-overlay",
      walkTargetRel: "xbrief/completed/done.xbrief.json",
    });
  });

  it("does not select a foreign-session completed brief", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-ac-life-foreign-"));
    writeCompleted(root, "theirs.xbrief.json", {
      completedAt: "2026-08-14T12:00:00Z",
      completedSessionId: "sess-other",
    });
    expect(
      resolveSessionCompletedVerifyAcTarget({
        projectRoot: root,
        sessionId: "sess-1",
        changeSet: changeSet([{ path: "CHANGELOG.md", addedOrModified: true }]),
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("gitPathToProjectRel (#5477 nested)", () => {
  it("strips the project prefix under a monorepo toplevel", () => {
    expect(gitPathToProjectRel("/repo/apps/demo", "/repo", "apps/demo/CHANGELOG.md")).toBe(
      "CHANGELOG.md",
    );
    expect(
      gitPathToProjectRel("/repo/apps/demo", "/repo", "apps/demo/xbrief/completed/a.xbrief.json"),
    ).toBe("xbrief/completed/a.xbrief.json");
  });

  it("keeps outside-project paths unmatched", () => {
    expect(gitPathToProjectRel("/repo/apps/demo", "/repo", "apps/other/src/x.ts")).toBe(
      "apps/other/src/x.ts",
    );
    expect(isLifecycleMaintenancePath("apps/other/src/x.ts")).toBe(false);
  });

  it("maps toplevel-relative untracked product paths out of lifecycle (#5477)", () => {
    expect(gitPathToProjectRel("/repo/apps/demo", "/repo", "apps/demo/server.js")).toBe(
      "server.js",
    );
    expect(isLifecycleMaintenancePath("server.js")).toBe(false);
  });

  it("runs nested-project diffs from the git toplevel", () => {
    const projectRoot = "/repo/apps/demo";
    const diffCwds: string[] = [];
    const runGit = (cwd: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined === "rev-parse --is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (joined === "rev-parse --show-toplevel") {
        return { code: 0, stdout: "/repo\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { code: 0, stdout: "abc\n", stderr: "" };
      }
      if (args.includes("diff") && args.includes("--name-status")) {
        diffCwds.push(cwd.replace(/\\/g, "/"));
        if (joined.includes("...HEAD")) {
          return {
            code: 0,
            stdout: "M\0apps/demo/CHANGELOG.md\0M\0apps/other/src/x.ts\0",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("ls-files")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${cwd} ${joined}` };
    };
    const collected = collectLifecycleChangeSet({
      projectRoot,
      runGit,
      baseRef: "origin/master",
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(diffCwds.every((cwd) => cwd === "/repo")).toBe(true);
    expect(collected.paths.sort()).toEqual(["CHANGELOG.md", "apps/other/src/x.ts"]);
    expect(
      evaluateLifecycleMaintenanceEligibility({
        projectRoot,
        walkTargetAbsOrRel: "xbrief/completed/done.xbrief.json",
        changeSet: collected,
      }).kind,
    ).toBe("keep-targeting");
  });

  it("lists untracked files from the git toplevel for nested projects", () => {
    const projectRoot = "/repo/apps/demo";
    const runGit = (cwd: string, args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined === "rev-parse --is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (joined === "rev-parse --show-toplevel") {
        return { code: 0, stdout: "/repo\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { code: 0, stdout: "abc\n", stderr: "" };
      }
      if (args.includes("diff") && args.includes("--name-status")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("ls-files")) {
        expect(cwd.replace(/\\/g, "/")).toBe("/repo");
        return {
          code: 0,
          stdout: "apps/demo/CHANGELOG.md\0apps/other/src/x.ts\0",
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${cwd} ${joined}` };
    };
    const collected = collectLifecycleChangeSet({
      projectRoot,
      runGit,
      baseRef: "origin/master",
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.paths.sort()).toEqual(["CHANGELOG.md", "apps/other/src/x.ts"]);
    expect(
      evaluateLifecycleMaintenanceEligibility({
        projectRoot,
        walkTargetAbsOrRel: "xbrief/completed/done.xbrief.json",
        changeSet: collected,
      }).kind,
    ).toBe("keep-targeting");
  });
});
