import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { defaultWhich } from "./binary.js";

afterEach(() => {
  execFileSyncMock.mockReset();
  vi.unstubAllGlobals();
});

describe("defaultWhich branches", () => {
  it("returns first non-empty line from which output", () => {
    execFileSyncMock.mockReturnValue("/usr/bin/gh\n");
    expect(defaultWhich("gh")).toBe("/usr/bin/gh");
    expect(execFileSyncMock).toHaveBeenCalledWith("which", ["gh"], expect.any(Object));
  });

  it("returns null when which output is blank", () => {
    execFileSyncMock.mockReturnValue("\n\n");
    expect(defaultWhich("gh")).toBeNull();
  });

  it("uses where on win32", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    execFileSyncMock.mockReturnValue("C:\\Program Files\\Git\\bin\\gh.exe\r\n");
    expect(defaultWhich("gh")).toBe("C:\\Program Files\\Git\\bin\\gh.exe");
    expect(execFileSyncMock).toHaveBeenCalledWith("where", ["gh"], expect.any(Object));
  });

  it("returns null when locator command fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(defaultWhich("missing-binary")).toBeNull();
  });
});
