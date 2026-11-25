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
  admitHarnessAttendedMint,
  controllingTerminalOpenFlag,
  controllingTerminalPath,
  detectedAgentShellMarkers,
  digestHarnessAttendedAuthorityPayload,
  loadHarnessAttendedMintRequest,
  looksLikeAgentShell,
  mintArgsAfterVerb,
  openHarnessAttendedMintRequest,
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

  it("the kept mint callers pass argv and project root; the declared writers record no stop (#7031)", () => {
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
    // The brief has no contract, so the declared writers fail on input, not on a mint.
    expect(runIntentConstraint(argv, seams)).toBe(2);
    expect(runObservableScope(argv, seams)).toBe(2);
    const verbs = recorded.map((r) => r.contextRefs?.[0]);
    expect(verbs).toEqual(["authz:grant", "scope:record-approved-scope"]);
    expect(recorded[0]?.commands[0]).toContain("--operations edit --surfaces src/a.ts");
    expect(recorded[0]?.projectRoot).toBe(resolve(root));
    // Harness-attended request-open recovery ends with --confirm [--request-id=…] (#7279).
    for (const r of recorded) {
      expect(r.commands[0]).toMatch(/--confirm(?: --request-id=[0-9a-f]+)?$/);
      expect(r.commands[0]).toContain("--confirm");
    }
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

  it("T3 refuse names matched keys and never prints values (#5983 / #7279)", () => {
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
    // Kept-mint verbs must not recommend forge-by-unset (#7279).
    expect(msg).toMatch(/Do not unset markers|harness-attended/i);
    expect(msg).not.toMatch(/Unset GROK_AGENT/);
    expect(msg).not.toContain(secretAgent);
    expect(msg).not.toContain(secretSession);
  });

  it("non-inventoried verbs still recommend unset on marker refuse (#7279 keep-out)", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      refuseNonInteractiveMint({
        verb: "kill-switch:on",
        confirm: true,
        ...operatorSeams(),
        environ: { GROK_AGENT: "1" },
      }),
    ).toBe(2);
    expect(err.join("")).toMatch(/Unset GROK_AGENT/);
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

describe("harness-attended human-presence mint (#7279)", () => {
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

  function silence(): void {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  }

  it("request-open freezes verb+payload+checkout+destinations and never stamps", () => {
    silence();
    const root = mkdtempSync(join(tmpdir(), "hpm-ham-open-"));
    roots.push(root);
    const destinations = [join(root, ".deft", "approved-scope", "p.json")];
    const args = ["story.xbrief.json", "--actor", "Scott"];
    const opened = openHarnessAttendedMintRequest({
      verb: "scope:record-approved-scope",
      projectRoot: root,
      destinations,
      args,
      newRequestId: () => "req-open-1",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.request.status).toBe("open");
    expect(opened.request.authorityPayloadDigest).toBe(
      digestHarnessAttendedAuthorityPayload({
        verb: "scope:record-approved-scope",
        projectRoot: root,
        destinations,
        args,
      }),
    );
    const loaded = loadHarnessAttendedMintRequest(root, "req-open-1");
    expect(loaded?.requestId).toBe("req-open-1");

    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      err.push(String(c));
      return true;
    });
    expect(
      refuseNonInteractiveMint({
        verb: "scope:record-approved-scope",
        confirm: false,
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        environ: { GROK_AGENT: "1" },
        operatorStop: { projectRoot: root, args },
        harnessAttended: { destinations, newRequestId: () => "req-open-2" },
      }),
    ).toBe(2);
    expect(err.join("")).toMatch(/request-open only|bare chat-yes never stamps/i);
    expect(loadHarnessAttendedMintRequest(root, "req-open-2")?.status).toBe("open");
  });

  it("controlling-TTY phrase completes under markers without unset", () => {
    silence();
    const root = mkdtempSync(join(tmpdir(), "hpm-ham-tty-"));
    roots.push(root);
    const destinations = [join(root, ".deft", "authz")];
    const args = ["--operations", "edit", "--confirm"];
    expect(
      refuseNonInteractiveMint({
        verb: "authz:grant",
        confirm: true,
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        environ: { GROK_AGENT: "1", GROK_SESSION_ID: "s1" },
        operatorStop: { projectRoot: root, args },
        harnessAttended: { destinations, newRequestId: () => "req-tty-1" },
      }),
    ).toBeNull();
    expect(loadHarnessAttendedMintRequest(root, "req-tty-1")?.status).toBe("completed");
    expect(loadHarnessAttendedMintRequest(root, "req-tty-1")?.completedVia).toBe(
      "controlling-tty-phrase",
    );
  });

  it("host-authenticated user-event completes under markers", () => {
    silence();
    const root = mkdtempSync(join(tmpdir(), "hpm-ham-host-"));
    roots.push(root);
    const destinations = [join(root, ".deft", "authz")];
    const args = ["--template", "finish-loop", "--confirm"];
    const digest = digestHarnessAttendedAuthorityPayload({
      verb: "authz:grant",
      projectRoot: root,
      destinations,
      args,
    });
    const clock = new Date("2026-11-24T12:00:00Z");
    expect(
      refuseNonInteractiveMint({
        verb: "authz:grant",
        confirm: true,
        isTty: () => false,
        hasControllingTerminal: () => false,
        readInteractiveConfirm: () => null,
        readHostAuthenticatedConfirm: (requestId) => ({
          requestId,
          authorityPayloadDigest: digest,
          hostSessionId: "host:test:1",
          authenticatedAt: "2026-11-24T12:00:00Z",
          provenance: "host-user-event",
        }),
        environ: { CURSOR_AGENT: "1" },
        operatorStop: { projectRoot: root, args },
        harnessAttended: {
          destinations,
          newRequestId: () => "req-host-1",
          now: () => clock,
          ttlMs: 60_000,
        },
      }),
    ).toBeNull();
    expect(loadHarnessAttendedMintRequest(root, "req-host-1")?.completedVia).toBe(
      "host-user-event",
    );
  });

  it("refuses changed, expired, and already-completed requests", () => {
    silence();
    const root = mkdtempSync(join(tmpdir(), "hpm-ham-refuse-"));
    roots.push(root);
    const destinations = [join(root, "a.json")];
    const args = ["--actor", "Scott"];
    const opened = openHarnessAttendedMintRequest({
      verb: "scope:record-approved-scope",
      projectRoot: root,
      destinations,
      args,
      newRequestId: () => "req-chg-1",
      now: () => new Date("2026-11-24T10:00:00Z"),
      ttlMs: 1_000,
    });
    expect(opened.ok).toBe(true);

    expect(
      admitHarnessAttendedMint({
        verb: "scope:record-approved-scope",
        confirm: true,
        projectRoot: root,
        args,
        destinations: [join(root, "other.json")],
        requestId: "req-chg-1",
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        readHostAuthenticatedConfirm: () => null,
        environ: { GROK_AGENT: "1" },
      }),
    ).toBe(2);

    expect(
      admitHarnessAttendedMint({
        verb: "scope:record-approved-scope",
        confirm: true,
        projectRoot: root,
        args,
        destinations,
        requestId: "req-chg-1",
        now: () => new Date("2026-11-24T11:00:00Z"),
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        readHostAuthenticatedConfirm: () => null,
        environ: { GROK_AGENT: "1" },
      }),
    ).toBe(2);

    const fresh = openHarnessAttendedMintRequest({
      verb: "authz:revoke",
      projectRoot: root,
      destinations,
      args: ["grant-1"],
      newRequestId: () => "req-done-1",
    });
    expect(fresh.ok).toBe(true);
    expect(
      admitHarnessAttendedMint({
        verb: "authz:revoke",
        confirm: true,
        projectRoot: root,
        args: ["grant-1"],
        destinations,
        requestId: "req-done-1",
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        readHostAuthenticatedConfirm: () => null,
        environ: { GROK_AGENT: "1" },
      }),
    ).toBeNull();
    expect(
      admitHarnessAttendedMint({
        verb: "authz:revoke",
        confirm: true,
        projectRoot: root,
        args: ["grant-1"],
        destinations,
        requestId: "req-done-1",
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        readHostAuthenticatedConfirm: () => null,
        environ: { GROK_AGENT: "1" },
      }),
    ).toBe(2);
  });

  it("ordinary human CLI mint still works without harness options", () => {
    silence();
    expect(
      refuseNonInteractiveMint({
        verb: "authz:grant",
        confirm: true,
        isTty: () => true,
        hasControllingTerminal: () => true,
        readInteractiveConfirm: () => "mint",
        environ: {},
      }),
    ).toBeNull();
  });
});
