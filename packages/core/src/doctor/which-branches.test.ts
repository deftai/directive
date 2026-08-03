import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { defaultWhich } from "./which.js";

describe("defaultWhich branch edges", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("returns first non-empty PATH line and trims it", () => {
    vi.mocked(execFileSync).mockReturnValue("\n  C:\\tools\\node.exe  \nC:\\other\\node.exe\n");
    expect(defaultWhich("node")).toBe("C:\\tools\\node.exe");
  });

  it("returns null when locator output is only blank lines", () => {
    vi.mocked(execFileSync).mockReturnValue("\n\r\n  \n");
    expect(defaultWhich("missing")).toBeNull();
  });

  it("returns null when locator throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(defaultWhich("missing")).toBeNull();
  });

  it("uses which on non-win32 platforms", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    try {
      vi.mocked(execFileSync).mockReturnValue("/usr/bin/node\n");
      expect(defaultWhich("node")).toBe("/usr/bin/node");
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        "which",
        ["node"],
        expect.objectContaining({ encoding: "utf8" }),
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: original });
    }
  });

  it("uses where on win32 platforms", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      vi.mocked(execFileSync).mockReturnValue("C:\\Windows\\node.exe\n");
      expect(defaultWhich("node")).toBe("C:\\Windows\\node.exe");
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        "where",
        ["node"],
        expect.objectContaining({ encoding: "utf8" }),
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: original });
    }
  });
});
