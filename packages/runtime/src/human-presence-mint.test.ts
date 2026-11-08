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
  detectedAgentShellMarkers,
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

  it("places GROK_AGENT then GROK_SESSION_ID after OPENAI_CODEX (#5983)", () => {
    const openai = AUTHZ_AGENT_SHELL_ENV_MARKERS.indexOf("OPENAI_CODEX");
    const grokAgent = AUTHZ_AGENT_SHELL_ENV_MARKERS.indexOf("GROK_AGENT");
    const grokSession = AUTHZ_AGENT_SHELL_ENV_MARKERS.indexOf("GROK_SESSION_ID");
    expect(openai).toBeGreaterThanOrEqual(0);
    expect(grokAgent).toBe(openai + 1);
    expect(grokSession).toBe(grokAgent + 1);
    expect(AUTHZ_AGENT_SHELL_ENV_MARKERS).not.toContain("GROK_BUILD");
  });

  it("T6 static membership: each declared identity host has a denylist marker (#5983)", () => {
    // Static cross-list only — do not merge the two lists (Bound Recut-2).
    const declaredHostMarkers = [
      "GROK_AGENT",
      "GROK_SESSION_ID",
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CURSOR_AGENT",
      "CURSOR_TRACE_ID",
      "CURSOR_SESSION_ID",
      "CODEX_SANDBOX",
      "CODEX_CI",
      "OPENAI_CODEX",
    ] as const;
    for (const key of declaredHostMarkers) {
      expect(AUTHZ_AGENT_SHELL_ENV_MARKERS).toContain(key);
    }
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

  it("detectedAgentShellMarkers returns matching keys in list order (#5983)", () => {
    expect(detectedAgentShellMarkers({})).toEqual([]);
    expect(
      detectedAgentShellMarkers({
        GROK_SESSION_ID: "sess-1",
        GROK_AGENT: "1",
        CI: "true",
      }),
    ).toEqual(["GROK_AGENT", "GROK_SESSION_ID", "CI"]);
    expect(looksLikeAgentShell({ GROK_AGENT: "1" })).toBe(true);
    expect(looksLikeAgentShell({ GROK_SESSION_ID: "sess" })).toBe(true);
  });

  it("T5 blank/whitespace marker values yield empty list, not null (#5983)", () => {
    for (const key of ["GROK_AGENT", "GROK_SESSION_ID", "CI", "CLAUDECODE"] as const) {
      expect(detectedAgentShellMarkers({ [key]: "" })).toEqual([]);
      expect(detectedAgentShellMarkers({ [key]: "   " })).toEqual([]);
      expect(looksLikeAgentShell({ [key]: "" })).toBe(false);
      expect(looksLikeAgentShell({ [key]: "\t" })).toBe(false);
    }
  });

  it("T4 GROK_HOME alone does not match; no GROK_* prefix (#5983)", () => {
    expect(detectedAgentShellMarkers({ GROK_HOME: "C:\\Users\\op" })).toEqual([]);
    expect(looksLikeAgentShell({ GROK_HOME: "C:\\Users\\op" })).toBe(false);
    expect(detectedAgentShellMarkers({ GROK_BUILD: "1" })).toEqual([]);
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

  it("T3 refuse names matched keys with unset hint and never prints values (#5983)", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    const secretAgent = "secret-agent-value-xyz";
    const secretSession = "secret-session-value-abc";
    expect(
      refuseNonInteractiveMint({
        verb: "authz:grant",
        confirm: true,
        ...operatorSeams(),
        environ: { GROK_AGENT: secretAgent, GROK_SESSION_ID: secretSession },
      }),
    ).toBe(2);
    const msg = err.join("");
    expect(msg).toContain("GROK_AGENT");
    expect(msg).toContain("GROK_SESSION_ID");
    expect(msg).toMatch(/Unset GROK_AGENT, GROK_SESSION_ID/);
    expect(msg).not.toContain(secretAgent);
    expect(msg).not.toContain(secretSession);
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

  it("opens the win32 device-namespace CONIN$ path with r+ and /dev/tty with r elsewhere (#3596 leftover)", () => {
    expect(controllingTerminalPath("win32")).toBe("\\\\.\\CONIN$");
    expect(controllingTerminalOpenFlag("win32")).toBe("r+");
    expect(controllingTerminalPath("linux")).toBe("/dev/tty");
    expect(controllingTerminalOpenFlag("linux")).toBe("r");
    expect(controllingTerminalPath("darwin")).toBe("/dev/tty");
    expect(controllingTerminalOpenFlag("darwin")).toBe("r");
  });
});
