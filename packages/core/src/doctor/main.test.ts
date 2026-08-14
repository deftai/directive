import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolutionFacts } from "../resolution/index.js";
import { parseDoctorFlags } from "./flags.js";
import {
  cmdDoctor,
  enforceDirectiveSurface,
  resolveOperatingMode,
  resolvePlatformSkew,
  resolveReconciliationLine,
  resolveTaskfileWiring,
  runResolutionDecision,
  runXbriefEnvelopeVersionCheck,
} from "./main.js";
import { createPlainSink } from "./output.js";
import type { DoctorSeams, Finding } from "./types.js";

describe("cmdDoctor", () => {
  it("returns 2 for unknown flags", () => {
    expect(cmdDoctor(["--nope"])).toBe(2);
  });

  it("returns 0 for full json in deft repo", () => {
    const stdout: string[] = [];
    const write = (t: string) => stdout.push(t);
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = write as typeof process.stdout.write;
    try {
      expect(cmdDoctor(["--full", "--json"], { whichFn: () => "/usr/bin/x" })).toBe(0);
      expect(stdout.join("")).toContain('"status": "completed"');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("returns 1 when uv missing", () => {
    expect(cmdDoctor(["--full", "--json"], { whichFn: () => null })).toBe(1);
  });

  it("honours throttle skip when dirty", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const exit = cmdDoctor(["--json"], {
      whichFn: () => "/usr/bin/x",
      readState: () => ({
        lastRunAt: new Date("2026-01-01T10:00:00Z"),
        lastExitCode: 1,
        lastFindingCount: 2,
        lastErrorCount: 1,
      }),
      now: () => now,
    });
    expect(exit).toBe(1);
  });

  it("bypasses throttle with --full", () => {
    expect(
      cmdDoctor(["--full", "--json"], {
        whichFn: () => "/usr/bin/x",
        readState: () => ({
          lastRunAt: new Date(),
          lastExitCode: 0,
          lastFindingCount: 0,
          lastErrorCount: 0,
        }),
      }),
    ).toBe(0);
  });

  it("emits a warning finding when a bare plan.policy shadows the namespaced form (#2301)", () => {
    const stdout: string[] = [];
    const write = (t: string) => stdout.push(t);
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = write as typeof process.stdout.write;
    try {
      const exit = cmdDoctor(["--full", "--json"], {
        whichFn: () => "/usr/bin/x",
        detectPlanExtensionShadows: () => [
          { namespacedKey: "x-directive/policy", legacyKey: "policy", shadowedSubKeys: ["wipCap"] },
        ],
      });
      // Shadow is a warning, not an error -- doctor stays green.
      expect(exit).toBe(0);
      const payload = stdout.join("");
      expect(payload).toContain('"check": "plan-extension-shadow"');
      expect(payload).toContain('"status": "shadowed"');
      expect(payload).toContain("plan.policy.wipCap");
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it("reports a clean plan-extension-shadow check when no shadow is present (#2301)", () => {
    const stdout: string[] = [];
    const write = (t: string) => stdout.push(t);
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = write as typeof process.stdout.write;
    try {
      const exit = cmdDoctor(["--full", "--json"], {
        whichFn: () => "/usr/bin/x",
        detectPlanExtensionShadows: () => [],
      });
      expect(exit).toBe(0);
      const payload = stdout.join("");
      expect(payload).not.toContain('"status": "shadowed"');
      // Clean case still emits a per-check skip finding so JSON consumers see an
      // entry for every check (parity with runUserMdResolutionCheck).
      expect(payload).toContain('"check": "plan-extension-shadow"');
      expect(payload).toContain('"status": "clean"');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

describe("cmdDoctor maintainer clone classification (#2850)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeMaintainerClone(): string {
    const root = mkdtempSync(join(tmpdir(), "deft-doctor-2850-"));
    created.push(root);
    writeFileSync(join(root, "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    mkdirSync(join(root, "content", "templates"), { recursive: true });
    mkdirSync(join(root, "content", "skills", "deft-directive-build"), { recursive: true });
    writeFileSync(join(root, "content", "templates", "agents-entry.md"), "# agents\n", "utf8");
    writeFileSync(
      join(root, "content", "skills", "deft-directive-build", "SKILL.md"),
      "# build\n",
      "utf8",
    );
    for (const dir of ["languages", "strategies", "skills", "templates"]) {
      mkdirSync(join(root, "content", dir), { recursive: true });
    }
    for (const dir of ["tasks", "scripts", "xbrief"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    return root;
  }

  it("skips hooks and structure warnings when global CLI targets a maintainer clone", () => {
    const root = makeMaintainerClone();
    const stdout: string[] = [];
    const write = (t: string) => stdout.push(t);
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = write as typeof process.stdout.write;
    try {
      const exit = cmdDoctor(["--full", "--json", "--project-root", root], {
        whichFn: () => "/usr/bin/x",
      });
      expect(exit).toBe(0);
      const payload = stdout.join("");
      expect(payload).toContain('"check": "agent-hooks-registration"');
      expect(payload).toContain("maintainer source checkout");
      expect(payload).not.toContain('"check": "framework-layout"');
      expect(payload).not.toContain("Missing directory:");
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

describe("parseDoctorFlags", () => {
  it("parses project-root forms", () => {
    expect(parseDoctorFlags(["--project-root", "/tmp"]).projectRoot).toBe("/tmp");
    expect(parseDoctorFlags(["--project-root=/tmp"]).projectRoot).toBe("/tmp");
    expect(parseDoctorFlags(["--project-root"]).unknown[0]).toContain("missing value");
  });

  it("parses OpenClaw pin wire flags (#3001)", () => {
    expect(parseDoctorFlags(["--force"]).force).toBe(true);
    expect(parseDoctorFlags(["--openclaw-all-agents"]).openclawAllAgents).toBe(true);
    expect(parseDoctorFlags([]).force).toBe(false);
    expect(parseDoctorFlags([]).openclawAllAgents).toBe(false);
  });
});

describe("createPlainSink", () => {
  it("suppresses success in quiet mode but not final", () => {
    const lines: string[] = [];
    const sink = createPlainSink({ quietMode: true, write: (t) => lines.push(t) });
    sink.success("hidden");
    sink.finalSuccess("shown");
    expect(lines.join("")).toContain("shown");
    expect(lines.join("")).not.toContain("hidden");
  });
});

// ---------------------------------------------------------------------------
// #2267: read-only, plan()-derived resolution decision surface.
// ---------------------------------------------------------------------------

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-doctor-2267-"));
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  vi.clearAllMocks();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const FACTS_BASE: ResolutionFacts = {
  hasGit: false,
  hasAppCode: false,
  hasDeftCore: false,
  deftCorePayloadVersion: null,
  hasManagedSection: false,
  managedSectionSha: null,
  hasVbrief: false,
  hasXbrief: false,
  preCutoverArtifacts: false,
  engineReachable: false,
  engineVersion: null,
  pinVersion: null,
};

const noEngine = () => ({ reachable: false, version: null });
const engineAt = (version: string) => () => ({ reachable: true, version });

function writePackagePin(root: string, version: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, devDependencies: { "@deftai/directive": version } }),
    "utf8",
  );
}

function makeDeposit(root: string): void {
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
}

function makeLegacyVbrief(root: string): void {
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "vbrief", folder), { recursive: true });
  }
}

function makeLocalEngine(root: string, platform: string, intact: boolean): void {
  const platformDir = join(root, ".deft", ".cli", platform);
  mkdirSync(platformDir, { recursive: true });
  if (intact) {
    writeFileSync(join(platformDir, "package.json"), "{}", "utf8");
    mkdirSync(join(platformDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(platformDir, "node_modules", ".bin", "directive"), "#!/bin/sh\n", "utf8");
  }
}

function runDecision(
  root: string,
  seams: DoctorSeams,
): { summary: ReturnType<typeof runResolutionDecision>; findings: Finding[]; text: string } {
  const lines: string[] = [];
  const sink = createPlainSink({ write: (t) => lines.push(t) });
  const findings: Finding[] = [];
  const summary = runResolutionDecision(root, false, sink, (f) => findings.push(f), seams);
  return { summary, findings, text: lines.join("") };
}

function countNextCommands(text: string): number {
  return (text.match(/^Next command:/gm) ?? []).length;
}

function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (statSync(full).isDirectory()) {
        entries.push(`${rel}/`);
        walk(full);
      } else {
        entries.push(rel);
      }
    }
  };
  walk(root);
  return entries.sort();
}

describe("enforceDirectiveSurface (#2267 no bare task)", () => {
  it("rewrites a bare task command to the directive surface without Taskfile wiring", () => {
    expect(enforceDirectiveSurface("task update:x", false)).toBe("directive update:x");
  });

  it("keeps a task command when Taskfile wiring exists", () => {
    expect(enforceDirectiveSurface("task update:x", true)).toBe("task update:x");
  });

  it("passes directive/npm commands and null through unchanged", () => {
    expect(enforceDirectiveSurface("npx @deftai/directive init", false)).toBe(
      "npx @deftai/directive init",
    );
    expect(enforceDirectiveSurface(null, false)).toBeNull();
  });
});

describe("resolveTaskfileWiring (#2267 seam-honoured)", () => {
  const wiredTaskfile =
    "version: '3'\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n";

  it("reads the Taskfile through the injected readText seam (no real fs)", () => {
    const seen: string[] = [];
    const readText = (path: string): string | null => {
      seen.push(path);
      return path.endsWith("Taskfile.yml") ? wiredTaskfile : null;
    };
    expect(resolveTaskfileWiring("/virtual/project", { readText })).toBe(true);
    expect(seen.some((p) => p.includes("Taskfile.yml"))).toBe(true);
  });

  it("returns false when the injected seam reports no Taskfile", () => {
    expect(resolveTaskfileWiring("/virtual/project", { readText: () => null })).toBe(false);
  });

  it("returns false when the Taskfile lacks the deft include", () => {
    const readText = (path: string): string | null =>
      path.endsWith("Taskfile.yml")
        ? "version: '3'\ntasks:\n  build:\n    cmds: [echo hi]\n"
        : null;
    expect(resolveTaskfileWiring("/virtual/project", { readText })).toBe(false);
  });

  it("suppresses a bare task command end-to-end when the seam reports no wiring", () => {
    const root = makeRoot();
    makeDeposit(root);
    makeLegacyVbrief(root);
    const { summary } = runDecision(root, {
      engineProbe: engineAt("0.69.0"),
      readText: () => null,
    });
    if (summary.nextCommand !== null) {
      expect(summary.nextCommand).not.toMatch(/^\s*task\s+/);
    }
  });
});

describe("resolveOperatingMode (#2267)", () => {
  it("labels each operating mode", () => {
    expect(resolveOperatingMode(FACTS_BASE)).toContain("greenfield");
    expect(resolveOperatingMode({ ...FACTS_BASE, hasAppCode: true })).toContain("brownfield");
    expect(resolveOperatingMode({ ...FACTS_BASE, hasManagedSection: true })).toContain("hybrid");
    expect(
      resolveOperatingMode({ ...FACTS_BASE, hasDeftCore: true, hasManagedSection: true }),
    ).toContain("hybrid");
    expect(resolveOperatingMode({ ...FACTS_BASE, hasDeftCore: true })).toContain("vendored");
    expect(resolveOperatingMode({ ...FACTS_BASE, preCutoverArtifacts: true })).toContain(
      "pre-cutover",
    );
  });
});

describe("resolveReconciliationLine (#2267)", () => {
  it("reports current when engine/pin/content align", () => {
    const line = resolveReconciliationLine({
      ...FACTS_BASE,
      engineReachable: true,
      engineVersion: "0.68.0",
      pinVersion: "0.68.0",
      deftCorePayloadVersion: "0.68.0",
    });
    expect(line).toContain("current");
  });

  it("flags engine behind pin", () => {
    const line = resolveReconciliationLine({
      ...FACTS_BASE,
      engineReachable: true,
      engineVersion: "0.60.0",
      pinVersion: "0.68.0",
    });
    expect(line).toContain("behind");
  });

  it("folds in engine-ahead skew", () => {
    const line = resolveReconciliationLine({
      ...FACTS_BASE,
      engineReachable: true,
      engineVersion: "0.69.0",
      pinVersion: "0.68.0",
    });
    expect(line).toContain("ahead");
  });

  it("never claims aligned without a committed pin (Greptile #2283)", () => {
    // engine present, no pin -> "no committed pin", not "aligned".
    expect(
      resolveReconciliationLine({ ...FACTS_BASE, engineReachable: true, engineVersion: "0.68.0" }),
    ).toContain("no committed package.json pin");
    // nothing present at all -> "nothing to reconcile".
    expect(resolveReconciliationLine(FACTS_BASE)).toContain("nothing to reconcile");
  });
});

describe("resolvePlatformSkew (#2267 cross-platform skew)", () => {
  it("detects a partial/divergent local engine as skew", () => {
    const root = makeRoot();
    makeLocalEngine(root, "linux", true);
    makeLocalEngine(root, "win32", false); // present but partial
    const res = resolvePlatformSkew(root, {
      resolutionPlatforms: ["linux", "darwin", "win32"],
    });
    expect(res.skewDetected).toBe(true);
    expect(res.line).toContain("skew detected");
    expect(res.findings.some((f) => f.check === "resolution:platform-skew")).toBe(true);
  });

  it("reports no engines when every platform is absent", () => {
    const root = makeRoot();
    const res = resolvePlatformSkew(root, { resolutionPlatforms: ["linux", "darwin"] });
    expect(res.skewDetected).toBe(false);
    expect(res.line).toContain("absent on all");
    expect(res.findings).toHaveLength(0);
  });
});

describe("runResolutionDecision state matrix (#2267)", () => {
  it("greenfield -> exactly one init next command, directive-surfaced", () => {
    const root = makeRoot();
    const { summary, findings, text } = runDecision(root, { engineProbe: noEngine });
    expect(summary.mode).toBe("init");
    expect(summary.actionRequired).toBe(true);
    expect(summary.operatingMode).toContain("greenfield");
    expect(summary.nextCommand).toBe("npx @deftai/directive init");
    expect(summary.nextCommand?.startsWith("task ")).toBe(false);
    expect(countNextCommands(text)).toBe(1);
    expect(findings.filter((f) => f.check === "resolution")).toHaveLength(1);
    expect(text).toContain("Root cause:");
    expect(text).toContain("Does / why safe:");
  });

  it("pre-cutover -> migrate with a manual next action (no command leaks)", () => {
    const root = makeRoot();
    writeFileSync(join(root, "SPECIFICATION.md"), "# Legacy hand-authored spec\n", "utf8");
    const { summary, text } = runDecision(root, { engineProbe: noEngine });
    expect(summary.mode).toBe("migrate");
    expect(summary.nextCommand).toBeNull();
    expect(summary.operatingMode).toContain("pre-cutover");
    expect(text).toContain("Next command: (manual");
    expect(countNextCommands(text)).toBe(1);
  });

  it("healthy deposit + legacy vbrief -> proceed; secondary migrate advice only after primary clears", () => {
    const root = makeRoot();
    makeDeposit(root);
    writePackagePin(root, "0.68.0");
    makeLegacyVbrief(root);
    const { summary, findings, text } = runDecision(root, { engineProbe: engineAt("0.68.0") });
    expect(summary.mode).toBe("proceed");
    expect(summary.actionRequired).toBe(false);
    expect(countNextCommands(text)).toBe(0);
    expect(text).toContain("directive migrate:xbrief");
    expect(summary.warnings.some((w) => w.includes("migrate:xbrief"))).toBe(true);
    const resolutionFinding = findings.filter((f) => f.check === "resolution")[0];
    expect(resolutionFinding?.severity).toBe("skip");
    // Exercise the proceed-branch guard message so a regression fails the suite
    // (SLizard #2283 validation-guard-test-gap).
    expect(resolutionFinding?.message).toContain("proceed");
  });

  it("engine behind pin (mismatched env) -> one install-global directive command", () => {
    const root = makeRoot();
    makeDeposit(root);
    writePackagePin(root, "0.68.0");
    const { summary, text } = runDecision(root, { engineProbe: engineAt("0.60.0") });
    expect(summary.mode).toBe("install-global");
    expect(summary.nextCommand).toBe("npm i -g @deftai/directive@0.68.0");
    expect(summary.reconciliation).toContain("behind");
    expect(summary.nextCommand?.startsWith("task ")).toBe(false);
    expect(countNextCommands(text)).toBe(1);
  });

  it("engine ahead within window (mismatched env) -> update", () => {
    const root = makeRoot();
    makeDeposit(root);
    writePackagePin(root, "0.68.0");
    const { summary } = runDecision(root, { engineProbe: engineAt("0.69.0") });
    expect(summary.mode).toBe("update");
    expect(summary.nextCommand).toBe("npx @deftai/directive update");
    expect(summary.reconciliation).toContain("ahead");
  });
});

describe("xbrief envelope version check (#2971)", () => {
  function writeProjectDefinition(root: string, envelope: Record<string, unknown>): void {
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify(envelope),
      "utf8",
    );
  }

  function runEnvelope(
    root: string,
    seams: DoctorSeams = {},
  ): { findings: Finding[]; text: string } {
    const lines: string[] = [];
    const sink = createPlainSink({ write: (t) => lines.push(t) });
    const findings: Finding[] = [];
    runXbriefEnvelopeVersionCheck(root, sink, (f) => findings.push(f), seams);
    return { findings, text: lines.join("") };
  }

  it("skips greenfield when no xBRIEF envelopes are present", () => {
    const root = makeRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const { findings, text } = runEnvelope(root);
    expect(findings[0]?.severity).toBe("skip");
    expect(findings[0]?.status).toBe("skip");
    expect(text.toLowerCase()).toMatch(/no project xbrief envelopes|greenfield/);
  });

  it("passes for single xBRIEFInfo@0.8", () => {
    const root = makeRoot();
    writeProjectDefinition(root, {
      xBRIEFInfo: { version: "0.8", description: "current" },
      plan: { title: "t", status: "running", narratives: {}, items: [] },
    });
    const { findings, text } = runEnvelope(root);
    expect(findings[0]?.status).toBe("current");
    expect(text).toContain("0.8");
    expect(text).toContain("framework 0.8");
  });

  it("fails closed on 0.6 under xbrief layout with migrate:xbrief next action", () => {
    const root = makeRoot();
    writeProjectDefinition(root, {
      xBRIEFInfo: { version: "0.6", description: "stale write-path" },
      plan: { title: "t", status: "running", narratives: {}, items: [] },
    });
    const { findings, text } = runEnvelope(root);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.status).toBe("behind-major");
    expect(findings[0]?.next_command).toBe("deft migrate:xbrief");
    expect(findings[0]?.suggestion).toBe("deft migrate:xbrief");
    expect(text).toContain("migrate:xbrief");
    expect(text).toContain("behind-major");
    expect(text).toContain("declared 0.6");
    expect(text).toContain("framework 0.8");
  });

  it("fails closed on dual vBRIEFInfo@0.6 + half xBRIEFInfo state", () => {
    const root = makeRoot();
    writeProjectDefinition(root, {
      vBRIEFInfo: { version: "0.6", description: "dogfood half-state" },
      xBRIEFInfo: { updated: "2026-07-24T16:05:43Z" },
      plan: { title: "t", status: "running", narratives: {}, items: [] },
    });
    const { findings } = runEnvelope(root);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.status).toBe("behind-major");
    expect(findings[0]?.next_command).toBe("deft migrate:xbrief");
  });

  it("fails closed when a lifecycle story is 0.6 even if PROJECT-DEFINITION is 0.8 (#3243)", () => {
    const root = makeRoot();
    writeProjectDefinition(root, {
      xBRIEFInfo: { version: "0.8", description: "current definition" },
      plan: { title: "t", status: "running", narratives: {}, items: [] },
    });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.6", description: "hybrid residual" },
        plan: { title: "stale story", status: "running", narratives: {}, items: [] },
      }),
      "utf8",
    );
    const { findings, text } = runEnvelope(root);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.status).toBe("behind-major");
    expect(text).toContain("declared 0.6");
    expect(text).toContain("framework 0.8");
    expect(text).toContain("story.xbrief.json");
  });

  it("cmdDoctor exits non-zero when project JSON is behind-major", () => {
    const root = makeRoot();
    makeDeposit(root);
    writePackagePin(root, "0.68.0");
    writeProjectDefinition(root, {
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "t", status: "running", narratives: {}, items: [] },
    });
    const exit = cmdDoctor(["--full", "--json", "--project-root", root], {
      whichFn: () => "/usr/bin/x",
      engineProbe: engineAt("0.68.0"),
      writeState: () => null,
    });
    expect(exit).toBe(1);
  });
});

describe("cmdDoctor read-only + resolution wiring (#2267)", () => {
  it("mutates no project files in default report mode (only throttle state may be written)", () => {
    const root = makeRoot();
    makeDeposit(root);
    writePackagePin(root, "0.68.0");
    const before = snapshot(root);
    const writeTextSpy = vi.fn();
    const stateWrites: string[] = [];
    const exit = cmdDoctor(["--full", "--json", "--project-root", root], {
      whichFn: () => "/usr/bin/x",
      engineProbe: engineAt("0.68.0"),
      writeText: writeTextSpy,
      writeState: (p) => {
        stateWrites.push(p);
        return null;
      },
    });
    const after = snapshot(root);
    expect(writeTextSpy).not.toHaveBeenCalled();
    expect(after).toEqual(before);
    expect(typeof exit).toBe("number");
  });

  it("emits the resolution block in the --json payload", () => {
    const root = makeRoot();
    makeDeposit(root);
    writePackagePin(root, "0.68.0");
    const stdout: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      cmdDoctor(["--full", "--json", "--project-root", root], {
        whichFn: () => "/usr/bin/x",
        engineProbe: engineAt("0.68.0"),
        writeState: () => null,
      });
    } finally {
      process.stdout.write = origWrite;
    }
    const parsed: unknown = JSON.parse(stdout.join(""));
    // JSON.parse can return a top-level null without throwing; guard before
    // any property access so a malformed payload fails loud, not with a
    // TypeError (SLizard #2283 P1).
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    const payload = parsed as {
      resolution?: { mode?: string; operating_mode?: string; next_command?: string | null };
    };
    expect(payload.resolution).toBeDefined();
    expect(payload.resolution?.mode).toBe("proceed");
    expect(payload.resolution?.operating_mode).toContain("vendored");
  });
});

describe("cmdDoctor USER.md resolution surface (#2271)", () => {
  function runJson(seams: DoctorSeams): {
    ok: boolean;
    exit: number;
    payload: {
      user_md?: { path: string; rung: string; found: boolean; diagnostic: string };
      findings?: Array<Record<string, unknown>>;
    };
  } {
    const stdout: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    let exit: number;
    try {
      exit = cmdDoctor(["--full", "--json"], { whichFn: () => "/usr/bin/x", ...seams });
    } finally {
      process.stdout.write = origWrite;
    }
    const parsed: unknown = JSON.parse(stdout.join(""));
    // JSON.parse can return a top-level null without throwing; guard before any
    // property access so a malformed payload fails loud, not with a TypeError.
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    return {
      ok: exit === 0,
      exit,
      payload: parsed as {
        user_md?: { path: string; rung: string; found: boolean; diagnostic: string };
        findings?: Array<Record<string, unknown>>;
      },
    };
  }

  it("surfaces the resolved USER.md path + matched rung in the --json payload", () => {
    const { payload } = runJson({
      resolveUserMd: () => ({
        path: "/work/.deft/USER.md",
        rung: "workspace-local",
        found: true,
        diagnostic: "USER.md resolved from workspace-local config: /work/.deft/USER.md",
        searched: [],
      }),
    });
    expect(payload.user_md).toEqual({
      path: "/work/.deft/USER.md",
      rung: "workspace-local",
      found: true,
      diagnostic: "USER.md resolved from workspace-local config: /work/.deft/USER.md",
    });
    const finding = payload.findings?.find((f) => f.check === "user-md-resolution");
    expect(finding).toBeDefined();
    expect(finding?.status).toBe("resolved");
    expect(finding?.rung).toBe("workspace-local");
    expect(finding?.severity).toBe("skip");
  });

  it("surfaces the using-defaults diagnostic without failing the doctor", () => {
    const { exit, payload } = runJson({
      resolveUserMd: () => ({
        path: "/home/x/.config/deft/USER.md",
        rung: "default",
        found: false,
        diagnostic: "no USER.md found; using defaults (searched: a, b)",
        searched: ["a", "b"],
      }),
    });
    // A defaulted USER.md is informational only; it must never fail doctor.
    expect(exit).toBe(0);
    expect(payload.user_md?.found).toBe(false);
    expect(payload.user_md?.rung).toBe("default");
    const finding = payload.findings?.find((f) => f.check === "user-md-resolution");
    expect(finding?.status).toBe("defaulted");
    expect(finding?.severity).toBe("skip");
    expect(String(finding?.message)).toContain("no USER.md found; using defaults");
  });

  it("uses the shared resolver by default (no seam) without throwing", () => {
    const { payload } = runJson({});
    expect(payload.user_md).toBeDefined();
    expect(typeof payload.user_md?.path).toBe("string");
  });
});

describe("cmdDoctor completed-open-items advisory mapping (#3372)", () => {
  function makeConsumer(): { root: string; framework: string } {
    const root = makeRoot();
    const framework = makeRoot();
    const deposit = join(root, ".deft", "core");
    for (const dir of ["languages", "strategies", "skills", "templates", "tasks", "xbrief"]) {
      mkdirSync(join(deposit, dir), { recursive: true });
    }
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- deft:managed-section v3 sha=abc refreshed=x session=y -->\nmanaged\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
    return { root, framework };
  }

  function writeCompletedBrief(root: string, name: string, body: string): void {
    const dir = join(root, "xbrief", "completed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, "utf8");
  }

  function runDoctorJson(
    root: string,
    framework: string,
    argv: string[] = ["--full", "--json", "--project-root", root],
  ): {
    exit: number;
    lastErrorCount: number;
    payload: {
      ok?: boolean;
      findings?: Array<Record<string, unknown>>;
      summary?: { errors?: number; warnings?: number };
    };
  } {
    const stdout: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    let lastErrorCount = -1;
    let exit: number;
    try {
      exit = cmdDoctor(argv, {
        whichFn: () => "/usr/bin/x",
        frameworkRoot: framework,
        agentsRefreshPlan: () => ({ state: "current" }),
        writeState: (_projectRoot, payload) => {
          lastErrorCount = payload.errorCount;
          return null;
        },
      });
    } finally {
      process.stdout.write = origWrite;
    }
    const parsed: unknown = JSON.parse(stdout.join(""));
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    return {
      exit,
      lastErrorCount,
      payload: parsed as {
        ok?: boolean;
        findings?: Array<Record<string, unknown>>;
        summary?: { errors?: number; warnings?: number };
      },
    };
  }

  it("maps historical completed/ open items to a warning: exit 0, lastErrorCount 0, paths named", () => {
    const { root, framework } = makeConsumer();
    writeCompletedBrief(
      root,
      "open.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "open",
          status: "completed",
          items: [{ title: "todo", status: "pending" }],
        },
      }),
    );
    const { exit, lastErrorCount, payload } = runDoctorJson(root, framework);
    expect(exit).toBe(0);
    expect(lastErrorCount).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.summary?.errors).toBe(0);
    const finding = payload.findings?.find(
      (f) =>
        f.install_check === "completed-open-items" ||
        f.check === "install-integrity:completed-open-items",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(String(finding?.message)).toContain("completed/open.xbrief.json");
    expect(String(finding?.message)).toContain("pending");
    // Gated ritual invokes cmdDoctor without --full; same mapping must stay advisory.
    const ritual = runDoctorJson(root, framework, ["--json", "--project-root", root]);
    expect(ritual.exit).toBe(0);
    expect(ritual.lastErrorCount).toBe(0);
  });

  it("still hard-fails completed-lifecycle-consistency on plan.status drift", () => {
    const { root, framework } = makeConsumer();
    writeCompletedBrief(
      root,
      "drift.xbrief.json",
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "drift",
          status: "running",
          items: [{ title: "done", status: "completed" }],
        },
      }),
    );
    const { exit, lastErrorCount, payload } = runDoctorJson(root, framework);
    expect(exit).toBe(1);
    expect(lastErrorCount).toBeGreaterThan(0);
    const finding = payload.findings?.find(
      (f) =>
        f.install_check === "completed-lifecycle-consistency" ||
        f.check === "install-integrity:completed-lifecycle-consistency",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(String(finding?.message)).toContain("completed/drift.xbrief.json");
    expect(String(finding?.message)).toContain("plan.status=running");
  });

  it("still hard-fails completed-lifecycle-consistency on unreadable completed artifacts", () => {
    const { root, framework } = makeConsumer();
    writeCompletedBrief(root, "bad.xbrief.json", "{not-json");
    const { exit, lastErrorCount, payload } = runDoctorJson(root, framework);
    expect(exit).toBe(1);
    expect(lastErrorCount).toBeGreaterThan(0);
    const finding = payload.findings?.find(
      (f) =>
        f.install_check === "completed-lifecycle-consistency" ||
        f.check === "install-integrity:completed-lifecycle-consistency",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(String(finding?.message)).toContain("completed/bad.xbrief.json");
  });
});
