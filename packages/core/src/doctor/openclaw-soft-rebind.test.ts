import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatOpenClawSoftRebindSkillMarkdown,
  OPENCLAW_SOFT_REBIND_SKILL_ID,
} from "../session/compact-ritual.js";
import { OPENCLAW_SOFT_REBIND_CHECK, runOpenClawSoftRebindCheck } from "./openclaw-soft-rebind.js";
import type { Finding } from "./types.js";

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sink() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(`info:${m}`),
    success: (m: string) => lines.push(`success:${m}`),
    warn: (m: string) => lines.push(`warn:${m}`),
    error: (m: string) => lines.push(`error:${m}`),
    header: () => undefined,
    blank: () => undefined,
    raw: () => undefined,
    finalSuccess: () => undefined,
    finalError: () => undefined,
    finalWarn: () => undefined,
  };
}

describe("runOpenClawSoftRebindCheck (#3171)", () => {
  it("skips when OpenClaw is not detected", () => {
    const findings: Finding[] = [];
    const s = sink();
    const home = mkdtempSync(join(tmpdir(), "oc-soft-doc-skip-"));
    runOpenClawSoftRebindCheck(s, (f) => findings.push(f), {
      projectRoot: home,
      fixMode: false,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: {},
        openclawHomeDir: () => home,
        isDir: () => false,
      },
    });
    expect(findings[0]?.check).toBe(OPENCLAW_SOFT_REBIND_CHECK);
    expect(findings[0]?.status).toBe("skip");
    rmSync(home, { recursive: true, force: true });
  });

  it("warns when skill is missing and deposits under fixMode", () => {
    const state = mkdtempSync(join(tmpdir(), "oc-soft-doc-fix-"));
    const skillsDir = join(state, "workspace", "skills");
    mkdirSync(skillsDir, { recursive: true });

    const findings: Finding[] = [];
    const s = sink();
    runOpenClawSoftRebindCheck(s, (f) => findings.push(f), {
      projectRoot: state,
      fixMode: true,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => state,
        isDir,
      },
    });

    expect(findings.some((f) => f.status === "fixed" || f.status === "present")).toBe(true);
    const skillPath = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID, "SKILL.md");
    const body = readFileSync(skillPath, "utf8");
    expect(body).toBe(formatOpenClawSoftRebindSkillMarkdown());

    rmSync(state, { recursive: true, force: true });
  });

  it("reports present when managed skill is already current", () => {
    const state = mkdtempSync(join(tmpdir(), "oc-soft-doc-present-"));
    const skillsDir = join(state, "workspace", "skills");
    const skillDir = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), formatOpenClawSoftRebindSkillMarkdown(), "utf8");

    const findings: Finding[] = [];
    runOpenClawSoftRebindCheck(sink(), (f) => findings.push(f), {
      projectRoot: state,
      fixMode: false,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => state,
        isDir,
      },
    });

    expect(findings[0]?.status).toBe("present");
    rmSync(state, { recursive: true, force: true });
  });

  it("does not pass health on unmanaged custom content at the required slug (Greptile P1)", () => {
    const state = mkdtempSync(join(tmpdir(), "oc-soft-doc-custom-"));
    const skillsDir = join(state, "workspace", "skills");
    const skillDir = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: custom\n---\n# Unrelated consumer skill\n",
      "utf8",
    );

    const findings: Finding[] = [];
    runOpenClawSoftRebindCheck(sink(), (f) => findings.push(f), {
      projectRoot: state,
      fixMode: false,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => state,
        isDir,
      },
    });

    expect(findings[0]?.status).toBe("incomplete");
    expect(String(findings[0]?.message ?? "")).toMatch(/stale=/i);

    const fixedFindings: Finding[] = [];
    runOpenClawSoftRebindCheck(sink(), (f) => fixedFindings.push(f), {
      projectRoot: state,
      fixMode: true,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => state,
        isDir,
      },
    });
    expect(fixedFindings.some((f) => f.status === "fixed" || f.status === "present")).toBe(true);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(
      formatOpenClawSoftRebindSkillMarkdown(),
    );

    rmSync(state, { recursive: true, force: true });
  });
});
