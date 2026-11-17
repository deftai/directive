import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startUatLease } from "@deftai/directive-core/authz";
import type { OperatorStopInput } from "@deftai/directive-core/escalation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as authzMain, AUTHZ_AGENT_SHELL_ENV_MARKERS as fromAuthz } from "./authz.js";
import {
  AUTHZ_AGENT_SHELL_ENV_MARKERS,
  AUTHZ_INTERACTIVE_CONFIRM_PHRASE,
  absoluteProjectRootArgs,
  controllingTerminalOpenFlag,
  controllingTerminalPath,
  detectedAgentShellMarkers,
  looksLikeAgentShell,
  mintArgsAfterVerb,
  recordMintOperatorStop,
  refuseMintWhileUatActive,
  refuseNonInteractiveMint,
  resolveHumanPresenceMintSeams,
} from "./human-presence-mint.js";
import { run as runApprovedScope } from "./scope-record-approved-scope.js";
import { run as runIntentConstraint } from "./scope-record-intent-constraint.js";
import { run as runObservableScope } from "./scope-record-observable-scope.js";

describe("agent-marker mint refusal records an operator stop (#6275 limb 2)", () => {
  function silence(): void {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  }
  const human = {
    isTty: () => true,
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => "mint",
  };

  it("records the full command from the caller's argv and project root on the agent-marker branch", () => {
    silence();
    const recorded: OperatorStopInput[] = [];
    const code = refuseNonInteractiveMint({
      verb: "authz:grant",
      confirm: false,
      ...human,
      environ: { CLAUDECODE: "1", DEFT_SESSION_ID: "w1" },
      operatorStop: {
        projectRoot: "/repo/wt",
        args: ["--operations", "edit", "--surfaces", "src/**"],
        record: (i) => recorded.push(i),
      },
    });
    expect(code).toBe(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: "mint",
      sessionId: "w1",
      code: "mint-refused-agent-shell",
    });
    expect(recorded[0]?.commands[0]).toMatch(
      /; deft authz:grant -- --operations edit --surfaces 'src\/\*\*' --confirm$/,
    );
    expect(recorded[0]?.commands[0]).toContain("repo");
  });

  it("a human TTY mint typo records nothing", () => {
    silence();
    const recorded: OperatorStopInput[] = [];
    const record = (i: OperatorStopInput) => recorded.push(i);
    for (const overrides of [
      { readInteractiveConfirm: () => "mnit" },
      { isTty: () => false },
      { hasControllingTerminal: () => false },
    ]) {
      expect(
        refuseNonInteractiveMint({
          verb: "authz:grant",
          confirm: true,
          ...human,
          ...overrides,
          environ: {},
          operatorStop: { projectRoot: "/repo", args: [], record },
        }),
      ).toBe(2);
    }
    expect(
      refuseNonInteractiveMint({
        verb: "authz:grant",
        confirm: false,
        ...human,
        environ: {},
        operatorStop: { projectRoot: "/repo", args: [], record },
      }),
    ).toBe(2);
    expect(recorded).toEqual([]);
  });

  it("a recorder that throws never changes the refusal", () => {
    silence();
    expect(() =>
      recordMintOperatorStop(
        "authz:grant",
        {},
        {
          projectRoot: "/repo",
          args: [],
          record: () => {
            throw new Error("disk full");
          },
        },
      ),
    ).not.toThrow();
  });

  it("the default recorder writes nothing while the notifier is off", () => {
    silence();
    const root = mkdtempSync(join(tmpdir(), "hpm-default-"));
    roots.push(root);
    const prev = process.env.DEFT_USER_PATH;
    process.env.DEFT_USER_PATH = join(root, "no-USER.md");
    try {
      recordMintOperatorStop("authz:grant", { CLAUDECODE: "1" }, { projectRoot: root, args: [] });
    } finally {
      if (prev === undefined) delete process.env.DEFT_USER_PATH;
      else process.env.DEFT_USER_PATH = prev;
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it("replay uses the resolved project root, so a relative root is not applied twice", () => {
    silence();
    const recorded: OperatorStopInput[] = [];
    const abs = resolve("/work/repo");
    recordMintOperatorStop(
      "authz:grant",
      {},
      {
        projectRoot: abs,
        args: ["--project-root", "./repo", "--operations", "edit", "--projectRoot=x"],
        record: (i) => recorded.push(i),
      },
    );
    const command = recorded[0]?.commands[0] ?? "";
    expect(command).not.toContain("./repo");
    expect(
      absoluteProjectRootArgs(["--project-root=./repo", "--projectRoot", "r", "a"], abs),
    ).toEqual([`--project-root=${abs}`, "--projectRoot", abs, "a"]);
  });

  it("mintArgsAfterVerb drops separators and the subcommand", () => {
    expect(mintArgsAfterVerb(["--", "grant", "--", "--operations", "edit"], "grant")).toEqual([
      "--operations",
      "edit",
    ]);
    expect(mintArgsAfterVerb(["--xbrief", "a.json"], null)).toEqual(["--xbrief", "a.json"]);
  });

  it("the four mint callers pass argv and project root", () => {
    silence();
    const root = mkdtempSync(join(tmpdir(), "hpm-6275-"));
    roots.push(root);
    const recorded: OperatorStopInput[] = [];
    const seams = {
      ...human,
      environ: { CLAUDECODE: "1" },
      recordOperatorStop: (i: OperatorStopInput) => recorded.push(i),
    };
    expect(
      authzMain(
        ["grant", "--project-root", root, "--operations", "edit", "--surfaces", "src/a.ts"],
        seams,
      ),
    ).toBe(2);
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "pending", "s.xbrief.json"),
      `${JSON.stringify({ plan: { id: "s", metadata: { swarm: { file_scope: ["src/a.ts"] } } } })}\n`,
    );
    const argv = ["xbrief/pending/s.xbrief.json", "--project-root", root, "--actor", "op"];
    expect(runApprovedScope(argv, seams)).toBe(2);
    expect(runIntentConstraint(argv, seams)).toBe(2);
    expect(runObservableScope(argv, seams)).toBe(2);
    const verbs = recorded.map((r) => r.contextRefs?.[0]);
    expect(verbs).toEqual([
      "authz:grant",
      "scope:record-approved-scope",
      "scope:record-intent-constraint",
      "scope:record-observable-scope",
    ]);
    expect(recorded[0]?.commands[0]).toContain("--operations edit --surfaces src/a.ts");
    expect(recorded[0]?.projectRoot).toBe(resolve(root));
    for (const r of recorded) expect(r.commands[0]).toMatch(/--confirm$/);
  });
});

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
