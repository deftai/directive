import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as containedWriteMod from "../fs/contained-write.js";
import { startControllerRun } from "./controller.js";
import { digestApprovedCriteria } from "./criteria.js";
import {
  clearDefaultPrePrStore,
  FileBackedPrePrStore,
  getDefaultPrePrStore,
  InProcessPrePrStore,
  isPublisher,
  loadPrePrRecord,
  mintPublisher,
  opaqueRunId,
  PRE_PR_PRIVATE_STORE_DIR,
  PRE_PR_STORE_MAC_SECRET_NAME,
  PRE_PR_STORE_SECRET_MODE,
  parseStoredRecord,
  prePrDir,
  prePrStoreRecordFileName,
  privatePrePrStoreDir,
  requirePublisher,
  resetDefaultPrePrStore,
  resolveRecordFromStore,
  setDefaultPrePrStore,
  writePrePrRecordDisk,
} from "./store.js";
import { DISK_STORE_NOT_SOT, type PrePrExecutionRecord } from "./types.js";

describe("pre-pr private store", () => {
  it("treats run ids as lookup hints and disk as non-SoT", () => {
    const store = new InProcessPrePrStore();
    expect(resolveRecordFromStore(store, { id: "missing" })).toBeNull();
    expect(loadPrePrRecord(".", "missing", store)).toBeNull();
    expect(prePrDir(".").message).toBe(DISK_STORE_NOT_SOT);
    expect(writePrePrRecordDisk(".", {} as PrePrExecutionRecord).code).toBe("deny-disk-not-sot");
    expect(opaqueRunId("  ppr_hint  ")).toBe("ppr_hint");
    expect(opaqueRunId().startsWith("ppr_")).toBe(true);
    expect(isPublisher({})).toBe(false);
    expect(requirePublisher({}).ok).toBe(false);
    expect(isPublisher(mintPublisher())).toBe(true);
    const def = resetDefaultPrePrStore();
    expect(getDefaultPrePrStore()).toBe(def);
    const other = new InProcessPrePrStore();
    setDefaultPrePrStore(other);
    expect(getDefaultPrePrStore()).toBe(other);
    resetDefaultPrePrStore();
  });

  it("#6902: the default store follows the absolute root; injection wins until cleared", () => {
    const a = mkdtempSync(join(tmpdir(), "pre-pr-root-a-"));
    const b = mkdtempSync(join(tmpdir(), "pre-pr-root-b-"));
    const prevCwd = process.cwd();
    try {
      clearDefaultPrePrStore();
      const storeA = getDefaultPrePrStore(a);
      expect(storeA).toBeInstanceOf(FileBackedPrePrStore);
      expect((storeA as FileBackedPrePrStore).projectRoot).toBe(resolve(a));
      expect(getDefaultPrePrStore(a)).toBe(storeA);
      const storeB = getDefaultPrePrStore(b);
      expect((storeB as FileBackedPrePrStore).projectRoot).toBe(resolve(b));
      const storeA2 = getDefaultPrePrStore(a);
      expect((storeA2 as FileBackedPrePrStore).projectRoot).toBe(resolve(a));
      // A relative root resolves against the cwd at call time.
      process.chdir(b);
      expect((getDefaultPrePrStore(".") as FileBackedPrePrStore).projectRoot).toBe(resolve(b));
      process.chdir(a);
      expect((getDefaultPrePrStore(".") as FileBackedPrePrStore).projectRoot).toBe(resolve(a));
      // An injected store wins for any root until cleared.
      const injected = new InProcessPrePrStore();
      setDefaultPrePrStore(injected);
      expect(getDefaultPrePrStore(a)).toBe(injected);
      expect(getDefaultPrePrStore(b)).toBe(injected);
      const reset = resetDefaultPrePrStore();
      expect(getDefaultPrePrStore(b)).toBe(reset);
      clearDefaultPrePrStore();
      const fresh = getDefaultPrePrStore(b);
      expect(fresh).toBeInstanceOf(FileBackedPrePrStore);
      expect((fresh as FileBackedPrePrStore).projectRoot).toBe(resolve(b));
    } finally {
      process.chdir(prevCwd);
      clearDefaultPrePrStore();
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("indexes by PR node id after put", () => {
    const store = new InProcessPrePrStore();
    const record = {
      id: "ppr_node",
      prNodeId: "PR_kwDOX",
    } as PrePrExecutionRecord;
    store.put(record);
    expect(store.getByPrNodeId("PR_kwDOX")?.id).toBe("ppr_node");
    expect(store.getByPrNodeId("missing")).toBeNull();
    expect(resolveRecordFromStore(store, { prNodeId: "PR_kwDOX" })?.id).toBe("ppr_node");
    expect(resolveRecordFromStore(store, { id: "ppr_node" })?.id).toBe("ppr_node");
    expect(resolveRecordFromStore(store, {})).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("round-trips a record across a new file-backed store instance", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-store-"));
    try {
      const first = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      startControllerRun(first, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_1",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId: "ppr_disk",
      });
      const second = new FileBackedPrePrStore(root);
      expect(second.getById("ppr_disk")?.id).toBe("ppr_disk");
      expect(second.getByPrNodeId("PR_1")?.id).toBe("ppr_disk");
      expect(second.list()).toHaveLength(1);
      expect(privatePrePrStoreDir(root)).toContain(PRE_PR_PRIVATE_STORE_DIR);
      expect(privatePrePrStoreDir(root).includes("pre-pr-controller")).toBe(false);
      const secretPath = join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME);
      expect(statSync(secretPath).isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(secretPath).mode & 0o777).toBe(PRE_PR_STORE_SECRET_MODE);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets a second FileBackedPrePrStore put after the first created the HMAC secret", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-race-"));
    try {
      const first = new FileBackedPrePrStore(root);
      const second = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      const start = (store: FileBackedPrePrStore, runId: string) =>
        startControllerRun(store, {
          repo: "deftai/directive",
          baseSha: "a",
          headSha: "b",
          treeHash: "c",
          prBodyHash: "d",
          prNodeId: "PR_race",
          criteria,
          skillVersion: "0.1",
          policyVersion: "1",
          approvedRevisionSha: "a",
          runId,
        });
      expect(start(first, "ppr_race_a").ok).toBe(true);
      expect(first.getById("ppr_race_a")?.id).toBe("ppr_race_a");
      let secondStart: ReturnType<typeof startControllerRun> | undefined;
      expect(() => {
        secondStart = start(second, "ppr_race_b");
      }).not.toThrow();
      expect(secondStart?.ok).toBe(true);
      expect(second.getById("ppr_race_b")?.id).toBe("ppr_race_b");
      expect(second.getById("ppr_race_a")?.id).toBe("ppr_race_a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the winner secret when HMAC secret create races with EXISTS", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-exists-"));
    const removeSpy = vi.spyOn(containedWriteMod, "containedRemove");
    try {
      const first = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      startControllerRun(first, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_exists",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId: "ppr_win",
      });
      const winner = first.getById("ppr_win") as PrePrExecutionRecord;
      const secretPath = join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME);
      if (process.platform !== "win32") {
        expect(statSync(secretPath).mode & 0o777).toBe(PRE_PR_STORE_SECRET_MODE);
      }
      const second = new FileBackedPrePrStore(root);
      type SecretLoader = { loadSecret(): Buffer | null };
      const proto = FileBackedPrePrStore.prototype as unknown as SecretLoader;
      const original = proto.loadSecret;
      let missOnce = true;
      proto.loadSecret = function loadSecretMissOnce(this: FileBackedPrePrStore): Buffer | null {
        if (missOnce) {
          missOnce = false;
          return null;
        }
        return original.call(this);
      };
      try {
        let put: ReturnType<FileBackedPrePrStore["put"]> | undefined;
        expect(() => {
          put = second.put({
            ...winner,
            id: "ppr_loser",
          });
        }).not.toThrow();
        expect(put?.ok).toBe(true);
        expect(second.getById("ppr_loser")?.id).toBe("ppr_loser");
        expect(removeSpy).not.toHaveBeenCalled();
        expect(existsSync(secretPath)).toBe(true);
      } finally {
        proto.loadSecret = original;
      }
    } finally {
      removeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes OUR unusable 0644 HMAC secret after chmod-fail so the next put can create", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-chmod-"));
    const secretPath = join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME);
    const removeSpy = vi.spyOn(containedWriteMod, "containedRemove");
    const chmodSpy = vi.spyOn(containedWriteMod, "containedChmod").mockImplementation(() => {
      chmodSync(secretPath, 0o644);
      throw new containedWriteMod.ContainedWriteError("contained write I/O failed: chmod denied", {
        code: containedWriteMod.ContainedWriteErrorCode.IO,
        root,
        target: secretPath,
      });
    });
    try {
      const store = new FileBackedPrePrStore(root);
      const decision = store.put({
        id: "ppr_chmod_fail",
        prNodeId: "PR_chmod",
      } as PrePrExecutionRecord);
      if (process.platform === "win32") {
        expect(existsSync(secretPath)).toBe(true);
        return;
      }
      expect(decision.ok).toBe(false);
      expect(decision.code).toBe("deny-missing-record");
      expect(removeSpy).toHaveBeenCalled();
      expect(existsSync(secretPath)).toBe(false);
      expect(store.getById("ppr_chmod_fail")).toBeNull();
      chmodSpy.mockRestore();
      const next = store.put({
        schema: "deft.pre-pr-execution.v1",
        id: "ppr_chmod_retry",
        prNodeId: "PR_chmod2",
      } as PrePrExecutionRecord);
      expect(next.ok).toBe(true);
      expect(existsSync(secretPath)).toBe(true);
      expect(statSync(secretPath).mode & 0o777).toBe(PRE_PR_STORE_SECRET_MODE);
      expect(store.getById("ppr_chmod_retry")?.id).toBe("ppr_chmod_retry");
    } finally {
      chmodSpy.mockRestore();
      removeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the HMAC secret when chmod fails but the file is already 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-chmod-0600-"));
    const secretPath = join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME);
    const removeSpy = vi.spyOn(containedWriteMod, "containedRemove");
    const chmodSpy = vi.spyOn(containedWriteMod, "containedChmod").mockImplementation(() => {
      chmodSync(secretPath, PRE_PR_STORE_SECRET_MODE);
      throw new containedWriteMod.ContainedWriteError("contained write I/O failed: chmod denied", {
        code: containedWriteMod.ContainedWriteErrorCode.IO,
        root,
        target: secretPath,
      });
    });
    try {
      const store = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      const decision = startControllerRun(store, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_chmod_0600",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId: "ppr_chmod_0600",
      });
      expect(existsSync(secretPath)).toBe(true);
      expect(removeSpy).not.toHaveBeenCalled();
      expect(decision.ok).toBe(true);
      expect(store.getById("ppr_chmod_0600")?.id).toBe("ppr_chmod_0600");
    } finally {
      chmodSpy.mockRestore();
      removeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not load or delete a 0644 HMAC secret on EXISTS race", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-0644-"));
    const dir = privatePrePrStoreDir(root);
    const secretPath = join(dir, PRE_PR_STORE_MAC_SECRET_NAME);
    const removeSpy = vi.spyOn(containedWriteMod, "containedRemove");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(secretPath, `${"ab".repeat(32)}\n`);
      chmodSync(secretPath, 0o644);
      if (process.platform === "win32") {
        expect(existsSync(secretPath)).toBe(true);
        return;
      }
      expect(statSync(secretPath).mode & 0o777).toBe(0o644);
      const store = new FileBackedPrePrStore(root);
      const decision = store.put({
        id: "ppr_world",
        prNodeId: "PR_world",
      } as PrePrExecutionRecord);
      expect(decision.ok).toBe(false);
      expect(decision.code).toBe("deny-missing-record");
      expect(existsSync(secretPath)).toBe(true);
      expect(statSync(secretPath).mode & 0o777).toBe(0o644);
      expect(removeSpy).not.toHaveBeenCalled();
      expect(store.getById("ppr_world")).toBeNull();
      expect(store.list()).toHaveLength(0);
    } finally {
      removeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies put without throwing when HMAC secret create fails without EXISTS", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-io-"));
    const writeSpy = vi.spyOn(containedWriteMod, "containedWrite").mockImplementation(() => {
      throw new containedWriteMod.ContainedWriteError("contained write I/O failed", {
        code: containedWriteMod.ContainedWriteErrorCode.IO,
        root,
        target: join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME),
      });
    });
    try {
      const store = new FileBackedPrePrStore(root);
      let decision: ReturnType<FileBackedPrePrStore["put"]> | undefined;
      expect(() => {
        decision = store.put({
          id: "ppr_io",
          prNodeId: "PR_io",
        } as PrePrExecutionRecord);
      }).not.toThrow();
      expect(decision?.ok).toBe(false);
      expect(decision?.code).toBe("deny-missing-record");
    } finally {
      writeSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies put when HMAC secret create races but the winner cannot be loaded", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-hmac-empty-"));
    try {
      mkdirSync(privatePrePrStoreDir(root), { recursive: true });
      const emptySecret = join(privatePrePrStoreDir(root), PRE_PR_STORE_MAC_SECRET_NAME);
      writeFileSync(emptySecret, "\n");
      chmodSync(emptySecret, PRE_PR_STORE_SECRET_MODE);
      const store = new FileBackedPrePrStore(root);
      const decision = store.put({
        id: "ppr_empty_secret",
        prNodeId: "PR_empty",
      } as PrePrExecutionRecord);
      expect(decision.ok).toBe(false);
      expect(decision.code).toBe("deny-missing-record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsigned JSON and loads only MAC-wrapped records", () => {
    const root = mkdtempSync(join(tmpdir(), "pre-pr-mac-"));
    try {
      const store = new FileBackedPrePrStore(root);
      const criteria = digestApprovedCriteria({
        sourceRevisionSha: "a",
        scopePaths: ["x.ts"],
        acceptanceText: "ac",
        generation: 1,
      });
      startControllerRun(store, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_mac",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId: "ppr_signed",
      });
      expect(store.getById("ppr_signed")?.id).toBe("ppr_signed");
      const forgedId = "ppr_unsigned";
      const unsigned: PrePrExecutionRecord = {
        ...(store.getById("ppr_signed") as PrePrExecutionRecord),
        id: forgedId,
        outcome: "pass",
        state: "complete",
      };
      const dir = privatePrePrStoreDir(root);
      writeFileSync(join(dir, prePrStoreRecordFileName(forgedId)), `${JSON.stringify(unsigned)}\n`);
      expect(store.getById(forgedId)).toBeNull();
      const secret = Buffer.from(
        readFileSync(join(dir, PRE_PR_STORE_MAC_SECRET_NAME), "utf8").trim(),
        "hex",
      );
      expect(parseStoredRecord(JSON.stringify(unsigned), secret)).toBeNull();
      const envelopeRaw = readFileSync(join(dir, prePrStoreRecordFileName("ppr_signed")), "utf8");
      expect(parseStoredRecord(envelopeRaw, secret)?.id).toBe("ppr_signed");
      expect(parseStoredRecord(envelopeRaw, Buffer.from("00".repeat(32), "hex"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the newest PR-node record and lets a presented run id win", () => {
    const store = new InProcessPrePrStore();
    const criteria = digestApprovedCriteria({
      sourceRevisionSha: "a",
      scopePaths: ["x.ts"],
      acceptanceText: "ac",
      generation: 1,
    });
    const start = (runId: string, now: Date) =>
      startControllerRun(store, {
        repo: "deftai/directive",
        baseSha: "a",
        headSha: "b",
        treeHash: "c",
        prBodyHash: "d",
        prNodeId: "PR_dup",
        criteria,
        skillVersion: "0.1",
        policyVersion: "1",
        approvedRevisionSha: "a",
        runId,
        now,
      });
    start("ppr_newer", new Date("2026-10-02T12:00:00Z"));
    start("ppr_older", new Date("2026-10-02T11:00:00Z"));
    expect(store.getByPrNodeId("PR_dup")?.id).toBe("ppr_newer");
    expect(resolveRecordFromStore(store, { id: "ppr_older", prNodeId: "PR_dup" })?.id).toBe(
      "ppr_older",
    );
    expect(resolveRecordFromStore(store, { prNodeId: "PR_dup" })?.id).toBe("ppr_newer");

    const root = mkdtempSync(join(tmpdir(), "pre-pr-newest-"));
    try {
      const disk = new FileBackedPrePrStore(root);
      const startDisk = (runId: string, now: Date) =>
        startControllerRun(disk, {
          repo: "deftai/directive",
          baseSha: "a",
          headSha: "b",
          treeHash: "c",
          prBodyHash: "d",
          prNodeId: "PR_dup",
          criteria,
          skillVersion: "0.1",
          policyVersion: "1",
          approvedRevisionSha: "a",
          runId,
          now,
        });
      startDisk("ppr_newer", new Date("2026-10-02T12:00:00Z"));
      startDisk("ppr_older", new Date("2026-10-02T11:00:00Z"));
      expect(disk.getByPrNodeId("PR_dup")?.id).toBe("ppr_newer");
      expect(resolveRecordFromStore(disk, { id: "ppr_older", prNodeId: "PR_dup" })?.id).toBe(
        "ppr_older",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
