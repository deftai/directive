import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdDoctor } from "./main.js";

/**
 * Consumer-side advisory AGENTS.md legibility finding in `deft doctor` (#2155).
 *
 * The advisory MUST never turn `deft doctor` (and the `check:consumer`
 * aggregate that depends on it) into a fail-close: it emits at most a
 * `warning` finding, so the exit code stays 0 even when the unmanaged region
 * is over the soft budget.
 */
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeConsumerDeposit(options: {
  advisory?: Record<string, unknown>;
  unmanagedLines: number;
  markers?: boolean;
}): { root: string; framework: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-doc-advisory-"));
  const framework = mkdtempSync(join(tmpdir(), "deft-doc-advisory-fw-"));
  temps.push(root, framework);
  const deposit = join(root, ".deft", "core");
  for (const dir of ["languages", "strategies", "skills", "templates", "tasks", "vbrief"]) {
    mkdirSync(join(deposit, dir), { recursive: true });
  }
  const lines: string[] = [];
  for (let i = 0; i < options.unmanagedLines; i += 1) {
    lines.push(`project rule ${i}`);
  }
  if (options.markers !== false) {
    lines.push("<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->");
    lines.push("managed body");
    lines.push("<!-- /deft:managed-section -->");
  }
  writeFileSync(join(root, "AGENTS.md"), `${lines.join("\n")}\n`, "utf8");
  writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
  if (options.advisory !== undefined) {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          policy: { agentsMdAdvisory: options.advisory },
        },
      }),
      "utf8",
    );
  }
  return { root, framework };
}

type DoctorJsonPayload = { findings: Array<Record<string, unknown>> };

function runDoctorJson(
  root: string,
  framework: string,
): { code: number; payload: DoctorJsonPayload } {
  const stdout: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = cmdDoctor(["--full", "--json", "--project-root", root], {
      frameworkRoot: framework,
      whichFn: () => "/bin/x",
      agentsRefreshPlan: () => ({ state: "current" }),
    });
    return { code, payload: JSON.parse(stdout.join("")) };
  } finally {
    process.stdout.write = orig;
  }
}

describe("doctor agents-md advisory finding", () => {
  it("emits a non-failing warning (exit 0) when the unmanaged region is over the soft budget", () => {
    const { root, framework } = makeConsumerDeposit({
      advisory: { unmanagedSoftMaxLines: 0 },
      unmanagedLines: 5,
    });
    const { code, payload } = runDoctorJson(root, framework);
    expect(code).toBe(0);
    const finding = payload.findings.find((f) => f.check === "agents-md-advisory");
    expect(finding?.severity).toBe("warning");
    expect(finding?.status).toBe("over-soft-budget");
    expect(String(finding?.message)).toContain("advisory only");
  });

  it("reports success (no warning, exit 0) when within the soft budget", () => {
    const { root, framework } = makeConsumerDeposit({
      advisory: { unmanagedSoftMaxLines: 500 },
      unmanagedLines: 5,
    });
    const { code, payload } = runDoctorJson(root, framework);
    expect(code).toBe(0);
    const finding = payload.findings.find(
      (f) => f.check === "agents-md-advisory" && f.severity === "warning",
    );
    expect(finding).toBeUndefined();
  });

  it("skips (does not warn) in the maintainer repo / when no managed markers exist", () => {
    const { root, framework } = makeConsumerDeposit({
      advisory: { unmanagedSoftMaxLines: 0 },
      unmanagedLines: 5,
      markers: false,
    });
    const { code, payload } = runDoctorJson(root, framework);
    expect(code).toBe(0);
    const warning = payload.findings.find(
      (f) => f.check === "agents-md-advisory" && f.severity === "warning",
    );
    expect(warning).toBeUndefined();
  });
});
