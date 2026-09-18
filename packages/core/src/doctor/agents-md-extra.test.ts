import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCorePackageVersion } from "../engine-version.js";
import {
  agentsRefreshPlan,
  agentsRefreshPlanWithInstalledTemplate,
  hasManagedSectionMarker,
  hasV3ManagedMarker,
  peekDoctorAgentsTemplateRoot,
  readAgentsTemplateFromContentTree,
  resolveDoctorAgentsTemplateRootSync,
  setDoctorAgentsTemplateRoot,
} from "./agents-md.js";

const MANAGED = "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->";

describe("agents-md extra branches", () => {
  it("uses resolveSha seam when provided", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => null,
      resolveSha: () => "customsha12",
    });
    expect(plan.sha).toBe("customsha12");
  });

  it("returns inventory identity when payload is not own git root (#4246)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-nongit-"));
    try {
      const plan = agentsRefreshPlan(root, {
        readTemplate: () => MANAGED,
        readAgents: () => null,
        frameworkRoot: root,
      });
      expect(plan.sha).toBe(readCorePackageVersion());
      expect(plan.sha).not.toBe("unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects template-malformed when close marker missing", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => "<!-- deft:managed-section v3 -->\nno close",
      readAgents: () => null,
    });
    expect(plan.state).toBe("template-malformed");
  });

  it("wraps legacy content without managed section", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => "# Legacy header\n",
      resolveSha: () => "sha1",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess12345678",
    });
    expect(plan.state).toBe("missing");
    expect(String(plan.new_content)).toContain("Legacy header");
  });

  it("wraps empty legacy body with only rendered section", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => "",
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("missing");
    expect(String(plan.new_content)).toMatch(/^<!-- deft:managed-section/);
  });

  it("deduplicates multiple managed sections", () => {
    const existing =
      "<!-- deft:managed-section v3 -->\nold1\n<!-- /deft:managed-section -->\n\n" +
      "<!-- deft:managed-section v3 -->\nold2\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => existing,
      resolveSha: () => "sha1",
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "sess12345678",
    });
    expect(plan.state).toBe("stale");
    expect(String(plan.new_content)).not.toContain("old2");
  });

  it("marks legacy v1 marker as stale", () => {
    const existing = "<!-- deft:managed-section v1 -->\nlegacy\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => existing,
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("stale");
  });

  it("returns current when strip matches rendered", () => {
    const rendered = MANAGED;
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => rendered,
      readAgents: () => rendered,
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("current");
  });

  it("returns unreadable when readAgents throws", () => {
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => {
        throw new Error("permission denied");
      },
    });
    expect(plan.state).toBe("unreadable");
  });

  it("hasV3ManagedMarker false for missing file via default reader", () => {
    expect(hasV3ManagedMarker("/nonexistent/path/xyz")).toBe(false);
  });

  it("hasManagedSectionMarker is exported and true for any recognized opener", () => {
    expect(typeof hasManagedSectionMarker).toBe("function");
    expect(hasManagedSectionMarker("/tmp", () => MANAGED)).toBe(true);
    expect(hasManagedSectionMarker("/tmp", () => "<!-- deft:managed-section v2 -->\n")).toBe(true);
    expect(hasManagedSectionMarker("/tmp", () => "# user header\n")).toBe(false);
    expect(hasManagedSectionMarker("/tmp", () => null)).toBe(false);
  });

  it("uses default readTemplate when seam omitted and template missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      const plan = agentsRefreshPlan(root, {
        frameworkRoot: root,
        readAgents: () => null,
      });
      expect(plan.state).toBe("template-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses default readAgents when seam omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-"));
    try {
      mkdirSync(join(root, ".deft", "core"), { recursive: true });
      const plan = agentsRefreshPlan(root, {
        readTemplate: () => MANAGED,
        resolveSha: () => "sha1",
      });
      expect(plan.state).toBe("absent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to write when close marker missing mid-file", () => {
    const existing = "<!-- deft:managed-section v3 -->\nunclosed\n";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => MANAGED,
      readAgents: () => existing,
      resolveSha: () => "sha1",
    });
    expect(plan.state).toBe("unreadable");
    expect(plan.reason).toBe("truncated-close");
    expect(plan.new_content).toBeNull();
  });

  it("reads an explicit content-tree AGENTS template without prefer-package (#4706)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-tpl-"));
    try {
      expect(readAgentsTemplateFromContentTree(root)).toBeNull();
      mkdirSync(join(root, "templates"), { recursive: true });
      writeFileSync(join(root, "templates", "agents-entry.md"), MANAGED, "utf8");
      expect(readAgentsTemplateFromContentTree(root)).toBe(MANAGED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agentsRefreshPlanWithInstalledTemplate uses the explicit template root (#4706)", () => {
    const project = mkdtempSync(join(tmpdir(), "deft-doc-inst-proj-"));
    const installed = mkdtempSync(join(tmpdir(), "deft-doc-inst-tpl-"));
    try {
      mkdirSync(join(installed, "templates"), { recursive: true });
      writeFileSync(join(installed, "templates", "agents-entry.md"), MANAGED, "utf8");
      const plan = agentsRefreshPlanWithInstalledTemplate(project, installed, {
        readAgents: () => null,
        resolveSha: () => "installedsha",
      });
      expect(plan.state).toBe("absent");
      expect(plan.sha).toBe("installedsha");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(installed, { recursive: true, force: true });
    }
  });

  it("falls back when the installed content tree has no agents template (#4706)", () => {
    const project = mkdtempSync(join(tmpdir(), "deft-doc-inst-miss-"));
    const installed = mkdtempSync(join(tmpdir(), "deft-doc-inst-empty-"));
    try {
      const plan = agentsRefreshPlanWithInstalledTemplate(project, installed, {
        readAgents: () => null,
        resolveSha: () => "fallbacksha",
      });
      expect(plan.state).toBe("absent");
      expect(plan.sha).toBe("fallbacksha");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(installed, { recursive: true, force: true });
    }
  });

  it("set/peek doctor agents template root (#4706)", () => {
    expect(peekDoctorAgentsTemplateRoot()).toBeUndefined();
    setDoctorAgentsTemplateRoot("/engine/content");
    expect(peekDoctorAgentsTemplateRoot()).toBe("/engine/content");
    setDoctorAgentsTemplateRoot(undefined);
    expect(peekDoctorAgentsTemplateRoot()).toBeUndefined();
  });

  it("cmdDoctor template root uses peek when set, else installed package (#4706 polish)", () => {
    setDoctorAgentsTemplateRoot("/engine/content");
    expect(resolveDoctorAgentsTemplateRootSync()).toBe("/engine/content");
    setDoctorAgentsTemplateRoot(undefined);
    const resolved = resolveDoctorAgentsTemplateRootSync();
    expect(resolved === undefined || resolved.includes("directive-content") || resolved.includes("content")).toBe(true);
  });
});
