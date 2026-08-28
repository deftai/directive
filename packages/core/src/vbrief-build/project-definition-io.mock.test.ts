import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  openSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  actualFs: null as typeof import("node:fs") | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  hoisted.actualFs = actual;
  return {
    ...actual,
    readFileSync: hoisted.readFileSyncMock,
    openSync: hoisted.openSyncMock,
    existsSync: hoisted.existsSyncMock,
  };
});

import {
  loadProjectDefinitionForMutation,
  projectDefinitionMutationLock,
} from "./project-definition-io.js";

/** Real fs module captured after vi.mock — throw if hoisted setup failed. */
function actualFs(): typeof import("node:fs") {
  const fs = hoisted.actualFs;
  if (fs === null) {
    throw new Error("actualFs not initialized by vi.mock");
  }
  return fs;
}

describe("projectDefinitionIO mocked fs branches", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("raises when readFileSync fails for load", () => {
    hoisted.existsSyncMock.mockReturnValue(true);
    hoisted.readFileSyncMock.mockImplementation((path) => {
      if (String(path).includes("PROJECT-DEFINITION.xbrief.json")) {
        throw new Error("read denied");
      }
      return actualFs().readFileSync(path);
    });
    const root = mkdtempSync(join(tmpdir(), "vb-pd-mock-"));
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(
      /Could not read PROJECT-DEFINITION/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("never opens the public lock pathname held by a legacy sidecar (#3796)", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-mock-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n`, "utf8");

    expect(() =>
      projectDefinitionMutationLock(root, () => undefined, {
        sleepMs: () => undefined,
        acquisitionBudgetMs: 0,
      }),
    ).toThrow("timed out acquiring the PROJECT-DEFINITION mutation lock");

    expect(existsSync(lockPath)).toBe(true);
    // Owner metadata is only ever opened inside this acquisition's own prepared
    // directory; the legacy pathname is read for classification, never opened.
    const openedPaths = hoisted.openSyncMock.mock.calls.map((call) => String(call[0]));
    expect(openedPaths.every((opened) => opened !== lockPath)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rethrows non-busy openSync errors", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation(() => {
      const err = new Error("weird") as NodeJS.ErrnoException;
      err.code = "EISDIR";
      throw err;
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-weird-"));
    expect(() => projectDefinitionMutationLock(root, () => undefined)).toThrow("weird");
    rmSync(root, { recursive: true, force: true });
  });

  it("retries publication after a contended rename", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-retry-"));
    let renames = 0;
    expect(
      projectDefinitionMutationLock(root, () => "ok", {
        sleepMs: () => undefined,
        renameLock: (source, destination) => {
          renames += 1;
          if (renames === 1) {
            const err = new Error("locked") as NodeJS.ErrnoException;
            err.code = "EEXIST";
            throw err;
          }
          actualFs().renameSync(source, destination);
        },
      }),
    ).toBe("ok");
    expect(renames).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("propagates EACCES instead of masking it as lock contention", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation(() => {
      const err = new Error("denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-eacces-"));
    expect(() => projectDefinitionMutationLock(root, () => "ok")).toThrow("denied");
    rmSync(root, { recursive: true, force: true });
  });

  it("reaps a dead directory owner and republishes its own generation", () => {
    hoisted.existsSyncMock.mockImplementation((path) => actualFs().existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => actualFs().openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      actualFs().readFileSync(
        path,
        ...(args as [Parameters<typeof import("node:fs").readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-stale-"));
    const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    mkdirSync(lockPath);
    const staleEntry = `999999-${"a".repeat(32)}`;
    writeFileSync(join(lockPath, staleEntry), "{}", "utf8");

    const probed: number[] = [];
    expect(
      projectDefinitionMutationLock(root, () => "ok", {
        sleepMs: () => undefined,
        probeProcess: (pid) => {
          probed.push(pid);
          return "dead";
        },
      }),
    ).toBe("ok");
    expect(probed).toContain(999_999);
    expect(existsSync(lockPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
