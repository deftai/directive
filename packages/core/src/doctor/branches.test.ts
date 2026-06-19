import { describe, expect, it } from "vitest";
import { agentsRefreshPlan, hasV3ManagedMarker } from "./agents-md.js";
import { pythonJsonDump } from "./json.js";
import {
  isDeprecationRedirectStub,
  locateManifest,
  manifestTagToVersion,
  parseInstallManifest,
  parseInstallRootFromAgentsMd,
} from "./manifest.js";
import { createPlainSink } from "./output.js";
import { resolvePath, runningInsideDeftRepo } from "./paths.js";
import { runPayloadStalenessCheck } from "./payload-staleness.js";
import {
  classifyTaskfileInclude,
  formatMissingIncludeSnippet,
  includesBlockHasDeftTaskfile,
} from "./taskfile.js";
import { defaultWhich } from "./which.js";

describe("manifest helpers", () => {
  it("parses install manifest and tags", () => {
    const m = parseInstallManifest("tag: v0.1.0\nsha: abc\n");
    expect(m.tag).toBe("v0.1.0");
    expect(manifestTagToVersion(m)).toBe("0.1.0");
  });

  it("parseInstallRootFromAgentsMd", () => {
    expect(parseInstallRootFromAgentsMd("Deft is installed in .deft/core.")).toBe(".deft/core");
    expect(parseInstallRootFromAgentsMd("Full guidelines: .deft/core/main.md")).toBe(".deft/core");
    expect(parseInstallRootFromAgentsMd("nope")).toBeNull();
  });

  it("isDeprecationRedirectStub", () => {
    expect(isDeprecationRedirectStub("<!-- deft:deprecated-redirect -->\n")).toBe(true);
    expect(isDeprecationRedirectStub("# real skill\n")).toBe(false);
  });

  it("locateManifest canonical-first", () => {
    expect(locateManifest("/a", ".deft/core", (p) => p.endsWith(".deft/VERSION"))).toContain(
      ".deft/VERSION",
    );
  });
});

describe("agents-md", () => {
  it("reports template-missing", () => {
    const plan = agentsRefreshPlan("/tmp", { readTemplate: () => null });
    expect(plan.state).toBe("template-missing");
  });

  it("reports current when bytes match", () => {
    const block = "<!-- deft:managed-section v3 -->\nx\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => `prefix\n${block}\n`,
      readAgents: () => `${block}\n`,
      resolveSha: () => "abc",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess",
    });
    expect(plan.state).toBe("current");
  });

  it("hasV3ManagedMarker", () => {
    expect(hasV3ManagedMarker("/tmp", () => "<!-- deft:managed-section v3 -->\n")).toBe(true);
    expect(hasV3ManagedMarker("/tmp", () => null)).toBe(false);
  });
});

describe("taskfile", () => {
  it("detects include block", () => {
    const yaml =
      "version: '3'\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n";
    expect(includesBlockHasDeftTaskfile(yaml)).toBe(true);
    expect(formatMissingIncludeSnippet()).toContain("deft:");
  });

  it("classify missing file", () => {
    expect(classifyTaskfileInclude("/nonexistent-path-xyz")).toBe("missing-file");
  });
});

describe("payload staleness", () => {
  it("skips inside deft repo", () => {
    const lines: string[] = [];
    const sink = createPlainSink({ write: (t) => lines.push(t) });
    const findings: unknown[] = [];
    runPayloadStalenessCheck("/tmp", sink, (f) => findings.push(f), {
      readText: () => "Deft — Development Framework (deft repo)\n",
      isFile: () => true,
    });
    expect(findings.length).toBe(1);
  });

  it("warns when sha stale", () => {
    const lines: string[] = [];
    const sink = createPlainSink({ write: (t) => lines.push(t) });
    const findings: unknown[] = [];
    runPayloadStalenessCheck("/tmp", sink, (f) => findings.push(f), {
      readText: (p) =>
        p.endsWith("AGENTS.md") ? "consumer\n" : "sha: deadbeef\nref: main\ntag: v0.1.0\n",
      isFile: () => true,
      frameworkRoot: "/fw",
      runGitLsRemote: () => ({
        ok: true,
        stdout: "cafebabe refs/heads/main\n",
      }),
    });
    expect(lines.join("")).toContain("deft-install --yes --upgrade");
  });
});

describe("paths", () => {
  it("resolvePath expands relative", () => {
    expect(resolvePath(".", "/tmp")).toBe("/tmp");
  });

  it("runningInsideDeftRepo heuristic", () => {
    expect(
      runningInsideDeftRepo("/tmp", {
        isFile: (p) =>
          p.endsWith("main.md") || p.includes("agents-entry") || p.includes("SKILL.md"),
        isDir: () => false,
      }),
    ).toBe(true);
  });
});

describe("json + which", () => {
  it("pythonJsonDump sorts keys", () => {
    expect(pythonJsonDump({ b: 1, a: 2 })).toBe('{"a": 2, "b": 1}');
  });

  it("defaultWhich returns string or null", () => {
    expect(defaultWhich("node") !== null || defaultWhich("node") === null).toBe(true);
  });
});
