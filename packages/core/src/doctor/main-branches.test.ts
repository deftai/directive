import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentsRefreshPlan } from "./agents-md.js";
import * as checks from "./checks.js";
import { decideThrottle, readState, writeState } from "./doctor-state.js";
import { formatAllowedFlagsHint, formatUnknownFlagsError, parseDoctorFlags } from "./flags.js";
import { cmdDoctor } from "./main.js";
import { extractManagedSection, readManifestAt } from "./manifest.js";
import { createPlainSink } from "./output.js";
import { readTextSafe, resolvePath, resolveVersion, runningInsideDeftRepo } from "./paths.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import { classifyTaskfileInclude, includesBlockHasDeftTaskfile } from "./taskfile.js";
import { defaultWhich } from "./which.js";

describe("main human-mode branches", () => {
  it("prints final error summary when tools missing", () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(cmdDoctor(["--full"], { whichFn: () => null })).toBe(1);
      expect(lines.join("")).toContain("System check failed");
    } finally {
      process.stdout.write = orig;
    }
  });

  it("prints warning-only summary", () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(
        cmdDoctor(["--full"], {
          whichFn: (c) => (c === "node" ? null : "/bin/x"),
        }),
      ).toBe(0);
      expect(lines.join("")).toContain("System check completed with");
    } finally {
      process.stdout.write = orig;
    }
  });

  it("clean throttle skip human line", () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(
        cmdDoctor([], {
          whichFn: () => "/bin/x",
          readState: () => ({
            lastRunAt: new Date(),
            lastExitCode: 0,
            lastFindingCount: 0,
            lastErrorCount: 0,
          }),
          now: () => new Date(),
        }),
      ).toBe(0);
      expect(lines.join("")).toContain("[doctor] ran");
    } finally {
      process.stdout.write = orig;
    }
  });
});

function writeConsumerRoot(root: string): void {
  mkdirSync(join(root, ".deft", "core"), { recursive: true });
  writeFileSync(join(root, ".deft", "core", "QUICK-START.md"), "# qs\n", "utf8");
  writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core.\n", "utf8");
}

describe("taskfile interactive fix", () => {
  it("writes Taskfile on fix approval", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    const writes: string[] = [];
    try {
      writeConsumerRoot(root);
      expect(
        cmdDoctor(["--full", "--fix", "--project-root", root], {
          whichFn: () => "/bin/x",
          isTty: () => true,
          readYn: () => true,
          writeText: (p, c) => writes.push(`${p}:${c.length}`),
        }),
      ).toBe(0);
      expect(writes.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declines Taskfile creation", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeConsumerRoot(root);
      expect(
        cmdDoctor(["--full", "--fix", "--project-root", root], {
          whichFn: () => "/bin/x",
          isTty: () => true,
          readYn: () => false,
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles missing-include with taskfile present", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeConsumerRoot(root);
      writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles unreadable taskfile", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, "Taskfile.yml"), { recursive: true });
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
          isDir: (p) => p === root || p.includes("Taskfile.yml"),
          isFile: () => true,
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("install integrity and agents paths", () => {
  it("runs install integrity on consumer project", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core.\n", "utf8");
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      writeFileSync(join(root, ".deft", "core", "QUICK-START.md"), "# q\n", "utf8");
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
          isDir: (p) => p.includes("core") || p === root,
          isFile: (p) => p.endsWith("AGENTS.md") || p.endsWith("QUICK-START.md"),
          readText: (p) =>
            p.endsWith("AGENTS.md") ? "Deft is installed in .deft/core.\n" : "# q\n",
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("install integrity probe exception becomes warning", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeConsumerRoot(root);
      const spy = vi.spyOn(checks, "runChecks").mockImplementation(() => {
        throw new Error("boom");
      });
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
        }),
      ).toBe(0);
      spy.mockRestore();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agents freshness unreadable state", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
          isDir: (p) => p === root,
          isFile: () => true,
          agentsRefreshPlan: () => ({ state: "unreadable" }),
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agents freshness probe throws", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
          isDir: (p) => p === root,
          isFile: () => true,
          agentsRefreshPlan: () => {
            throw new Error("fail");
          },
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agents freshness stale warns operator", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      expect(
        cmdDoctor(["--full", "--project-root", root], {
          whichFn: () => "/bin/x",
          readText: (p) =>
            p.endsWith("AGENTS.md")
              ? "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n"
              : null,
          agentsRefreshPlan: () => ({ state: "stale" }),
        }),
      ).toBe(0);
      expect(lines.join("")).toContain("agents:refresh");
    } finally {
      process.stdout.write = orig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("install integrity error status is reported", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeConsumerRoot(root);
      const spy = vi.spyOn(checks, "runChecks").mockReturnValue({
        project_root: root,
        install_root: ".deft/core",
        exit_code: 2,
        checks: [
          {
            name: "broken-check",
            status: "error",
            detail: "probe exploded",
            data: {},
          },
        ],
        errors: [],
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

  it("install integrity surfaces top-level errors", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeConsumerRoot(root);
      const spy = vi.spyOn(checks, "runChecks").mockReturnValue({
        project_root: root,
        install_root: null,
        exit_code: 2,
        checks: [],
        errors: ["project root does not exist: /missing"],
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

  it("taskfile write failure surfaces error", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      writeConsumerRoot(root);
      expect(
        cmdDoctor(["--full", "--fix", "--project-root", root], {
          whichFn: () => "/bin/x",
          isTty: () => true,
          readYn: () => true,
          writeText: () => {
            throw new Error("disk full");
          },
        }),
      ).toBe(0);
      expect(lines.join("")).toContain("Failed to write");
    } finally {
      process.stdout.write = orig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("missing-include prints snippet in human mode", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      writeConsumerRoot(root);
      writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
      expect(
        cmdDoctor(["--full", "--project-root", root], {
          whichFn: () => "/bin/x",
        }),
      ).toBe(0);
      expect(lines.join("")).toContain("includes:");
    } finally {
      process.stdout.write = orig;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("helpers branch sweep", () => {
  it("flags all branches", () => {
    expect(
      parseDoctorFlags(["--session", "--fix", "--json", "--quiet", "--full", "-h"]).session,
    ).toBe(true);
    expect(parseDoctorFlags(["--repair"]).fix).toBe(true);
    expect(parseDoctorFlags(["--repair-taskfile"]).fix).toBe(true);
    expect(parseDoctorFlags(["--project-root="]).unknown.length).toBe(1);
    expect(formatUnknownFlagsError(["x"])).toContain("x");
    expect(formatAllowedFlagsHint()).toContain("--session");
  });

  it("manifest extractManagedSection", () => {
    expect(
      extractManagedSection("<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->"),
    ).toBeTruthy();
    expect(extractManagedSection("nope")).toBeNull();
  });

  it("readManifestAt null path", () => {
    expect(readManifestAt(null)).toBeNull();
  });

  it("resolvePath home expansion", () => {
    expect(resolvePath("~/tmp", "/")).toContain("tmp");
  });

  it("resolveVersion reads VERSION file", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ver-"));
    try {
      writeFileSync(join(root, "VERSION"), "1.2.3\n", "utf8");
      expect(resolveVersion(root)).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("taskfile include detection false for comment-only", () => {
    expect(includesBlockHasDeftTaskfile("# includes:\n")).toBe(false);
  });

  it("classify ok when include present", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeFileSync(
        join(root, "Taskfile.yml"),
        "includes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n",
        "utf8",
      );
      expect(classifyTaskfileInclude(root)).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agents duplicate blocks and template malformed", () => {
    const block = "<!-- deft:managed-section v3 -->\na\n<!-- /deft:managed-section -->";
    const dup = `${block}\n<!-- deft:managed-section v3 -->\nb\n<!-- /deft:managed-section -->`;
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => block,
      readAgents: () => dup,
      resolveSha: () => "s",
      nowIso: () => "t",
      newSession: () => "id",
    });
    expect(plan.state).toBe("stale");
    expect(agentsRefreshPlan("/tmp", { readTemplate: () => "no markers" }).state).toBe(
      "template-malformed",
    );
  });

  it("payload staleness skip branches", () => {
    const sink = createPlainSink({ write: () => {} });
    const add = vi.fn();
    runPayloadStalenessCheck("/tmp", sink, add, {
      readText: () => "consumer",
      isFile: (p) => p.endsWith("VERSION"),
      frameworkRoot: "/fw",
      runGitLsRemote: () => ({ ok: false, stdout: "" }),
    });
    runPayloadStalenessCheck("/tmp", sink, add, {
      readText: (p) => (p.endsWith("VERSION") ? "sha: abc\n" : "consumer"),
      isFile: () => true,
      frameworkRoot: "/fw",
    });
    runPayloadStalenessCheck("/tmp", sink, add, {
      readText: (p) => (p.endsWith("VERSION") ? "ref: main\nsha: abc\n" : "consumer"),
      isFile: () => true,
      frameworkRoot: "/fw",
      runGitLsRemote: () => ({ ok: true, stdout: "" }),
    });
    runPayloadStalenessCheck("/tmp", sink, add, {
      readText: (p) => (p.endsWith("VERSION") ? "ref: main\nsha: abc\n" : "consumer"),
      isFile: () => true,
      frameworkRoot: "/fw",
      runGitLsRemote: () => ({
        ok: true,
        stdout: "peeledsha12345678901234567890123456789012 refs/heads/main^{}\n",
      }),
    });
    runPayloadStalenessCheck("/tmp", sink, add, {
      readText: (p) => (p.endsWith("VERSION") ? "ref: main\nsha: abc\n" : "consumer"),
      isFile: () => true,
      frameworkRoot: "/fw",
      runGitLsRemote: () => ({ ok: true, stdout: "abc refs/heads/main\n" }),
    });
    runPayloadStalenessCheck("/tmp", sink, add, {
      readText: (p) => (p.endsWith(".deft-version") ? "sha: x\nref: main\n" : null),
      isFile: (p) => p.endsWith(".deft-version"),
      frameworkRoot: "/fw",
      runGitLsRemote: () => {
        throw new Error("network");
      },
    });
    expect(add.mock.calls.length).toBeGreaterThan(0);
  });

  it("runningInsideDeftRepo rejects consumer layouts", () => {
    expect(
      runningInsideDeftRepo("/repo", {
        isFile: (p) => p.endsWith("main.md") || p.endsWith("AGENTS.md"),
        isDir: (p) => p.includes("deft") && !p.includes(".deft"),
      }),
    ).toBe(false);
    expect(
      runningInsideDeftRepo("/repo", {
        isFile: (p) => p.endsWith("main.md"),
        isDir: (p) => p.includes(".deft/core"),
      }),
    ).toBe(false);
  });

  it("resolvePath empty uses cwd", () => {
    expect(resolvePath("")).toBe(process.cwd());
  });

  it("readTextSafe delegates to reader", () => {
    expect(readTextSafe("/x", () => null)).toBeNull();
    expect(readTextSafe("/x", () => "ok")).toBe("ok");
  });

  it("doctor-state read/write roundtrip", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-state-"));
    try {
      writeState(root, { exitCode: 1, findingCount: 2, errorCount: 1 });
      const state = readState(root);
      expect(state?.lastExitCode).toBe(1);
      expect(decideThrottle(null).skip).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("output json mode suppresses all", () => {
    const lines: string[] = [];
    const sink = createPlainSink({ jsonMode: true, write: (t) => lines.push(t) });
    sink.info("i");
    sink.success("s");
    sink.warn("w");
    sink.error("e");
    sink.header("h");
    expect(lines.length).toBe(0);
  });

  it("defaultWhich miss returns null", () => {
    expect(defaultWhich("definitely-not-a-real-binary-xyz-999")).toBeNull();
  });
});
