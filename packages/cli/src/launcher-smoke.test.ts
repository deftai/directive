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

  it("retired verb migrate exits 2 and suggests upgrade (AC14.55)", () => {
    const c = capture();
    const code = runLauncher(["migrate"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toMatch(/Unknown command/i);
    expect(c.err()).toMatch(/install, upgrade, uninstall, doctor/);
    expect(c.err()).toMatch(/upgrade/i);
  });

  it.each([
    ["sync", /install/i],
    ["bootstrap", /install/i],
    ["install-upgrade", /upgrade|install/i],
    ["install-uninstall", /uninstall|install/i],
  ] as const)(
    "retired verb %s exits 2 with unknown-command + known list (AC13.6)",
    (verb, suggestion) => {
      const c = capture();
      const code = runLauncher([verb], c.io);
      expect(code).toBe(2);
      expect(c.err()).toMatch(/Unknown command/i);
      expect(c.err()).toMatch(/install, upgrade, uninstall, doctor/);
      expect(c.err()).toMatch(suggestion);
      // Must not revive as a working install verb
      expect(c.out() + c.err()).not.toMatch(/delegating to|Set up Deft|Plan:/i);
    },
  );

  it("doctor fix is unknown — doctor stays read-only (AC13.6)", () => {
    const c = capture();
    const code = runLauncher(["doctor", "fix"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toMatch(/Unknown command|doctor fix|read-only/i);
    expect(c.err()).toMatch(/install --repair/i);
    expect(c.err() + c.out()).not.toMatch(/^Plan:/m);
    expect(c.err() + c.out()).not.toMatch(/Install command:/i);
  });

  it.each([
    "install--target-version",
    "upgrade--yes",
    "uninstall--root",
    "doctor--json",
  ] as const)("glued bookend flag %s exits 2 with Did-you-mean (CLI-PARSE)", (token) => {
    const c = capture();
    const code = runLauncher([token, "1.2.3"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toMatch(/Unknown command/i);
    expect(c.err()).toMatch(/Did you mean:/i);
    expect(c.err()).toMatch(/install, upgrade, uninstall, doctor/);
    // Must not enter pin-not-installed passthrough
    expect(c.err() + c.out()).not.toMatch(/is not installed/i);
    expect(c.err() + c.out()).not.toMatch(/^Plan:/m);
  });

  it("aliases init/update/remove resolve without being listed as primary help verbs", () => {
    const help = capture();
    expect(runLauncher(["--help"], help.io)).toBe(0);
    const text = help.out();
    expect(text).toMatch(/Installation management/);
    expect(text).toMatch(/^\s+install /m);
    expect(text).toMatch(/^\s+upgrade /m);
    expect(text).toMatch(/^\s+uninstall /m);
    expect(text).toMatch(/^\s+doctor /m);
    // Aliases may be mentioned as aliases, not as primary command rows
    expect(text).toMatch(/Aliases:.*init→install.*update→upgrade.*remove→uninstall/s);
    expect(text).not.toMatch(/^\s+migrate /m);
    expect(text).not.toMatch(/^\s+bootstrap /m);
    expect(text).not.toMatch(/^\s+sync /m);
    expect(text).not.toMatch(/install-upgrade|install-uninstall/);
  });

  it("--help covers first install, repair, upgrade, uninstall, automation (AC13.7)", () => {
    const c = capture();
    const code = runLauncher(["--help"], c.io);
    expect(code).toBe(0);
    const text = c.out();
    expect(text).toMatch(/First-time|first install|directive install/i);
    expect(text).toMatch(/--repair|Repair/i);
    expect(text).toMatch(/upgrade/i);
    expect(text).toMatch(/uninstall/i);
    expect(text).toMatch(/--yes|-y/i);
    expect(text).toMatch(/--dry-run/i);
    expect(text).toMatch(/Automation|automation|--yes/i);
  });

  it("install --help stays on the launcher help surface", () => {
    const c = capture();
    const code = runLauncher(["install", "--help"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toMatch(/Installation management/);
  });
});
