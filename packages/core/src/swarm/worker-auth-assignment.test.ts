import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWorkerAuthAssignmentsForDispatch,
  FAILURE_MALFORMED_ASSIGNMENT,
  FAILURE_MISSING_ASSIGNMENT,
  FAILURE_ORPHAN_ASSIGNMENT,
  FAILURE_REGISTRY_CORRUPTION,
  readWorkerAuthAssignment,
  removeWorkerAuthAssignment,
  setWorkerAuthLockTestHooks,
  WORKER_AUTH_INDEX_NAME,
  WORKER_AUTH_LOCK_NAME,
  WORKER_AUTH_LOCK_STALE_MS,
  workerAuthRecordName,
  workerAuthStoreDir,
  writeWorkerAuthAssignment,
} from "./worker-auth-assignment.js";

const temps: string[] = [];
afterEach(() => {
  setWorkerAuthLockTestHooks(undefined);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
}

function linkedPair(): { main: string; worktree: string } {
  const main = mkdtempSync(join(tmpdir(), "wa-main-"));
  temps.push(main);
  gitInit(main);
  const worktree = mkdtempSync(join(tmpdir(), "wa-wt-"));
  temps.push(worktree);
  rmSync(worktree, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "-q", worktree, "HEAD"], { cwd: main });
  return { main, worktree };
}

describe("worker-auth-assignment (#3663)", { timeout: 20_000 }, () => {
  it("writes a record and index that the dest worktree can read", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-1");
    expect(read.assignment?.expected_principal.login).toBe("worker-a");
    expect(read.assignment?.credential_delivery_id).toBeNull();
    expect(JSON.stringify(read)).not.toMatch(/ghp_|gho_|github_pat_/i);
  });

  it("treats an unregistered worktree as null, not a failure", () => {
    const { worktree } = linkedPair();
    const read = readWorkerAuthAssignment(worktree);
    expect(read).toEqual({ ok: true, assignment: null, commonDir: expect.any(String) });
  });

  it("fails closed when the dest is registered but the record is missing", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "injected-token",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: "del-1",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const record = join(
      written.commonDir,
      "deft-worker-auth",
      workerAuthRecordName(written.assignment.worktree_path),
    );
    rmSync(record);
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failureKind).toBe(FAILURE_MISSING_ASSIGNMENT);
  });

  it("fails closed on an orphan record without index registration", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    writeFileSync(
      join(written.commonDir, "deft-worker-auth", "index.json"),
      JSON.stringify({
        schema_version: Number.parseInt("1", 10),
        entries: [],
      }),
    );
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failureKind).toBe(FAILURE_ORPHAN_ASSIGNMENT);
  });

  it("fails closed on a malformed record", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const record = join(
      written.commonDir,
      "deft-worker-auth",
      workerAuthRecordName(written.assignment.worktree_path),
    );
    writeFileSync(record, "{not-json\n");
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failureKind).toBe(FAILURE_MALFORMED_ASSIGNMENT);
  });

  it("finds a registered dest assignment from a subdirectory of that dest", () => {
    const { main, worktree } = linkedPair();
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    const nested = join(worktree, "packages", "core");
    mkdirSync(nested, { recursive: true });
    const read = readWorkerAuthAssignment(nested);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-1");
    expect(read.assignment?.worktree_path).toBe(written.ok ? written.assignment.worktree_path : "");
  });

  it("refuses a live lock and recovers a stale index.lock", () => {
    const { main, worktree } = linkedPair();
    const first = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lockAbs = join(workerAuthStoreDir(first.commonDir), WORKER_AUTH_LOCK_NAME);
    writeFileSync(lockAbs, "locked\n");
    const live = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-2",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-b" },
      credentialDeliveryId: null,
    });
    expect(live.ok).toBe(false);
    if (!live.ok) {
      expect(live.failureKind).toBe(FAILURE_REGISTRY_CORRUPTION);
      expect(live.detail).toMatch(/locked/);
    }
    const staleAt = (Date.now() - WORKER_AUTH_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lockAbs, staleAt, staleAt);
    const recovered = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-2",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-b" },
      credentialDeliveryId: null,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-2");
    expect(read.assignment?.expected_principal.login).toBe("worker-b");
  });

  it("does not steal a live owner lock even when mtime is stale", () => {
    const { main, worktree } = linkedPair();
    const first = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lockAbs = join(workerAuthStoreDir(first.commonDir), WORKER_AUTH_LOCK_NAME);
    writeFileSync(
      lockAbs,
      `${JSON.stringify({
        pid: process.pid,
        token: "live-owner",
        startedAt: "2020-01-01T00:00:00Z",
      })}\n`,
    );
    const staleAt = (Date.now() - WORKER_AUTH_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lockAbs, staleAt, staleAt);
    const stolen = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-2",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-b" },
      credentialDeliveryId: null,
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) {
      expect(stolen.failureKind).toBe(FAILURE_REGISTRY_CORRUPTION);
      expect(stolen.detail).toMatch(/locked/);
    }
    expect(readFileSync(lockAbs, "utf8")).toMatch(/live-owner/);
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-1");
  });

  it("owner cleanup does not unlink a replacement lock", () => {
    const { main, worktree } = linkedPair();
    setWorkerAuthLockTestHooks({
      afterAcquire: (commonDir) => {
        writeFileSync(
          join(workerAuthStoreDir(commonDir), WORKER_AUTH_LOCK_NAME),
          `${JSON.stringify({
            pid: process.pid,
            token: "replacement",
            startedAt: "2026-01-01T00:00:00Z",
          })}\n`,
        );
      },
    });
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const lockAbs = join(workerAuthStoreDir(written.commonDir), WORKER_AUTH_LOCK_NAME);
    expect(existsSync(lockAbs)).toBe(true);
    expect(readFileSync(lockAbs, "utf8")).toMatch(/replacement/);
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-1");
  });

  it("returns { ok: false } when index persist fails after the dest record write", () => {
    const { main, worktree } = linkedPair();
    setWorkerAuthLockTestHooks({
      beforeIndexWrite: (commonDir) => {
        mkdirSync(join(workerAuthStoreDir(commonDir), WORKER_AUTH_INDEX_NAME), {
          recursive: true,
        });
      },
    });
    const written = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(written.ok).toBe(false);
    if (!written.ok) {
      expect(written.failureKind).toBe(FAILURE_REGISTRY_CORRUPTION);
      expect(written.detail).toMatch(/write failed/);
    }
    const store = join(main, ".git", "deft-worker-auth");
    const leftover = existsSync(store)
      ? readdirSync(store).filter((name) => name.endsWith(".json") && name !== "index.json")
      : [];
    expect(leftover).toEqual([]);
  });

  it("overlapping writers after stale reclaim do not clobber each other", () => {
    const { main, worktree } = linkedPair();
    const other = mkdtempSync(join(tmpdir(), "wa-wt-overlap-"));
    temps.push(other);
    rmSync(other, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "-q", other, "HEAD"], { cwd: main });
    const first = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-seed",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lockAbs = join(workerAuthStoreDir(first.commonDir), WORKER_AUTH_LOCK_NAME);
    writeFileSync(lockAbs, "locked\n");
    const staleAt = (Date.now() - WORKER_AUTH_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lockAbs, staleAt, staleAt);
    setWorkerAuthLockTestHooks({
      afterStaleReclaim: () => {
        const inner = writeWorkerAuthAssignment({
          projectRoot: main,
          worktreePath: other,
          dispatchId: "dispatch-inner",
          storyId: "story-b",
          githubAuthMode: "host-gh",
          expectedPrincipal: { kind: "user", login: "worker-b" },
          credentialDeliveryId: null,
        });
        expect(inner.ok).toBe(true);
      },
    });
    const outer = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-outer",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(outer.ok).toBe(true);
    const keptInner = readWorkerAuthAssignment(other);
    expect(keptInner.ok).toBe(true);
    if (!keptInner.ok) return;
    expect(keptInner.assignment?.dispatch_id).toBe("dispatch-inner");
    const keptOuter = readWorkerAuthAssignment(worktree);
    expect(keptOuter.ok).toBe(true);
    if (!keptOuter.ok) return;
    expect(keptOuter.assignment?.dispatch_id).toBe("dispatch-outer");
  });

  it("reclaims a dead-pid lock without waiting for mtime", () => {
    const { main, worktree } = linkedPair();
    const first = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lockAbs = join(workerAuthStoreDir(first.commonDir), WORKER_AUTH_LOCK_NAME);
    writeFileSync(
      lockAbs,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "dead-owner",
        startedAt: "2020-01-01T00:00:00Z",
      })}\n`,
    );
    const recovered = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-2",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-b" },
      credentialDeliveryId: null,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-2");
  });

  it("does not steal a live replacement lock after inspecting a dead-pid lock", () => {
    const { main, worktree } = linkedPair();
    const first = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lockAbs = join(workerAuthStoreDir(first.commonDir), WORKER_AUTH_LOCK_NAME);
    writeFileSync(
      lockAbs,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "dead-owner",
        startedAt: "2020-01-01T00:00:00Z",
      })}\n`,
    );
    setWorkerAuthLockTestHooks({
      beforeReclaimRename: () => {
        writeFileSync(
          lockAbs,
          `${JSON.stringify({
            pid: process.pid,
            token: "live-replacement",
            startedAt: "2026-01-01T00:00:00Z",
          })}\n`,
        );
      },
    });
    const stolen = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-2",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-b" },
      credentialDeliveryId: null,
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) {
      expect(stolen.failureKind).toBe(FAILURE_REGISTRY_CORRUPTION);
      expect(stolen.detail).toMatch(/locked/);
    }
    expect(readFileSync(lockAbs, "utf8")).toMatch(/live-replacement/);
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-1");
  });

  it("does not steal a live replacement lock after inspecting a stale unreadable lock", () => {
    const { main, worktree } = linkedPair();
    const first = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-a" },
      credentialDeliveryId: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lockAbs = join(workerAuthStoreDir(first.commonDir), WORKER_AUTH_LOCK_NAME);
    writeFileSync(lockAbs, "locked\n");
    const staleAt = (Date.now() - WORKER_AUTH_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lockAbs, staleAt, staleAt);
    setWorkerAuthLockTestHooks({
      beforeReclaimRename: () => {
        writeFileSync(
          lockAbs,
          `${JSON.stringify({
            pid: process.pid,
            token: "live-replacement",
            startedAt: "2026-01-01T00:00:00Z",
          })}\n`,
        );
      },
    });
    const stolen = writeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-2",
      storyId: "story-a",
      githubAuthMode: "host-gh",
      expectedPrincipal: { kind: "user", login: "worker-b" },
      credentialDeliveryId: null,
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) {
      expect(stolen.failureKind).toBe(FAILURE_REGISTRY_CORRUPTION);
      expect(stolen.detail).toMatch(/locked/);
    }
    expect(readFileSync(lockAbs, "utf8")).toMatch(/live-replacement/);
    const read = readWorkerAuthAssignment(worktree);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.assignment?.dispatch_id).toBe("dispatch-1");
  });

  it("owner-bound remove leaves a foreign dispatch record", () => {
    const { main, worktree } = linkedPair();
    expect(
      writeWorkerAuthAssignment({
        projectRoot: main,
        worktreePath: worktree,
        dispatchId: "dispatch-1",
        storyId: "story-a",
        githubAuthMode: "host-gh",
        expectedPrincipal: { kind: "user", login: "worker-a" },
        credentialDeliveryId: null,
      }).ok,
    ).toBe(true);
    const skipped = removeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "other-dispatch",
    });
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.removed).toBe(false);
    expect(readWorkerAuthAssignment(worktree).ok).toBe(true);
    const removed = removeWorkerAuthAssignment({
      projectRoot: main,
      worktreePath: worktree,
      dispatchId: "dispatch-1",
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.removed).toBe(true);
    const read = readWorkerAuthAssignment(worktree);
    expect(read).toEqual({ ok: true, assignment: null, commonDir: expect.any(String) });
  });

  it("terminal cleanup removes only records for that dispatch", () => {
    const { main, worktree } = linkedPair();
    const other = mkdtempSync(join(tmpdir(), "wa-wt-other-"));
    temps.push(other);
    rmSync(other, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "-q", other, "HEAD"], { cwd: main });
    expect(
      writeWorkerAuthAssignment({
        projectRoot: main,
        worktreePath: worktree,
        dispatchId: "dispatch-keep",
        storyId: "story-keep",
        githubAuthMode: "host-gh",
        expectedPrincipal: { kind: "user", login: "keep-a" },
        credentialDeliveryId: null,
      }).ok,
    ).toBe(true);
    expect(
      writeWorkerAuthAssignment({
        projectRoot: main,
        worktreePath: other,
        dispatchId: "dispatch-drop",
        storyId: "story-drop",
        githubAuthMode: "injected-token",
        expectedPrincipal: { kind: "user", login: "drop-a" },
        credentialDeliveryId: "del-drop",
      }).ok,
    ).toBe(true);
    const cleaned = cleanupWorkerAuthAssignmentsForDispatch({
      projectRoot: main,
      dispatchId: "dispatch-drop",
    });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) return;
    expect(cleaned.removed).toBeGreaterThanOrEqual(1);
    const kept = readWorkerAuthAssignment(worktree);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.assignment?.dispatch_id).toBe("dispatch-keep");
    const dropped = readWorkerAuthAssignment(other);
    expect(dropped).toEqual({ ok: true, assignment: null, commonDir: expect.any(String) });
  }, 60_000 /* #5084 suite-load testTimeout */);
});
