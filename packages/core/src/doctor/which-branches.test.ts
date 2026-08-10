import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { defaultWhich, defaultWhichAll, whichAllFromPath } from "./which.js";

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

describe("whichAllFromPath / defaultWhichAll (#3233)", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("enumerates PATH matches in precedence order on posix", () => {
    const exists = (p: string) => p === "/opt/homebrew/bin/deft" || p === "/Users/x/.nvm/bin/deft";
    const paths = whichAllFromPath("deft", {
      platform: "linux",
      env: { PATH: "/opt/homebrew/bin:/Users/x/.nvm/bin:/usr/bin" },
      exists,
    });
    expect(paths).toEqual(["/opt/homebrew/bin/deft", "/Users/x/.nvm/bin/deft"]);
  });

  it("uses PATHEXT on win32 and one hit per directory", () => {
    // PATHEXT entries are upper-case; mock must match the joined form.
    const exists = (p: string) =>
      p === "C:\\Homebrew\\bin\\deft.CMD" || p === "C:\\nvm\\bin\\deft.CMD";
    const paths = whichAllFromPath("deft", {
      platform: "win32",
      env: {
        PATH: "C:\\Homebrew\\bin;C:\\nvm\\bin",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      exists,
    });
    expect(paths).toEqual(["C:\\Homebrew\\bin\\deft.CMD", "C:\\nvm\\bin\\deft.CMD"]);
  });

  it("returns empty when PATH is empty", () => {
    expect(whichAllFromPath("deft", { env: {}, platform: "linux", exists: () => true })).toEqual(
      [],
    );
  });

  it("defaultWhichAll returns all where lines on win32", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      vi.mocked(execFileSync).mockReturnValue(
        "C:\\Homebrew\\bin\\deft.cmd\nC:\\nvm\\bin\\deft.cmd\n",
      );
      expect(defaultWhichAll("deft", { platform: "win32" })).toEqual([
        "C:\\Homebrew\\bin\\deft.cmd",
        "C:\\nvm\\bin\\deft.cmd",
      ]);
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        "where",
        ["deft"],
        expect.objectContaining({ encoding: "utf8" }),
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: original });
    }
  });

  it("defaultWhichAll uses which -a on posix", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    try {
      vi.mocked(execFileSync).mockReturnValue("/opt/homebrew/bin/deft\n/Users/x/.nvm/bin/deft\n");
      expect(defaultWhichAll("deft", { platform: "linux" })).toEqual([
        "/opt/homebrew/bin/deft",
        "/Users/x/.nvm/bin/deft",
      ]);
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        "which",
        ["-a", "deft"],
        expect.objectContaining({ encoding: "utf8" }),
      );
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: original });
    }
  });

  it("defaultWhichAll falls back to PATH scan when locator throws", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("which missing");
    });
    const paths = defaultWhichAll("deft", {
      platform: "linux",
      env: { PATH: "/only/bin" },
      exists: (p) => p === "/only/bin/deft",
    });
    expect(paths).toEqual(["/only/bin/deft"]);
  });
});
