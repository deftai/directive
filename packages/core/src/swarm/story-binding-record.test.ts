import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireScmReady } from "../scm/readiness.js";
import {
  ensureStoryBindingRecord,
  readStoryBindingRecord,
  removeStoryBindingAttempts,
  STORY_BINDING_LOCK_NAME,
  STORY_BINDING_STORE_DIR,
  storyBindingRecordName,
} from "./story-binding-record.js";
import { readWorkerAuthAssignment, resolveWorkerAuthDestPath } from "./worker-auth-assignment.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

/** A repository with two linked worktrees (#6379 record fixture). */
function repo(): { primary: string; wtA: string; wtB: string; common: string } {
  const primary = mkdtempSync(join(tmpdir(), "story-binding-record-"));
  temps.push(primary);
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "t@t.local"]);
  git(primary, ["config", "user.name", "T"]);
  git(primary, ["commit", "--allow-empty", "-q", "-m", "init"]);
  const wtA = join(primary, ".deft-scratch", "worktrees", "a");
  const wtB = join(primary, ".deft-scratch", "worktrees", "b");
  mkdirSync(join(primary, ".deft-scratch", "worktrees"), { recursive: true });
  git(primary, ["worktree", "add", "--detach", "-q", wtA]);
  git(primary, ["worktree", "add", "--detach", "-q", wtB]);
  return { primary, wtA, wtB, common: join(primary, ".git") };
}

function ensure(common: string, wt: string, storyId: string, ids: readonly string[]) {
  const written = ensureStoryBindingRecord({
    commonDir: common,
    worktreePath: resolveWorkerAuthDestPath(wt),
    storyId,
    attemptIds: ids,
  });
  if (!written.ok) throw new Error(written.detail);
  return written.record;
}

describe("story-binding record store (#6379)", { timeout: 120_000 }, () => {
  it("writes a record under the Git common directory with story id, path and attempt ids, and no auth field", () => {
    const { common, wtA } = repo();
    ensure(common, wtA, "story-a", ["att-1"]);
    const read = readStoryBindingRecord(wtA);
    expect(read.ok).toBe(true);
    if (!read.ok || read.record === null) throw new Error("expected a record");
    expect(read.record).toEqual({
      story_id: "story-a",
      worktree_path: resolveWorkerAuthDestPath(wtA),
      attempt_ids: ["att-1"],
    });
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    const raw = JSON.parse(
      readFileSync(join(common, STORY_BINDING_STORE_DIR, name), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["attempt_ids", "story_id", "worktree_path"]);
  });

  it("keeps other ids for the same story and replaces a record for a different story", () => {
    const { common, wtA } = repo();
    ensure(common, wtA, "story-a", ["att-1"]);
    expect(ensure(common, wtA, "story-a", ["att-2"]).attempt_ids).toEqual(["att-1", "att-2"]);
    expect(ensure(common, wtA, "story-a", ["att-2"]).attempt_ids).toEqual(["att-1", "att-2"]);
    expect(ensure(common, wtA, "story-b", ["att-3"])).toMatchObject({
      story_id: "story-b",
      attempt_ids: ["att-3"],
    });
  });

  it("removes ended ids by attempt id across records and deletes an emptied record", () => {
    const { common, wtA, wtB } = repo();
    ensure(common, wtA, "story-a", ["att-1", "att-2"]);
    ensure(common, wtB, "story-b", ["att-3"]);
    const first = removeStoryBindingAttempts({ commonDir: common, attemptIds: ["att-1", "att-3"] });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.detail);
    expect(first.deleted).toHaveLength(1);
    expect(first.updated).toHaveLength(1);
    const a = readStoryBindingRecord(wtA);
    expect(a.ok && a.record?.attempt_ids).toEqual(["att-2"]);
    const b = readStoryBindingRecord(wtB);
    expect(b.ok && b.record).toBeNull();
    expect(removeStoryBindingAttempts({ commonDir: common, attemptIds: ["att-9"] })).toEqual({
      ok: true,
      updated: [],
      deleted: [],
    });
    expect(removeStoryBindingAttempts({ commonDir: common, attemptIds: [] })).toEqual({
      ok: true,
      updated: [],
      deleted: [],
    });
  });

  it("runs writes and removal under the one store lock", () => {
    const { common, wtA } = repo();
    mkdirSync(join(common, STORY_BINDING_STORE_DIR), { recursive: true });
    const lock = join(common, STORY_BINDING_STORE_DIR, STORY_BINDING_LOCK_NAME);
    const input = () => ({
      commonDir: common,
      worktreePath: resolveWorkerAuthDestPath(wtA),
      storyId: "story-a",
    });
    // A live holder (this process, another token) keeps the lock; writes do not wait.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "other" }), "utf8");
    const blocked = ensureStoryBindingRecord({
      commonDir: common,
      worktreePath: resolveWorkerAuthDestPath(wtA),
      storyId: "story-a",
      attemptIds: ["att-1"],
    });
    expect(blocked).toEqual({ ok: false, detail: "the story-binding record store is locked" });
    // Begin-facing wait: sleep releases the lock so the next acquire succeeds (#7274).
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "other" }), "utf8");
    let released = false;
    const waited = ensureStoryBindingRecord({
      commonDir: common,
      worktreePath: resolveWorkerAuthDestPath(wtA),
      storyId: "story-a",
      attemptIds: ["att-wait"],
      lockWait: {
        maxAttempts: 3,
        sleepMs: 1,
        maxWaitMs: 100,
        sleep: () => {
          if (!released) {
            rmSync(lock, { force: true });
            released = true;
          }
        },
      },
    });
    expect(waited.ok).toBe(true);
    if (waited.ok) expect(waited.record.attempt_ids).toContain("att-wait");
    // Exhausted wait leaves the store locked and does not write.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held" }), "utf8");
    const exhausted = ensureStoryBindingRecord({
      commonDir: common,
      worktreePath: resolveWorkerAuthDestPath(wtA),
      storyId: "story-a",
      attemptIds: ["att-ex"],
      lockWait: { maxAttempts: 2, sleepMs: 1, maxWaitMs: 50, sleep: () => {} },
    });
    expect(exhausted).toEqual({ ok: false, detail: "the story-binding record store is locked" });
    // Keep the live lock so removal stays non-waiting and fails closed.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held-remove" }), "utf8");
    const removeBlocked = removeStoryBindingAttempts({ commonDir: common, attemptIds: ["att-1"] });
    expect(removeBlocked.ok).toBe(false);
    // A dead holder is reclaimed only through the reclaim ticket: a live ticket
    // holder (another reclaimer) keeps it, a dead ticket holder does not.
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, token: "dead" }), "utf8");
    const ticket = `${lock}.reclaim`;
    writeFileSync(ticket, JSON.stringify({ pid: process.pid, token: "reclaimer" }), "utf8");
    const ticketHeld = ensureStoryBindingRecord({
      commonDir: common,
      worktreePath: resolveWorkerAuthDestPath(wtA),
      storyId: "story-a",
      attemptIds: ["att-1"],
    });
    expect(ticketHeld.ok).toBe(false);
    writeFileSync(ticket, JSON.stringify({ pid: 2_147_483_000, token: "gone" }), "utf8");
    expect(ensure(common, wtA, "story-a", ["att-1"]).attempt_ids).toEqual(["att-wait", "att-1"]);
    expect(() => readFileSync(lock, "utf8")).toThrow();
    expect(() => readFileSync(ticket, "utf8")).toThrow();
    // An unreadable lock is kept while fresh and reclaimed once stale.
    writeFileSync(lock, "not json", "utf8");
    expect(ensureStoryBindingRecord({ ...input(), attemptIds: ["att-2"] }).ok).toBe(false);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    expect(ensureStoryBindingRecord({ ...input(), attemptIds: ["att-2"] }).ok).toBe(true);
    // An owner with an impossible pid is not alive.
    writeFileSync(lock, JSON.stringify({ pid: 0, token: "zero" }), "utf8");
    expect(ensureStoryBindingRecord({ ...input(), attemptIds: ["att-3"] }).ok).toBe(true);
    // When every new id is known to have ended, nothing is written.
    expect(
      ensureStoryBindingRecord({
        commonDir: common,
        worktreePath: resolveWorkerAuthDestPath(wtA),
        storyId: "story-a",
        attemptIds: ["att-9"],
        endedAttemptIds: (ids) => ids,
      }),
    ).toEqual({ ok: false, detail: "no attempt of this unit is still running" });
  });

  it("reports a malformed record as a reader failure and no common directory as no record", () => {
    const { common, wtA } = repo();
    const dir = join(common, STORY_BINDING_STORE_DIR);
    mkdirSync(dir, { recursive: true });
    const name = storyBindingRecordName(resolveWorkerAuthDestPath(wtA));
    writeFileSync(join(dir, name), "{ not json", "utf8");
    const read = readStoryBindingRecord(wtA);
    expect(read).toMatchObject({ ok: false, failureKind: "malformed_assignment" });
    // Begin repairs it: a malformed record is replaced.
    expect(ensure(common, wtA, "story-a", ["att-1"]).attempt_ids).toEqual(["att-1"]);
    // A record that names another worktree is malformed for this one.
    writeFileSync(
      join(dir, name),
      JSON.stringify({ story_id: "s", worktree_path: "/elsewhere", attempt_ids: [] }),
      "utf8",
    );
    expect(readStoryBindingRecord(wtA).ok).toBe(false);
    const path = resolveWorkerAuthDestPath(wtA);
    for (const bad of [
      [],
      null,
      { story_id: 7, worktree_path: path, attempt_ids: [] },
      { story_id: " ", worktree_path: path, attempt_ids: [] },
      { story_id: "s", worktree_path: 7, attempt_ids: [] },
      { story_id: "s", worktree_path: path, attempt_ids: "a" },
      { story_id: "s", worktree_path: path, attempt_ids: [""] },
    ]) {
      writeFileSync(join(dir, name), JSON.stringify(bad), "utf8");
      expect(readStoryBindingRecord(wtA).ok, JSON.stringify(bad)).toBe(false);
    }
    // Removal skips records it cannot read and non-record files.
    writeFileSync(join(dir, "notes.txt"), "x", "utf8");
    expect(removeStoryBindingAttempts({ commonDir: common, attemptIds: ["att-1"] })).toEqual({
      ok: true,
      updated: [],
      deleted: [],
    });
    const plain = mkdtempSync(join(tmpdir(), "story-binding-plain-"));
    temps.push(plain);
    expect(readStoryBindingRecord(plain)).toEqual({ ok: true, record: null, commonDir: null });
  });

  it("is not read by readWorkerAuthAssignment or requireScmReady", () => {
    const { common, wtA, wtB } = repo();
    ensure(common, wtA, "story-a", ["att-1"]);
    // Given a worktree with a story-binding record and no worker-auth assignment,
    // requireScmReady gives the same result as for an unregistered worktree.
    expect(readWorkerAuthAssignment(wtA)).toMatchObject({ ok: true, assignment: null });
    const withRecord = requireScmReady({ cwd: wtA, skipReadiness: true, env: {} });
    const unregistered = requireScmReady({ cwd: wtB, skipReadiness: true, env: {} });
    expect(withRecord).toEqual(unregistered);
    // Given an injected token, no assignment check refuses the worker.
    const injected = requireScmReady({
      cwd: wtA,
      skipReadiness: true,
      env: { GH_TOKEN: "test-token-not-real" },
    });
    expect(injected.ready).toBe(true);
    expect(injected).toEqual(
      requireScmReady({ cwd: wtB, skipReadiness: true, env: { GH_TOKEN: "test-token-not-real" } }),
    );
  });
});
