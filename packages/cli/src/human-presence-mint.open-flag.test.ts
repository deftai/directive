import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  openSyncMock: vi.fn(() => 7),
  closeSyncMock: vi.fn(),
  readSyncMock: vi.fn((_fd: unknown, buf: unknown, offset: unknown) => {
    const text = Buffer.from("mint\n");
    text.copy(buf as Buffer, Number(offset) || 0);
    return text.length;
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => hoisted.openSyncMock(...args),
    closeSync: (...args: Parameters<typeof actual.closeSync>) => hoisted.closeSyncMock(...args),
    readSync: (...args: Parameters<typeof actual.readSync>) => hoisted.readSyncMock(...args),
  };
});

import { resolveHumanPresenceMintSeams } from "./human-presence-mint.js";

describe("controlling-terminal open flag (#3596)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("default probe and phrase read open the platform device with the platform flag", () => {
    const expectedPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
    const expectedFlag = process.platform === "win32" ? "r+" : "r";
    const seams = resolveHumanPresenceMintSeams();
    expect(seams.hasControllingTerminal()).toBe(true);
    expect(hoisted.openSyncMock).toHaveBeenCalledWith(expectedPath, expectedFlag);
    hoisted.openSyncMock.mockClear();
    expect(seams.readInteractiveConfirm()).toBe("mint");
    expect(hoisted.openSyncMock).toHaveBeenCalledWith(expectedPath, expectedFlag);
  });
});
