import { describe, expect, it } from "vitest";
import {
  LIVE_PROBE_BROKEN_RECOVERY,
  LIVE_PROBE_TIMEOUT_RECOVERY,
  probeAgentHooksLive,
  quoteWindowsCmdArg,
} from "./agent-hooks-live-probe.js";

describe("probeAgentHooksLive", () => {
  it("reports empty Cursor stdout on allow fixture as non-functional (#2852)", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(result.code).toBe(1);
    expect(result.cases).toEqual([
      expect.objectContaining({ host: "cursor", fixture: "allow", issue: "empty-stdout" }),
    ]);
    expect(result.message).toContain("live probe FAILED");
  });

  it("reports unparseable stdout", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read") ? "not-json" : '{"permission":"deny"}',
        stderr: "",
      }),
    });

    expect(result.code).toBe(1);
    expect(result.cases).toEqual([
      expect.objectContaining({
        fixture: "allow",
        issue: "unparseable-json",
      }),
    ]);
  });

  it.each(["null", "[]", '"allow"'])("rejects non-object JSON stdout %s", (stdout) => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({ status: 0, stdout, stderr: "" }),
    });

    expect(result.code).toBe(1);
    expect(result.cases[0]).toMatchObject({ issue: "unparseable-json" });
  });

  it("rejects a Cursor JSON object that omits the allow permission", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({ status: 0, stdout: "{}", stderr: "" }),
    });

    expect(result.cases[0]).toMatchObject({ fixture: "allow", issue: "missing-allow" });
  });

  it("reports missing deny on a known-deny fixture", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({
        status: 0,
        stdout: '{"permission":"allow"}',
        stderr: "",
      }),
    });

    expect(result.code).toBe(1);
    expect(result.cases).toEqual([
      expect.objectContaining({
        fixture: "deny",
        issue: "missing-deny",
      }),
    ]);
  });

  it("passes when allow and deny fixtures produce parseable decisions", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read")
          ? '{"permission":"allow"}'
          : '{"permission":"deny","user_message":"denied"}',
        stderr: "",
      }),
    });

    expect(result.code).toBe(0);
    expect(result.cases).toEqual([]);
  });

  it("uses read-only Task spawn for the deny fixture", () => {
    let denyEnv: NodeJS.ProcessEnv | undefined;
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin, env }) => {
        if (stdin.includes("Task")) {
          denyEnv = env;
          return {
            status: 0,
            stdout: '{"permission":"deny","user_message":"denied"}',
            stderr: "",
          };
        }
        return { status: 0, stdout: '{"permission":"allow"}', stderr: "" };
      },
    });

    expect(result.code).toBe(0);
    expect(denyEnv?.DEFT_HOOK_READ_ONLY).toBe("1");
  });

  it("returns unavailable when the hook command is missing from PATH", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => null,
    });

    expect(result.code).toBe(2);
    expect(result.cases[0]?.issue).toBe("hook-command-missing");
  });

  it("marks every default host unavailable when command resolution fails", () => {
    const result = probeAgentHooksLive("/project", { resolveCommand: () => null });

    expect(result.code).toBe(2);
    expect(result.hosts.map((entry) => entry.host)).toEqual(["claude", "grok", "cursor", "codex"]);
    expect(result.hosts.every((entry) => entry.status === "unavailable")).toBe(true);
  });

  it("accepts Codex empty allow and canonical deny envelopes", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["codex"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read")
          ? ""
          : JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "read-only",
              },
            }),
        stderr: "",
      }),
    });

    expect(result.code).toBe(0);
    expect(result.hosts).toEqual([{ host: "codex", status: "functional" }]);
  });

  it("rejects noisy non-Cursor allow output even when it is valid JSON", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["codex"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({ status: 0, stdout: "{}", stderr: "" }),
    });

    expect(result.cases[0]).toMatchObject({ fixture: "allow", issue: "missing-allow" });
  });

  it("rejects a Cursor-shaped denial from the Codex codec", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["codex"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read") ? "" : '{"permission":"deny"}',
        stderr: "",
      }),
    });

    expect(result.code).toBe(1);
    expect(result.cases).toEqual([
      expect.objectContaining({ host: "codex", fixture: "deny", issue: "missing-deny" }),
    ]);
  });

  it.each([
    [
      "claude" as const,
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}',
    ],
    ["grok" as const, '{"decision":"deny","reason":"blocked"}'],
  ])("accepts %s empty allow and host-specific deny envelopes", (host, denyOutput) => {
    const result = probeAgentHooksLive("/project", {
      hosts: [host],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read") ? "" : denyOutput,
        stderr: "",
      }),
    });

    expect(result.code).toBe(0);
    expect(result.hosts).toEqual([{ host, status: "functional" }]);
  });

  it.each([
    ["null nested output", '{"hookSpecificOutput":null}'],
    ["array nested output", '{"hookSpecificOutput":[]}'],
    [
      "wrong event name",
      '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}',
    ],
    [
      "wrong decision",
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"blocked"}}',
    ],
    [
      "missing reason",
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
    ],
  ])("rejects Claude %s", (_label, denyOutput) => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["claude"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read") ? "" : denyOutput,
        stderr: "",
      }),
    });

    expect(result.cases[0]).toMatchObject({ fixture: "deny", issue: "missing-deny" });
  });

  it("requires a Grok denial reason", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["grok"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => ({
        status: 0,
        stdout: stdin.includes("Read") ? "" : '{"decision":"deny"}',
        stderr: "",
      }),
    });

    expect(result.cases[0]).toMatchObject({ fixture: "deny", issue: "missing-deny" });
  });

  it("probes only the enabled host list", () => {
    const calls: string[][] = [];
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor", "codex"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ args, stdin }) => {
        calls.push([...args]);
        const host = args[args.indexOf("--host") + 1];
        if (host === "cursor") {
          return {
            status: 0,
            stdout: stdin.includes("Read") ? '{"permission":"allow"}' : '{"permission":"deny"}',
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: stdin.includes("Read")
            ? ""
            : '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}',
          stderr: "",
        };
      },
    });

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls.every((args) => !args.includes("claude") && !args.includes("grok"))).toBe(true);
  });

  it("passes without resolving a command when every host is disabled", () => {
    let resolved = false;
    const result = probeAgentHooksLive("/project", {
      hosts: [],
      resolveCommand: () => {
        resolved = true;
        return null;
      },
    });

    expect(result.code).toBe(0);
    expect(result.hosts).toEqual([]);
    expect(resolved).toBe(false);
  });

  it("does not fall back to the full deft CLI when deft-hook is absent", () => {
    const resolvedNames: string[] = [];
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: (name) => {
        resolvedNames.push(name);
        return name === "deft" ? "/usr/bin/deft" : null;
      },
    });

    expect(result.code).toBe(2);
    expect(resolvedNames).toEqual(["deft-hook"]);
  });

  it("reports a bounded hook timeout after one retry", () => {
    let calls = 0;
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => {
        calls += 1;
        return { status: 2, stdout: "", stderr: "", timedOut: true };
      },
    });

    expect(calls).toBe(2);
    expect(result.code).toBe(1);
    expect(result.cases[0]).toMatchObject({ issue: "timed-out" });
    expect(result.hosts[0]).toMatchObject({ host: "cursor", status: "timed-out" });
    expect(result.message).toContain(LIVE_PROBE_TIMEOUT_RECOVERY);
    expect(result.message).not.toContain(LIVE_PROBE_BROKEN_RECOVERY);
    expect(result.message).not.toMatch(/Recovery: reinstall/);
    expect(result.message).not.toContain("hostHooks.<host>");
  });

  it("retries once after a timeout then passes (#3570)", () => {
    let calls = 0;
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: ({ stdin }) => {
        calls += 1;
        if (calls === 1 || calls === 3) {
          return { status: 2, stdout: "", stderr: "", timedOut: true };
        }
        return {
          status: 0,
          stdout: stdin.includes("Read")
            ? '{"permission":"allow"}'
            : '{"permission":"deny","user_message":"denied"}',
          stderr: "",
        };
      },
    });

    expect(calls).toBe(4);
    expect(result.code).toBe(0);
    expect(result.cases).toEqual([]);
  });

  it("uses broken recovery when timeout is mixed with a spawn failure", () => {
    let calls = 0;
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor", "claude"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => {
        calls += 1;
        if (calls <= 2) return { status: 2, stdout: "", stderr: "", timedOut: true };
        return { status: 3, stdout: "", stderr: "boom" };
      },
    });
    expect(result.cases.some((entry) => entry.issue === "timed-out")).toBe(true);
    expect(result.cases.some((entry) => entry.issue === "spawn-failed")).toBe(true);
    expect(result.message).toContain(LIVE_PROBE_BROKEN_RECOVERY);
  });

  it("keeps reinstall recovery for non-timeout live failures", () => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(result.message).toContain(LIVE_PROBE_BROKEN_RECOVERY);
  });

  it.each([
    ["without stderr", ""],
    ["with stderr", "permission denied"],
  ])("reports a failed hook process %s", (_label, stderr) => {
    const result = probeAgentHooksLive("/project", {
      hosts: ["cursor"],
      resolveCommand: () => "/usr/bin/deft-hook",
      spawnHook: () => ({ status: 3, stdout: "", stderr }),
    });

    expect(result.cases[0]).toMatchObject({ issue: "spawn-failed" });
    if (stderr) expect(result.cases[0]?.detail).toContain(stderr);
  });

  it("escapes percent signs for Windows cmd shell arguments", () => {
    expect(quoteWindowsCmdArg("C:/Repos/deft%directive")).toBe("C:/Repos/deft%%directive");
    expect(quoteWindowsCmdArg("C:/Repos/with spaces")).toBe('"C:/Repos/with spaces"');
    expect(quoteWindowsCmdArg('C:/Repos/"quoted"')).toBe('"C:/Repos/""quoted"""');
  });
});
