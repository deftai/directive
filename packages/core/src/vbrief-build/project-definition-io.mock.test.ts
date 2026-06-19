import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("projectDefinitionIO mocked fs branches", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("raises when readFileSync fails for load", () => {
    hoisted.existsSyncMock.mockReturnValue(true);
    hoisted.readFileSyncMock.mockImplementation((path) => {
      if (String(path).includes("PROJECT-DEFINITION.vbrief.json")) {
        throw new Error("read denied");
      }
      return hoisted.actualFs!.readFileSync(path);
    });
    const root = mkdtempSync(join(tmpdir(), "vb-pd-mock-"));
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(
      /Could not read PROJECT-DEFINITION/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("times out when openSync stays busy", () => {
    hoisted.existsSyncMock.mockImplementation((path) => hoisted.actualFs!.existsSync(path));
    hoisted.openSyncMock.mockImplementation(() => {
      const err = new Error("busy") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      hoisted.actualFs!.readFileSync(
        path,
        ...(args as [Parameters<typeof hoisted.actualFs.readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-mock-"));
    let tick = 0;
    expect(() =>
      projectDefinitionMutationLock(root, () => undefined, {
        sleepMs: () => undefined,
        now: () => {
          tick += 20_000;
          return tick;
        },
      }),
    ).toThrow("busy");
    rmSync(root, { recursive: true, force: true });
  });

  it("rethrows non-busy openSync errors", () => {
    hoisted.existsSyncMock.mockImplementation((path) => hoisted.actualFs!.existsSync(path));
    hoisted.openSyncMock.mockImplementation(() => {
      const err = new Error("weird") as NodeJS.ErrnoException;
      err.code = "EISDIR";
      throw err;
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      hoisted.actualFs!.readFileSync(
        path,
        ...(args as [Parameters<typeof hoisted.actualFs.readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-weird-"));
    expect(() => projectDefinitionMutationLock(root, () => undefined)).toThrow("weird");
    rmSync(root, { recursive: true, force: true });
  });

  it("acquires lock when file already has content", () => {
    hoisted.existsSyncMock.mockImplementation((path) => hoisted.actualFs!.existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => hoisted.actualFs!.openSync(...args));
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      hoisted.actualFs!.readFileSync(
        path,
        ...(args as [Parameters<typeof hoisted.actualFs.readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-existing-"));
    const lockDir = join(root, "vbrief");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "PROJECT-DEFINITION.vbrief.json.lock"), "\0", "utf8");
    expect(projectDefinitionMutationLock(root, () => "ok")).toBe("ok");
    rmSync(root, { recursive: true, force: true });
  });

  it("retries openSync on EACCES", () => {
    let calls = 0;
    hoisted.existsSyncMock.mockImplementation((path) => hoisted.actualFs!.existsSync(path));
    hoisted.openSyncMock.mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return hoisted.actualFs!.openSync(...args);
    });
    hoisted.readFileSyncMock.mockImplementation((path, ...args) =>
      hoisted.actualFs!.readFileSync(
        path,
        ...(args as [Parameters<typeof hoisted.actualFs.readFileSync>[1]?]),
      ),
    );
    const root = mkdtempSync(join(tmpdir(), "vb-lock-eacces-"));
    expect(projectDefinitionMutationLock(root, () => "ok", { sleepMs: () => undefined })).toBe(
      "ok",
    );
    rmSync(root, { recursive: true, force: true });
  });
});
