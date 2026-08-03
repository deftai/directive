import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { defaultNpmViewVersion } from "./npm-view.js";

describe("defaultNpmViewVersion (#2808)", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("pins payload release lookup to the canonical public registry", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "0.84.0\n",
      stderr: "",
      pid: 1,
      output: [null, "0.84.0\n", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: true, version: "0.84.0" });
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "npm",
      [
        "view",
        "@deftai/directive",
        "version",
        "--registry=https://registry.npmjs.org/",
        "--ignore-scripts",
      ],
      {
        encoding: "utf8",
        shell: false,
        timeout: 15_000,
        windowsHide: true,
      },
    );
  });

  it("returns unavailable when the public registry lookup fails", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "0.84.0\n",
      stderr: "network unavailable",
      pid: 1,
      output: [null, "0.84.0\n", "network unavailable"],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("returns unavailable when spawnSync reports proc.error", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
      error: new Error("ENOENT"),
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("returns unavailable on empty version payload", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "\n",
      stderr: "",
      pid: 1,
      output: [null, "\n", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("uses first line when npm prints multi-line stdout", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "1.2.3\nextra noise\n",
      stderr: "",
      pid: 1,
      output: [null, "1.2.3\nextra noise\n", ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: true, version: "1.2.3" });
  });

  it("treats non-string stdout as empty version", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from("1.0.0") as unknown as string,
      stderr: "",
      pid: 1,
      output: [null, Buffer.from("1.0.0"), ""],
      signal: null,
      error: undefined,
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });

  it("returns unavailable when spawnSync throws", () => {
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("spawn boom");
    });

    expect(defaultNpmViewVersion()).toEqual({ ok: false, version: "" });
  });
});
