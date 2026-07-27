import { describe, expect, it } from "vitest";
import { runAgentHooksHealthCheck } from "./main.js";
import { createPlainSink } from "./output.js";
import type { DoctorSeams, Finding } from "./types.js";

describe("runAgentHooksHealthCheck", () => {
  it("skips agent-hooks registration on maintainer source checkout", () => {
    const lines: string[] = [];
    const findings: Finding[] = [];

    runAgentHooksHealthCheck(
      "/project",
      false,
      createPlainSink({ write: (text) => lines.push(text) }),
      (finding) => findings.push(finding),
      {},
    );

    expect(lines.join("")).toContain("skip -- maintainer source checkout");
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "skip",
        check: "agent-hooks-registration",
        status: "skip",
      }),
    ]);
  });

  it("records structural health and leaves Codex runtime trust unverifiable", () => {
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

    runAgentHooksHealthCheck(
      "/project",
      true,
      createPlainSink({ write: (text) => lines.push(text) }),
      (finding) => findings.push(finding),
      seams,
    );

    expect(lines.join("")).toContain("registered and structurally valid");
    expect(lines.join("")).toContain("`/hooks`");
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "skip",
        check: "agent-hooks-registration",
        status: "registered",
        trust_status: "not-verifiable",
        registrations,
      }),
    ]);
  });

  it("reports registration drift without claiming runtime non-functionality", () => {
    const findings: Finding[] = [];
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
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        status: "incomplete",
      }),
    ]);
  });

  it("distinguishes a registration probe configuration error", () => {
    const findings: Finding[] = [];
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
    );

    expect(findings).toEqual([expect.objectContaining({ status: "unavailable" })]);
  });

  it("reports a thrown registration probe without crashing doctor", () => {
    const findings: Finding[] = [];
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
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("probe failed"),
      }),
    ]);
  });
});
