import { describe, expect, it, vi } from "vitest";
import { runAgentHooksHealthCheck, runAgentHooksLiveProbeCheck } from "./main.js";
import { createPlainSink } from "./output.js";
import type { DoctorSeams, Finding } from "./types.js";

describe("runAgentHooksHealthCheck", () => {
  it("skips registration inspection in a maintainer checkout", () => {
    const findings: Finding[] = [];
    const evaluateAgentHooks = vi.fn();

    expect(
      runAgentHooksHealthCheck(
        "/framework",
        false,
        createPlainSink({ write: () => undefined }),
        (finding) => findings.push(finding),
        { evaluateAgentHooks },
      ),
    ).toBe(false);
    expect(evaluateAgentHooks).not.toHaveBeenCalled();
    expect(findings).toEqual([expect.objectContaining({ severity: "skip", status: "skip" })]);
  });

  it("records structural health and separates manual Codex trust review", () => {
    const lines: string[] = [];
    const findings: Finding[] = [];
    const registrations = [
      {
        host: "codex" as const,
        path: ".codex/hooks.json" as const,
        status: "healthy" as const,
        detail: "registrations are current",
      },
    ];
    const seams: DoctorSeams = {
      evaluateAgentHooks: () => ({
        code: 0,
        message: "registered",
        stream: "stdout",
        registrations,
      }),
    };

    expect(
      runAgentHooksHealthCheck(
        "/project",
        true,
        createPlainSink({ write: (text) => lines.push(text) }),
        (finding) => findings.push(finding),
        seams,
      ),
    ).toBe(true);
    expect(lines.join("")).toContain("registered and structurally valid");
    expect(lines.join("")).toContain("Codex trust is manual-review-required");
    expect(lines.join("")).not.toMatch(/open\s+`\/hooks`/i);
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "skip",
        check: "agent-hooks-registration",
        status: "registered",
        trust_status: "manual-review-required",
        interception_status: "not-directly-verified",
        registrations,
      }),
    ]);
    expect(findings[0]?.trust_review ?? "").not.toMatch(/open\s+`\/hooks`/i);
  });

  it("returns true without emitting a registered finding when cmdDoctor replaces it", () => {
    const findings: Finding[] = [];
    const before = findings.length;
    expect(
      runAgentHooksHealthCheck(
        "/project",
        true,
        createPlainSink({ write: () => undefined }),
        (finding) => findings.push(finding),
        {
          evaluateAgentHooks: () => ({
            code: 0,
            message: "registered",
            stream: "stdout",
            registrations: [],
          }),
        },
      ),
    ).toBe(true);
    expect(findings.length).toBe(before + 1);
    if (findings.length > before) {
      findings.pop();
    }
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [],
        }),
        probeAgentHooksLive: () => ({
          code: 0,
          message: "live probe passed",
          cases: [],
          hosts: [],
          durationMs: 1,
        }),
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );
    expect(findings.at(-1)).toEqual(
      expect.objectContaining({
        check: "agent-hooks-live-probe",
        status: "registered-and-functional",
      }),
    );
  });

  it("reports not-applicable trust when Codex is not enabled", () => {
    const findings: Finding[] = [];
    expect(
      runAgentHooksHealthCheck(
        "/project",
        true,
        createPlainSink({ write: () => undefined }),
        (finding) => findings.push(finding),
        {
          evaluateAgentHooks: () => ({
            code: 0,
            message: "registered",
            stream: "stdout",
            registrations: [
              {
                host: "codex",
                path: ".codex/hooks.json",
                status: "disabled",
                detail: "disabled",
                compactSupport: "unsupported",
              },
            ],
          }),
        },
      ),
    ).toBe(true);

    expect(findings).toEqual([
      expect.objectContaining({ trust_status: "not-applicable", trust_review: null }),
    ]);
  });

  it("reports registration drift without claiming runtime non-functionality", () => {
    const findings: Finding[] = [];
    expect(
      runAgentHooksHealthCheck(
        "/project",
        true,
        createPlainSink({ write: () => undefined }),
        (finding) => findings.push(finding),
        {
          evaluateAgentHooks: () => ({
            code: 1,
            message: "registration incomplete",
            stream: "stderr",
            registrations: [],
          }),
        },
      ),
    ).toBe(false);

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        status: "incomplete",
      }),
    ]);
  });

  it("distinguishes a registration probe configuration error", () => {
    const findings: Finding[] = [];
    expect(
      runAgentHooksHealthCheck(
        "/project",
        true,
        createPlainSink({ write: () => undefined }),
        (finding) => findings.push(finding),
        {
          evaluateAgentHooks: () => ({
            code: 2,
            message: "project root unavailable",
            stream: "stderr",
            registrations: [],
          }),
        },
      ),
    ).toBe(false);

    expect(findings).toEqual([expect.objectContaining({ status: "unavailable" })]);
  });

  it("reports a thrown registration probe without crashing doctor", () => {
    const findings: Finding[] = [];
    expect(
      runAgentHooksHealthCheck(
        "/project",
        true,
        createPlainSink({ write: () => undefined }),
        (finding) => findings.push(finding),
        {
          evaluateAgentHooks: () => {
            throw new Error("probe failed");
          },
        },
      ),
    ).toBe(false);

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("probe failed"),
      }),
    ]);
  });
});

describe("runAgentHooksLiveProbeCheck", () => {
  it("fails closed when registration changes before the live probe", () => {
    const findings: Finding[] = [];
    const liveProbe = vi.fn();

    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 1,
          message: "codex registration missing",
          stream: "stderr",
          registrations: [],
        }),
        probeAgentHooksLive: liveProbe,
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );

    expect(liveProbe).not.toHaveBeenCalled();
    expect(findings).toEqual([
      expect.objectContaining({
        check: "agent-hooks-registration",
        status: "incomplete",
        message: expect.stringContaining("codex registration missing"),
      }),
    ]);
  });

  it("records a passing live probe under doctor --full", () => {
    const findings: Finding[] = [];
    const liveProbe = vi.fn(() => ({
      code: 0 as const,
      message: "live probe passed",
      cases: [],
      hosts: [],
      durationMs: 1,
    }));

    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [],
        }),
        probeAgentHooksLive: liveProbe,
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );

    expect(liveProbe).toHaveBeenCalledTimes(1);
    expect(findings).toEqual([
      expect.objectContaining({
        check: "agent-hooks-live-probe",
        status: "registered-and-functional",
        live_probe: "passed",
      }),
    ]);
  });

  it("passes only structurally enabled hosts to the full live probe", () => {
    const liveProbe = vi.fn(() => ({
      code: 0 as const,
      message: "live probe passed",
      cases: [],
      hosts: [{ host: "cursor" as const, status: "functional" as const }],
      durationMs: 1,
    }));

    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      () => undefined,
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [
            {
              host: "cursor",
              path: ".cursor/hooks.json",
              status: "healthy",
              compactSupport: "deposited",
              detail: "registered",
            },
            {
              host: "codex",
              path: ".codex/hooks.json",
              status: "disabled",
              compactSupport: "unsupported",
              detail: "disabled",
            },
          ],
        }),
        probeAgentHooksLive: liveProbe,
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );

    expect(liveProbe).toHaveBeenCalledWith("/project", { hosts: ["cursor"] });
  });

  it("surfaces empty-stdout hook bins as non-functional", () => {
    const findings: Finding[] = [];
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [],
        }),
        probeAgentHooksLive: () => ({
          code: 1,
          message: "deft agent hooks live probe FAILED: allow: empty-stdout (empty stdout)",
          cases: [
            {
              host: "cursor",
              event: "tool.before",
              fixture: "allow",
              issue: "empty-stdout",
              detail: "empty stdout",
            },
          ],
          hosts: [{ host: "cursor", status: "non-functional" }],
          durationMs: 1,
        }),
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        check: "agent-hooks-live-probe",
        status: "non-functional",
        severity: "warning",
      }),
    ]);
  });

  it("distinguishes an unavailable live probe", () => {
    const findings: Finding[] = [];
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [],
        }),
        probeAgentHooksLive: () => ({
          code: 2,
          message: "deft-hook missing",
          cases: [],
          hosts: [],
          durationMs: 1,
        }),
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );

    expect(findings).toEqual([expect.objectContaining({ status: "unavailable" })]);
  });

  it("reports successful live readiness without a Codex trust review", () => {
    const findings: Finding[] = [];
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [],
        }),
        probeAgentHooksLive: () => ({
          code: 0,
          message: "passed",
          cases: [],
          hosts: [],
          durationMs: 7,
        }),
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        trust_status: "not-applicable",
        trust_review: null,
        live_probe_duration_ms: 7,
      }),
    ]);
  });

  it("keeps Codex trust review orthogonal after a successful live probe", () => {
    const lines: string[] = [];
    const findings: Finding[] = [];
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: (text) => lines.push(text) }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [
            {
              host: "codex",
              path: ".codex/hooks.json",
              status: "healthy",
              detail: "registered",
              compactSupport: "unsupported",
            },
          ],
        }),
        probeAgentHooksLive: () => ({
          code: 0,
          message: "passed",
          cases: [],
          hosts: [{ host: "codex", status: "functional" }],
          durationMs: 3,
        }),
        probePowershellDeftHookReachability: () => ({
          ok: true as const,
          skipped: true as const,
          source: null,
          detail: "test-skip",
        }),
      },
    );

    expect(lines.join("")).toContain("Codex trust is manual-review-required");
    expect(lines.join("")).not.toMatch(/open\s+`\/hooks`/i);
    expect(findings).toEqual([
      expect.objectContaining({
        trust_status: "manual-review-required",
        interception_status: "not-directly-verified",
      }),
    ]);
    expect(findings[0]?.trust_review ?? "").not.toMatch(/open\s+`\/hooks`/i);
  });

  it("contains a thrown live readiness probe", () => {
    const findings: Finding[] = [];
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => {
          throw "live probe exploded";
        },
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({ message: expect.stringContaining("live probe exploded") }),
    ]);
  });

  it("fails closed when Restricted PowerShell cannot reach deft-hook.cmd (#4659)", () => {
    const findings: Finding[] = [];
    const lines: string[] = [];
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: (text) => lines.push(text) }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [
            {
              host: "codex",
              path: ".codex/hooks.json",
              status: "healthy",
              detail: "registered",
              compactSupport: "unsupported",
            },
          ],
        }),
        probeAgentHooksLive: () => ({
          code: 0,
          message: "live probe passed",
          cases: [],
          hosts: [{ host: "codex", status: "functional" }],
          durationMs: 2,
        }),
        probePowershellDeftHookReachability: () => ({
          ok: false,
          skipped: false,
          source: "C:\\npm\\deft-hook.ps1",
          detail: "Get-Command selected .ps1 under Restricted",
        }),
      },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        check: "agent-hooks-live-probe",
        status: "non-functional",
        severity: "warning",
        suggestion: expect.stringMatching(/Restricted|\.cmd|#4654|postinstall/i),
      }),
    ]);
    expect(findings[0]?.suggestion ?? "").toMatch(/Do not set ExecutionPolicy Bypass/i);
    expect(findings[0]?.suggestion ?? "").toMatch(/\.cmd|#4654|postinstall/i);
    expect(findings[0]?.status).not.toBe("registered-and-functional");
    expect(lines.join("")).toMatch(/Restricted/);
    expect(lines.join("")).toContain("deft-hook");
  });

  it("does not mark hooks non-functional for stale PATH .ps1 when every host is disabled (#4659)", () => {
    const findings: Finding[] = [];
    const psReach = vi.fn(() => ({
      ok: false as const,
      skipped: false as const,
      source: "C:\\npm\\deft-hook.ps1",
      detail: "Get-Command selected .ps1 under Restricted",
    }));
    runAgentHooksLiveProbeCheck(
      "/project",
      createPlainSink({ write: () => undefined }),
      (finding) => findings.push(finding),
      {
        evaluateAgentHooks: () => ({
          code: 0,
          message: "registered",
          stream: "stdout",
          registrations: [
            {
              host: "codex",
              path: ".codex/hooks.json",
              status: "disabled",
              detail: "disabled",
              compactSupport: "unsupported",
            },
            {
              host: "cursor",
              path: ".cursor/hooks.json",
              status: "disabled",
              detail: "disabled",
              compactSupport: "deposited",
            },
          ],
        }),
        probeAgentHooksLive: () => ({
          code: 0,
          message: "deft agent hooks live probe skipped: every host is intentionally disabled.",
          cases: [],
          hosts: [],
          durationMs: 0,
        }),
        probePowershellDeftHookReachability: psReach,
      },
    );

    expect(psReach).not.toHaveBeenCalled();
    expect(findings).toEqual([
      expect.objectContaining({
        check: "agent-hooks-live-probe",
        status: "registered-and-functional",
        live_probe: "passed",
      }),
    ]);
  });
});
