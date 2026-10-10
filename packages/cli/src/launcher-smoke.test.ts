/**
 * Launcher --help / --version / Node gate smoke (R3 / R16 skeleton).
 */
import { describe, expect, it } from "vitest";
import { runLauncher } from "./launcher.js";
import { checkNodeVersion } from "./node-check.js";
import { classifyPinVersion } from "./pin.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (t: string) => {
        out.push(t);
      },
      writeErr: (t: string) => {
        err.push(t);
      },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("node-check (R16)", () => {
  it("fails closed below Node 20", () => {
    const r = checkNodeVersion("18.19.0");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Node 20/);
    expect(r.exitCode).toBe(1);
  });

  it("warns on Node 20 and continues", () => {
    const r = checkNodeVersion("20.11.0");
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/best-effort/);
  });

  it("is quiet on Node 22+", () => {
    const r = checkNodeVersion("22.14.0");
    expect(r.ok).toBe(true);
    expect(r.warning).toBeNull();
  });
});

describe("pin classify", () => {
  it("accepts exact versions", () => {
    expect(classifyPinVersion("1.2.3")).toEqual({
      kind: "exact",
      raw: "1.2.3",
      version: "1.2.3",
    });
  });

  it("rejects ranges", () => {
    expect(classifyPinVersion("^1.2.3").kind).toBe("range");
  });
});

describe("launcher smoke", () => {
  it("--help exits 0 and lists install commands", () => {
    const c = capture();
    const code = runLauncher(["--help"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toMatch(/install/);
    expect(c.out()).toMatch(/upgrade/);
    expect(c.out()).toMatch(/uninstall/);
    expect(c.out()).toMatch(/doctor/);
  });

  it("--version exits 0 and prints launcher", () => {
    const c = capture();
    const code = runLauncher(["--version"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toMatch(/^launcher /);
  });

  it("retired verb migrate exits 2 and suggests upgrade", () => {
    const c = capture();
    const code = runLauncher(["migrate"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toMatch(/upgrade/i);
  });
});
