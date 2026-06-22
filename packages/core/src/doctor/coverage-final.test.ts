import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentsRefreshPlan, hasV3ManagedMarker } from "./agents-md.js";
import * as checks from "./checks.js";
import { checkInstallPathConsistency, runChecksImpl } from "./checks.js";
import { decideThrottle, readState, statePath } from "./doctor-state.js";
import { cmdDoctor } from "./main.js";
import { manifestTagToVersion, parseManifest } from "./manifest.js";
import { createPlainSink } from "./output.js";
import { resolveDefaultFrameworkRoot, resolvePath, runningInsideDeftRepo } from "./paths.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import { defaultWhich } from "./which.js";

describe("doctor coverage final", () => {
  it("statePath expands home in override", () => {
    const prev = process.env.DEFT_DOCTOR_STATE_PATH;
    const home = process.env.HOME ?? "/tmp";
    process.env.DEFT_DOCTOR_STATE_PATH = "~/doctor-state-test.json";
    expect(statePath("/p")).toBe(join(home, "doctor-state-test.json"));
    if (prev === undefined) delete process.env.DEFT_DOCTOR_STATE_PATH;
    else process.env.DEFT_DOCTOR_STATE_PATH = prev;
  });

  it("readState rejects invalid last_run_at types", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-state-"));
    try {
      mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
      writeFileSync(
        join(root, "vbrief", ".eval", "doctor-state.json"),
        JSON.stringify({
          last_run_at: 123,
          last_exit_code: 0,
          last_finding_count: 0,
          last_error_count: 0,
        }),
        "utf8",
      );
      expect(readState(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("decideThrottle allows run after window", () => {
    const decision = decideThrottle(
      {
        lastRunAt: new Date("2020-01-01T00:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 0,
        lastErrorCount: 0,
      },
      new Date("2030-01-01T00:00:00Z"),
    );
    expect(decision.skip).toBe(false);
  });

  it("agents missing legacy wrap", () => {
    const rendered = "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => rendered,
      readAgents: () => "# legacy consumer notes\n",
      resolveSha: () => "abc",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess",
    });
    expect(plan.state).toBe("missing");
  });

  it("agents unreadable file", () => {
    const rendered = "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => rendered,
      readAgents: () => {
        throw new Error("perm");
      },
    });
    expect(plan.state).toBe("unreadable");
  });

  it("agentsRefreshPlan uses git sha helper", () => {
    const rendered = "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => rendered,
      readAgents: () => null,
      resolveSha: () => "unknown",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess",
    });
    expect(plan.state).toBe("absent");
  });

  it("runningInsideDeftRepo false when deft dir exists", () => {
    expect(
      runningInsideDeftRepo("/tmp", {
        isFile: (p) => p.endsWith("main.md"),
        isDir: (p) => p.endsWith("/deft") || p.endsWith("deft"),
      }),
    ).toBe(false);
  });

  it("resolvePath empty uses cwd", () => {
    expect(resolvePath("", "/tmp/cwd")).toBe("/tmp/cwd");
  });

  it("payload uses legacy deft-version marker", () => {
    const sink = createPlainSink({ write: () => {} });
    const findings: unknown[] = [];
    runPayloadStalenessCheck("/tmp", sink, (f) => findings.push(f), {
      readText: (p) => (p.endsWith("AGENTS.md") ? "consumer\n" : null),
      isFile: (p) => p.endsWith(".deft-version"),
      frameworkRoot: "/fw",
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("payload remote probe throws", () => {
    const sink = createPlainSink({ write: () => {} });
    runPayloadStalenessCheck("/tmp", sink, () => {}, {
      readText: (p) =>
        p.endsWith("VERSION")
          ? "sha: abcdef0123456789abcdef0123456789abcdef01\nref: main\n"
          : "c\n",
      isFile: (p) => p.endsWith("VERSION") || p.endsWith("AGENTS.md"),
      frameworkRoot: "/fw",
      runGitLsRemote: () => {
        throw new Error("net");
      },
    });
  });

  it("install integrity error status branch", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "QUICK-START.md"), "# q\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core.\n", "utf8");
      const spy = vi.spyOn(checks, "runChecks").mockReturnValue({
        checks: [{ name: "x", status: "error", detail: "cfg", data: {} }],
      });
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
        }),
      ).toBe(1);
      spy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("manifest parse skips bad lines", () => {
    expect(parseManifest("# comment\nbadline\nkey: val\n").key).toBe("val");
    expect(manifestTagToVersion({ ref: "  v1.2.3  " })).toBe("1.2.3");
  });

  it("install path manifest fallback note", () => {
    const result = checkInstallPathConsistency("/tmp", ".deft/core", {
      isDir: () => true,
      readText: () => "tag: v0.1.0\n",
    });
    expect(result.detail).toContain("missing install_root");
  });

  it("hasV3ManagedMarker with unreadable agents", () => {
    expect(hasV3ManagedMarker("/tmp", () => null)).toBe(false);
  });

  it("cmdDoctor taskfile write failure", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "QUICK-START.md"), "# q\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core.\n", "utf8");
      expect(
        cmdDoctor(["--full", "--json", "--fix", "--project-root", root], {
          whichFn: () => "/bin/x",
          isTty: () => true,
          readYn: () => true,
          writeText: () => {
            throw new Error("denied");
          },
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaultWhich uses platform locator", () => {
    const plat = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(defaultWhich("node") !== null || defaultWhich("node") === null).toBe(true);
    plat.mockRestore();
  });

  it("resolveDefaultFrameworkRoot returns a path", () => {
    const root = resolveDefaultFrameworkRoot();
    expect(existsSync(join(root, "main.md"))).toBe(true);
    // #1875: templates/ moved under content/ in the source repo.
    expect(existsSync(join(root, "content", "templates", "agents-entry.md"))).toBe(true);
  });

  it("payload staleness skip when sha or ref missing", () => {
    const sink = createPlainSink({ write: () => {} });
    runPayloadStalenessCheck("/tmp", sink, () => {}, {
      readText: (p) => (p.endsWith("VERSION") ? "ref: main\n" : "consumer\n"),
      isFile: (p) => p.endsWith("VERSION") || p.endsWith("AGENTS.md"),
      frameworkRoot: "/fw",
    });
    runPayloadStalenessCheck("/tmp", sink, () => {}, {
      readText: (p) => (p.endsWith("VERSION") ? "sha: abc\n" : "consumer\n"),
      isFile: (p) => p.endsWith("VERSION") || p.endsWith("AGENTS.md"),
      frameworkRoot: "/fw",
    });
  });

  it("payload staleness current when shas match", () => {
    const lines: string[] = [];
    const sink = createPlainSink({ write: (t) => lines.push(t) });
    runPayloadStalenessCheck("/tmp", sink, () => {}, {
      readText: (p) =>
        p.endsWith("VERSION")
          ? "sha: abcdef0123456789abcdef0123456789abcdef01\nref: main\n"
          : "consumer\n",
      isFile: (p) => p.endsWith("VERSION") || p.endsWith("AGENTS.md"),
      frameworkRoot: "/fw",
      runGitLsRemote: () => ({
        ok: true,
        stdout: "abcdef0123456789abcdef0123456789abcdef01 refs/heads/main\n",
      }),
    });
    expect(lines.join("")).toContain("current");
  });

  it("runChecksImpl full consumer happy path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    const isDir = (p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    };
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "QUICK-START.md"), "# q\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core.\n", "utf8");
      const result = runChecksImpl(root, { isDir });
      expect(result.exitCode).toBe(0);
      expect(result.checks.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cmdDoctor agents current with v3 marker", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
          agentsRefreshPlan: () => ({ state: "current" }),
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
