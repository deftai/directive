import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentHookInspection } from "../init-deposit/agent-hooks.js";
import { DEFAULT_HOST_HOOKS_POLICY } from "../policy/host-hooks.js";
import {
  agentHookReadinessJson,
  evaluateAgentHookReadiness,
  evaluateAgentHookReadinessSafely,
} from "./agent-hook-readiness.js";
import type { AgentHookHealthResult } from "./agent-hooks.js";
import type { AgentHookLiveProbeResult } from "./agent-hooks-live-probe.js";

function registrations(status: AgentHookInspection["status"] = "healthy"): AgentHookInspection[] {
  return (["claude", "grok", "cursor", "codex"] as const).map((host, index) => ({
    host,
    path: [
      ".claude/settings.json",
      ".grok/hooks/deft.json",
      ".cursor/hooks.json",
      ".codex/hooks.json",
    ][index] as AgentHookInspection["path"],
    status,
    detail: status,
    compactSupport: host === "codex" ? "unsupported" : "deposited",
  }));
}

function structural(
  code: 0 | 1 | 2 = 0,
  entries: readonly AgentHookInspection[] = registrations(),
): AgentHookHealthResult {
  return {
    code,
    message: code === 0 ? "structural green" : "structural failed",
    stream: code === 0 ? "stdout" : "stderr",
    registrations: entries,
  };
}

function live(code: 0 | 1 | 2 = 0): AgentHookLiveProbeResult {
  return {
    code,
    message: code === 0 ? "live green" : "live failed",
    cases:
      code === 0
        ? []
        : [
            {
              host: "cursor",
              event: "tool.before",
              fixture: "allow",
              issue: code === 2 ? "hook-command-missing" : "empty-stdout",
              detail: "broken",
            },
          ],
    hosts:
      code === 0
        ? (["claude", "grok", "cursor", "codex"] as const).map((host) => ({
            host,
            status: "functional" as const,
          }))
        : [{ host: "cursor", status: code === 2 ? "unavailable" : "non-functional" }],
    durationMs: 4,
  };
}

describe("evaluateAgentHookReadiness", () => {
  it("converts an unexpected evaluator exception into fail-closed unavailable readiness", () => {
    const result = evaluateAgentHookReadinessSafely("/project", () => {
      throw new Error("policy unreadable");
    });

    expect(result).toMatchObject({
      code: 2,
      liveStatus: "unavailable",
      stream: "stderr",
      message: expect.stringContaining("policy unreadable"),
    });
  });

  it("also renders non-Error exceptions and the stable unavailable JSON projection", () => {
    const result = evaluateAgentHookReadinessSafely("/project", () => {
      throw "policy unreadable";
    });

    expect(agentHookReadinessJson(result)).toEqual({
      ready: false,
      exit_code: 2,
      skipped: false,
      live_status: "unavailable",
      hosts: [],
      message: expect.stringContaining("policy unreadable"),
    });
  });

  it("fails structurally before invoking the live probe", () => {
    const probe = vi.fn(() => live());
    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      evaluateStructural: () => structural(1),
      probeLive: probe,
    });

    expect(result.code).toBe(1);
    expect(result.liveStatus).toBe("not-run");
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports Codex trust and interception separately without hard failing trust", () => {
    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      evaluateStructural: () => structural(),
      probeLive: () => live(),
    });

    expect(result.code).toBe(0);
    expect(result.hosts.find((entry) => entry.host === "codex")).toMatchObject({
      registration: "registered",
      functionality: "functional",
      trust: "manual-review-required",
      interception: "not-directly-verified",
    });
    expect(result.message).toContain("/hooks");
  });

  it("skips consumer deposits in a maintainer source checkout", () => {
    const structuralProbe = vi.fn(() => structural(1));
    const liveProbe = vi.fn(() => live(1));
    const result = evaluateAgentHookReadiness("/framework", {
      consumerContext: () => false,
      evaluateStructural: structuralProbe,
      probeLive: liveProbe,
    });

    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
    expect(structuralProbe).not.toHaveBeenCalled();
    expect(liveProbe).not.toHaveBeenCalled();
  });

  it("does not probe opted-out hosts", () => {
    const policy = { ...DEFAULT_HOST_HOOKS_POLICY, codex: false, grok: false };
    const entries = registrations().map((entry) =>
      policy[entry.host] ? entry : { ...entry, status: "disabled" as const },
    );
    const probe = vi.fn(() => ({
      ...live(),
      hosts: [
        { host: "claude" as const, status: "functional" as const },
        { host: "cursor" as const, status: "functional" as const },
      ],
    }));

    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      hostHooksPolicy: policy,
      evaluateStructural: () => structural(0, entries),
      probeLive: probe,
    });

    expect(result.code).toBe(0);
    // evaluateAgentHookReadiness resolve()s the project root before probe (win32: C:\project).
    expect(probe).toHaveBeenCalledWith(
      resolve("/project"),
      expect.objectContaining({ hosts: ["claude", "cursor"] }),
    );
    expect(result.hosts.find((entry) => entry.host === "codex")).toMatchObject({
      registration: "disabled",
      functionality: "disabled",
      trust: "disabled",
      interception: "disabled",
    });
  });

  it("maps a missing installed shim to unavailable functionality", () => {
    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      evaluateStructural: () => structural(),
      probeLive: () => live(2),
    });

    expect(result.code).toBe(2);
    expect(result.liveStatus).toBe("unavailable");
    expect(result.hosts.find((entry) => entry.host === "cursor")?.functionality).toBe(
      "unavailable",
    );
  });

  it("maps live denials and absent host results without conflating registration", () => {
    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      evaluateStructural: () => structural(),
      probeLive: () => ({
        ...live(1),
        hosts: [{ host: "cursor", status: "non-functional" }],
      }),
    });

    expect(result.liveStatus).toBe("non-functional");
    expect(result.hosts.find((entry) => entry.host === "cursor")?.functionality).toBe(
      "non-functional",
    );
    expect(result.hosts.find((entry) => entry.host === "claude")?.functionality).toBe("not-run");
    expect(result.message).toContain("deft policy:disable-host-hooks");
    expect(result.message).toContain("deft-hook pre-execution guardrails");
    expect(result.message).not.toContain("hostHooks.<host> = false");
    expect(result.stream).toBe("stderr");
  });

  it("maps live timeouts as timed-out rather than non-functional (#3570)", () => {
    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      evaluateStructural: () => structural(),
      probeLive: () => ({
        code: 1,
        message: "live timed-out",
        cases: [
          {
            host: "cursor",
            event: "tool.before",
            fixture: "allow",
            issue: "timed-out",
            detail: "slow",
          },
        ],
        hosts: [{ host: "cursor", status: "timed-out" }],
        durationMs: 4,
      }),
    });

    expect(result.code).toBe(1);
    expect(result.liveStatus).toBe("timed-out");
    expect(result.hosts.find((entry) => entry.host === "cursor")?.functionality).toBe("timed-out");
    expect(result.message).not.toContain("disable-host-hooks");
    expect(result.message).not.toContain("hostHooks.<host>");
    expect(result.message).not.toContain("reinstall");
  });

  it("reports all opted-out hosts as disabled while still exercising the empty live probe", () => {
    const policy = {
      claude: false,
      grok: false,
      cursor: false,
      codex: false,
    };
    const entries = registrations("disabled");
    const probe = vi.fn(() => ({ ...live(), hosts: [] }));
    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      hostHooksPolicy: policy,
      evaluateStructural: () => structural(0, entries),
      probeLive: probe,
    });

    expect(result.code).toBe(0);
    expect(result.liveStatus).toBe("disabled");
    expect(result.hosts.every((entry) => entry.functionality === "disabled")).toBe(true);
    expect(result.message).not.toContain("Codex trust:");
    expect(probe).toHaveBeenCalledWith(resolve("/project"), expect.objectContaining({ hosts: [] }));
  });

  it("preserves missing and drifted structural registration states", () => {
    const entries = registrations().map((entry, index) => ({
      ...entry,
      status: (index % 2 === 0 ? "missing" : "drifted") as AgentHookInspection["status"],
    }));
    const result = evaluateAgentHookReadiness("/project", {
      consumerContext: () => true,
      evaluateStructural: () => structural(1, entries),
    });

    expect(result.hosts.map((entry) => entry.registration)).toEqual([
      "missing",
      "drifted",
      "missing",
      "drifted",
    ]);
  });

  it("uses the default evaluator safely for a maintainer source checkout", () => {
    const result = evaluateAgentHookReadinessSafely(process.cwd());

    expect(result).toMatchObject({ code: 0, skipped: true, liveStatus: "skipped" });
  });
});
