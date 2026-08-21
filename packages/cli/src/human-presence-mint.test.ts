import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUatLease } from "@deftai/directive-core/authz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHZ_AGENT_SHELL_ENV_MARKERS as fromAuthz } from "./authz.js";
import {
  AUTHZ_AGENT_SHELL_ENV_MARKERS,
  AUTHZ_INTERACTIVE_CONFIRM_PHRASE,
  controllingTerminalOpenFlag,
  controllingTerminalPath,
  looksLikeAgentShell,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function operatorSeams() {
  return {
    isTty: () => true,
    environ: {},
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => AUTHZ_INTERACTIVE_CONFIRM_PHRASE,
  };
}

describe("shared #3110 human-presence mint (#3384)", () => {
  it("re-exports the same marker list from authz (no copy-paste)", () => {
    expect(fromAuthz).toBe(AUTHZ_AGENT_SHELL_ENV_MARKERS);
    expect(AUTHZ_INTERACTIVE_CONFIRM_PHRASE).toBe("mint");
    expect(AUTHZ_AGENT_SHELL_ENV_MARKERS).toContain("CI");
    expect(AUTHZ_AGENT_SHELL_ENV_MARKERS).toContain("CLAUDECODE");
    expect(AUTHZ_AGENT_SHELL_ENV_MARKERS).toContain("GITHUB_ACTIONS");
    expect(AUTHZ_AGENT_SHELL_ENV_MARKERS).toContain("CURSOR_AGENT");
  });

  it("detects agent and CI markers; empty or whitespace values do not", () => {
    expect(looksLikeAgentShell({})).toBe(false);
    expect(looksLikeAgentShell({ CI: "" })).toBe(false);
    expect(looksLikeAgentShell({ CI: "   " })).toBe(false);
    expect(looksLikeAgentShell({ CI: "true" })).toBe(true);
    expect(looksLikeAgentShell({ CLAUDECODE: "1" })).toBe(true);
    expect(looksLikeAgentShell({ CURSOR_AGENT: "1" })).toBe(true);
    expect(looksLikeAgentShell({ GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("refuse matrix: markers, non-TTY, missing confirm, wrong phrase, no controlling tty", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    const base = operatorSeams();
    expect(
      refuseNonInteractiveMint({
        verb: "scope:record-approved-scope",
        confirm: true,
        ...base,
        environ: { CI: "true" },
      }),
    ).toBe(2);
    expect(
      refuseNonInteractiveMint({
        verb: "scope:record-approved-scope",
        confirm: true,
        ...base,
        isTty: () => false,
      }),
    ).toBe(2);
    expect(
      refuseNonInteractiveMint({
        verb: "scope:record-approved-scope",
        confirm: false,
        ...base,
      }),
    ).toBe(2);
    expect(
      refuseNonInteractiveMint({
        verb: "scope:record-approved-scope",
        confirm: true,
        ...base,
        hasControllingTerminal: () => false,
      }),
    ).toBe(2);
    expect(
      refuseNonInteractiveMint({
        verb: "scope:record-approved-scope",
        confirm: true,
        ...base,
        readInteractiveConfirm: () => "yes",
      }),
    ).toBe(2);
    expect(err.join("")).toMatch(/agent|CI|TTY|--confirm|controlling terminal|phrase|mint/i);
  });

  it("allows mint when all multi-factor seams pass", () => {
    expect(
      refuseNonInteractiveMint({
        verb: "scope:record-approved-scope",
        confirm: true,
        ...operatorSeams(),
      }),
    ).toBeNull();
  });

  it("refuses mint while UAT is active with no TTY/confirm/phrase escape", () => {
    const root = mkdtempSync(join(tmpdir(), "hpm-uat-"));
    roots.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    startUatLease({ projectRoot: root, campaignId: "uat-3384", actor: "op" });
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(refuseMintWhileUatActive("scope:record-approved-scope", root)).toBe(2);
    expect(err.join("")).toMatch(/UAT lease is ACTIVE/i);
    const empty = mkdtempSync(join(tmpdir(), "hpm-nouat-"));
    roots.push(empty);
    expect(refuseMintWhileUatActive("scope:record-approved-scope", empty)).toBeNull();
  });

  it("resolveHumanPresenceMintSeams fills defaults", () => {
    const resolved = resolveHumanPresenceMintSeams();
    expect(typeof resolved.isTty).toBe("function");
    expect(typeof resolved.hasControllingTerminal).toBe("function");
    expect(typeof resolved.readInteractiveConfirm).toBe("function");
    expect(resolved.environ).toBe(process.env);
  });

  it("opens CONIN$ with r+ on win32 and /dev/tty with r elsewhere (#3596)", () => {
    expect(controllingTerminalPath("win32")).toBe("CONIN$");
    expect(controllingTerminalOpenFlag("win32")).toBe("r+");
    expect(controllingTerminalPath("linux")).toBe("/dev/tty");
    expect(controllingTerminalOpenFlag("linux")).toBe("r");
    expect(controllingTerminalPath("darwin")).toBe("/dev/tty");
    expect(controllingTerminalOpenFlag("darwin")).toBe("r");
  });
});
