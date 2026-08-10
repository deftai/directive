import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsRefreshPlan } from "./agents-md.js";
import { checkInstallPathConsistency, checkManifestAgreement } from "./checks.js";
import { cmdDoctor } from "./main.js";
import { createPlainSink } from "./output.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import { classifyTaskfileInclude } from "./taskfile.js";

describe("doctor branch coverage boost", () => {
  it("manifest agreement agrees yaml and bare", () => {
    const result = checkManifestAgreement("/tmp", ".deft/core", {
      isFile: () => true,
      readText: (p) => (p.includes(".deft-version") ? "0.1.0\n" : "tag: v0.1.0\n"),
    });
    expect(result.status).toBe("pass");
  });

  it("manifest agreement fails unparseable tag", () => {
    const result = checkManifestAgreement("/tmp", ".deft/core", {
      isFile: () => true,
      readText: (p) => (p.includes(".deft-version") ? "0.1.0\n" : "foo: bar\n"),
    });
    expect(result.status).toBe("fail");
  });

  it("install path uses manifest install_root", () => {
    const result = checkInstallPathConsistency("/tmp", ".deft/core", {
      isDir: () => true,
      readText: () => "install_root: custom/core\n",
    });
    expect(result.detail).toContain("manifest");
  });

  it("agents plan stale on legacy v2 marker", () => {
    const block = "<!-- deft:managed-section v2 -->\nold\n<!-- /deft:managed-section -->";
    const rendered = "<!-- deft:managed-section v3 -->\nnew\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => rendered,
      readAgents: () => block,
      resolveSha: () => "abc",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess",
    });
    expect(plan.state).toBe("stale");
  });

  it("agents plan absent file", () => {
    const block = "<!-- deft:managed-section v3 -->\nnew\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => block,
      readAgents: () => null,
      resolveSha: () => "abc",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess",
    });
    expect(plan.state).toBe("absent");
  });

  it("payload skip paths", () => {
    const sink = createPlainSink({ write: () => {} });
    const findings: unknown[] = [];
    runPayloadStalenessCheck("/tmp", sink, (f) => findings.push(f), {
      readText: () => null,
      isFile: () => false,
    });
    expect(findings.some((f) => (f as { message: string }).message === "no manifest")).toBe(true);
  });

  it("taskfile missing-include branch via cmdDoctor", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
      writeFileSync(join(root, "main.md"), "x", "utf8");
      expect(
        cmdDoctor(["--full", "--json", "--project-root", root], {
          whichFn: () => "/bin/x",
          isDir: (p) => p === root,
          // Do not invent live xBRIEF envelopes (unreadable → fail-closed #3243).
          isFile: (p) => !p.endsWith("deft") && !p.includes("xbrief") && !p.endsWith(".xbrief.json"),
          readText: () => null,
        }),
      ).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classify unreadable taskfile", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, "Taskfile.yml"), { recursive: true });
      expect(classifyTaskfileInclude(root)).toBe("unreadable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cmdDoctor warnings-only exit 0", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      const code = cmdDoctor(["--full", "--json", "--project-root", root], {
        whichFn: () => "/bin/x",
        isDir: (p) => p === root,
        // Avoid inventing unreadable PROJECT-DEFINITION / lifecycle envelopes (#3243).
        isFile: (p) => !p.includes("xbrief") && !p.endsWith(".xbrief.json"),
        readText: (p) =>
          p.includes("agents-entry")
            ? "<!-- deft:managed-section v3 -->\nt\n<!-- /deft:managed-section -->"
            : p.includes("AGENTS.md")
              ? "<!-- deft:managed-section v3 -->\nold\n<!-- /deft:managed-section -->"
              : null,
        agentsRefreshPlan: () => ({ state: "stale" }),
      });
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cmdDoctor consumer context fails when node is missing (#2022)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-consumer-"));
    const framework = mkdtempSync(join(tmpdir(), "deft-doc-framework-"));
    try {
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      const code = cmdDoctor(["--full", "--quiet", "--project-root", root], {
        frameworkRoot: framework,
        whichFn: (cmd) => (cmd === "node" ? null : "/bin/x"),
        isDir: () => true,
        isFile: () => true,
        readText: () => null,
      });
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(framework, { recursive: true, force: true });
    }
  });

  it("cmdDoctor consumer layout skips scripts/ under deposit (#2022)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-consumer-layout-"));
    const framework = mkdtempSync(join(tmpdir(), "deft-doc-framework-layout-"));
    const deposit = join(root, ".deft", "core");
    try {
      for (const dir of ["languages", "strategies", "skills", "templates", "tasks", "xbrief"]) {
        mkdirSync(join(deposit, dir), { recursive: true });
      }
      writeFileSync(
        join(root, "AGENTS.md"),
        "<!-- deft:managed-section v3 -->\n<!-- /deft:managed-section -->\n",
        "utf8",
      );
      writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
      const code = cmdDoctor(["--full", "--json", "--project-root", root], {
        frameworkRoot: framework,
        whichFn: () => "/bin/x",
        agentsRefreshPlan: () => ({ state: "current" }),
      });
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(framework, { recursive: true, force: true });
    }
  });
});
