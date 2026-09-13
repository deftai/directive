import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasManagedSectionMarker as doctorHasManagedSectionMarker } from "../../doctor/agents-md.js";
import {
  checkQuickStartResolves,
  checkSkillPathsResolve,
  runChecksImpl,
} from "../../doctor/checks.js";
import {
  RECOVERY_LADDER_AGENTS_REFRESH,
  RECOVERY_LADDER_NPM_GLOBAL,
  RECOVERY_LADDER_UNREADABLE_TRUNCATED,
  RECOVERY_LADDER_UNREADABLE_TRUNCATED_OPEN,
  RECOVERY_LADDER_UPDATE,
  recoveryLadderFields,
  unreadableAgentsRecovery,
} from "../../doctor/constants.js";
import { extractManagedSection } from "../../doctor/manifest.js";
import {
  agentsRefreshPlan,
  attributeRenderManagedSection,
  hasManagedSectionMarker as platformHasManagedSectionMarker,
} from "../../platform/agents-md.js";
import { readText, repoRoot } from "./_helpers.js";

const CLOSE = "<!-- /deft:managed-section -->";
const TEMPLATE = `<!-- deft:managed-section v3 -->\n# Deft\n${CLOSE}`;
const SEAMS = {
  readTemplate: () => TEMPLATE,
  resolveSha: () => "abc123456789",
  nowIso: () => "2026-09-03T00:00:00Z",
  newSession: () => "session123456",
};

function dispatchText(): string {
  return readFileSync(join(repoRoot(), "packages/cli/src/dispatch.ts"), { encoding: "utf8" });
}

describe("recovery ladder (#4090)", () => {
  it("binds classifier current|stale|missing|absent from the template, not v3=current", () => {
    const rendered = TEMPLATE;
    const current = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => rendered });
    expect(current.state).toBe("current");

    const v2 = rendered.replace("v3", "v2");
    const stale = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => v2 });
    expect(stale.state).toBe("stale");

    const missing = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => "# legacy\n" });
    expect(missing.state).toBe("missing");

    const absent = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => null });
    expect(absent.state).toBe("absent");
  });

  it("refuses to write on a truncated close", () => {
    const truncated = "<!-- deft:managed-section v3 -->\nno close\n";
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => truncated });
    expect(plan.state).toBe("unreadable");
    expect(plan.reason).toBe("truncated-close");
    expect(plan.new_content).toBeNull();
    expect(plan.existing).toBe(truncated);
  });

  it("classifies a truncated opener followed by an existing close as truncated-open", () => {
    const truncatedThenClose = `<!-- deft:managed-section v3\nbody\n${CLOSE}\n`;
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => truncatedThenClose });
    expect(plan.state).toBe("unreadable");
    expect(plan.reason).toBe("truncated-open");
    expect(plan.new_content).toBeNull();
    expect(unreadableAgentsRecovery("truncated-open").suggested_fix).toBe(
      RECOVERY_LADDER_UNREADABLE_TRUNCATED_OPEN,
    );
  });

  it("classifies a truncated current-version opener as truncated-open with opener repair", () => {
    const truncatedOpen = "<!-- deft:managed-section v3";
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => truncatedOpen });
    expect(plan.state).toBe("unreadable");
    expect(plan.reason).toBe("truncated-open");
    expect(plan.new_content).toBeNull();
    const recovery = unreadableAgentsRecovery("truncated-open");
    expect(recovery.suggested_fix).toBe(RECOVERY_LADDER_UNREADABLE_TRUNCATED_OPEN);
    expect(recovery.suggested_fix).not.toBe(RECOVERY_LADDER_UPDATE);
    expect(recovery.suggested_fix).not.toBe(RECOVERY_LADDER_UNREADABLE_TRUNCATED);
    expect(recovery.suggested_fix).toContain("-->");
  });

  it("refuses to write on an unsupported future marker", () => {
    const future = `<!-- deft:managed-section v4 -->\n# Deft\n${CLOSE}`;
    const plan = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => future });
    expect(plan.state).toBe("unreadable");
    expect(plan.reason).toBe("unsupported-future");
    expect(plan.new_content).toBeNull();
  });

  it("doctor suggested_fix is the registered ladder and never .deft/core/run", () => {
    const fields = recoveryLadderFields("agents-refresh");
    expect(fields.suggested_fix).toBe(RECOVERY_LADDER_AGENTS_REFRESH);
    expect(fields.suggested_fix_alt).toBe(RECOVERY_LADDER_UPDATE);
    expect(fields.suggested_fix_npx).toBe("npx @deftai/directive agents:refresh");
    expect(fields.suggested_fix_npm_global).toBe(RECOVERY_LADDER_NPM_GLOBAL);
    expect(fields.go_bridge_releases_url).toContain("github.com/deftai/directive/releases");

    const qs = checkQuickStartResolves("/tmp", ".deft/core", { isFile: () => false });
    expect(qs.status).toBe("fail");
    expect(qs.detail).not.toContain(".deft/core/run");
    expect(qs.data?.suggested_fix).toBe(RECOVERY_LADDER_AGENTS_REFRESH);
    expect(qs.data?.suggested_fix_alt).toBe(RECOVERY_LADDER_UPDATE);

    const skills = checkSkillPathsResolve(
      "/tmp",
      "see .deft/core/skills/deft-directive-build/SKILL.md\n",
      { isFile: () => false },
    );
    expect(skills.status).toBe("fail");
    expect(skills.detail).not.toContain(".deft/core/run");
    expect(skills.data?.suggested_fix).toBe(RECOVERY_LADDER_AGENTS_REFRESH);

    const absent = runChecksImpl("/tmp", { isDir: () => true, readText: () => null });
    const present = absent.checks.find((c) => c.name === "agents-md-present");
    expect(present?.status).toBe("fail");
    expect(present?.detail).not.toContain(".deft/core/run");
    expect(present?.data?.suggested_fix).toBe(RECOVERY_LADDER_AGENTS_REFRESH);
    expect(present?.data?.suggested_fix).toBe("deft agents:refresh");
  });

  it("exports hasManagedSectionMarker from doctor and platform classifiers", () => {
    expect(doctorHasManagedSectionMarker).toBe(platformHasManagedSectionMarker);
    expect(typeof doctorHasManagedSectionMarker).toBe("function");
    expect(doctorHasManagedSectionMarker("/proj", () => "<!-- deft:managed-section v3 -->\n")).toBe(
      true,
    );
    expect(doctorHasManagedSectionMarker("/proj", () => "# no markers\n")).toBe(false);
  });

  it("attributes the template-keyed opener, never a silent v2 write", () => {
    const absent = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => null });
    const greenfield = String(absent.new_content);
    expect(greenfield).toMatch(/<!-- deft:managed-section v3 sha=/);
    expect(greenfield).not.toMatch(/<!-- deft:managed-section v2(\s|>)/);

    const v2Existing = `<!-- deft:managed-section v2 -->\nold\n${CLOSE}`;
    const stale = agentsRefreshPlan("/proj", { ...SEAMS, readAgents: () => v2Existing });
    expect(stale.state).toBe("stale");
    const rewritten = String(stale.new_content);
    expect(rewritten).toMatch(/<!-- deft:managed-section v3 sha=/);
    expect(rewritten).not.toMatch(/<!-- deft:managed-section v2(\s|>)/);

    const attributed = attributeRenderManagedSection(TEMPLATE, {
      frameworkSha: "sha$&dollar",
      refreshed: "2026-09-03T00:00:00Z",
      sessionId: "sess$`id",
      version: 3,
    });
    expect(attributed).toContain("sha=sha$&dollar");
    expect(attributed).toContain("session=sess$`id");
    expect(attributed).not.toContain("<!-- deft:managed-section v2");
  });

  it("ladder verbs resolve in dispatch.ts", () => {
    const dispatch = dispatchText();
    expect(dispatch).toContain('"agents:refresh": "agents-refresh"');
    expect(dispatch).toContain('"agents-refresh"');
    expect(dispatch).toMatch(/upgrade:\s*"install-upgrade"/);
  });

  it("layout extract treats v1 as pre-canonical, not a writable v3 section", () => {
    const v1 =
      "# Project\n<!-- deft:managed-section v1 -->\nold body\n<!-- /deft:managed-section -->\n";
    expect(extractManagedSection(v1)).toBeNull();
    expect(
      extractManagedSection(
        "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->",
      ),
    ).toContain("v3");
  });

  it("unreadable doctor remediation is not a no-op refresh", () => {
    const truncated = unreadableAgentsRecovery("truncated-close");
    expect(truncated.suggested_fix).toBe(RECOVERY_LADDER_UNREADABLE_TRUNCATED);
    expect(truncated.suggested_fix).not.toBe(RECOVERY_LADDER_AGENTS_REFRESH);
    expect(truncated.message).toContain("will not write");
    const future = unreadableAgentsRecovery("unsupported-future");
    expect(future.suggested_fix).toBe(RECOVERY_LADDER_UPDATE);
    expect(future.suggested_fix).not.toBe(RECOVERY_LADDER_AGENTS_REFRESH);
    expect(future.message).toContain("will not write");
  });

  it("managed carrier reuses #4090 ladder spellings and is doctor-first (#4430)", () => {
    const template = readText("templates/agents-entry.md");
    expect(template).toContain(RECOVERY_LADDER_NPM_GLOBAL);
    expect(template).toContain("directive doctor");
    expect(template).not.toContain(`${RECOVERY_LADDER_NPM_GLOBAL} && directive doctor`);
    const fallback = template.split("\n").find((line) => line.includes(".agents/skills"));
    expect(fallback).toBeDefined();
    const doctorAt = fallback!.indexOf("directive doctor");
    const installAt = fallback!.indexOf(RECOVERY_LADDER_NPM_GLOBAL);
    expect(doctorAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThanOrEqual(0);
    expect(doctorAt).toBeLessThan(installAt);
  });

  it("QUICK-START is not a second parser and does not append Case G", () => {
    const qs = readText("QUICK-START.md");
    expect(qs).toContain("deft agents:refresh");
    expect(qs).toContain("current | stale | missing | absent");
    expect(qs).not.toContain("<!-- deft:managed-section v2 -->");
    expect(qs).not.toContain("task framework:doctor");
    expect(qs).not.toContain(".deft/core/run");
    expect(qs).not.toMatch(/and \*\*append\*\* its content/);
    expect(qs).toContain("QUICK-START is not a second parser");
  });
});
