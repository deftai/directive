/**
 * Branch coverage for OpenClaw soft re-bind doctor check (#3185 / #3171).
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatOpenClawSoftRebindSkillMarkdown,
  OPENCLAW_SOFT_REBIND_SKILL_ID,
} from "../session/compact-ritual.js";
import { runOpenClawSoftRebindCheck } from "./openclaw-soft-rebind.js";
import type { Finding } from "./types.js";

const roots: string[] = [];

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

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("runOpenClawSoftRebindCheck branches (#3185)", () => {
  it("reports present with allAgents scope label", () => {
    const state = mkdtempSync(join(tmpdir(), "oc-soft-all-"));
    roots.push(state);
    const skillsDir = join(state, "workspace", "skills");
    const skillDir = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), formatOpenClawSoftRebindSkillMarkdown(), "utf8");

    const findings: Finding[] = [];
    const s = sink();
    runOpenClawSoftRebindCheck(s, (f) => findings.push(f), {
      projectRoot: state,
      fixMode: false,
      jsonMode: true,
      allAgents: true,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => state,
        isDir,
      },
    });
    expect(findings[0]?.status).toBe("present");
    expect(s.lines.some((l) => l.includes("main + workspace-* seats"))).toBe(true);
  });

  it("treats unreadable SKILL.md as missing", () => {
    const state = mkdtempSync(join(tmpdir(), "oc-soft-unread-"));
    roots.push(state);
    const skillsDir = join(state, "workspace", "skills");
    // Create a directory where SKILL.md is expected but is a directory (readFile fails)
    const skillDir = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID);
    mkdirSync(join(skillDir, "SKILL.md"), { recursive: true });

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
    expect(String(findings[0]?.message ?? "")).toMatch(/missing=/i);
  });

  it("warns incomplete without fixMode when skill is missing", () => {
    const state = mkdtempSync(join(tmpdir(), "oc-soft-miss-"));
    roots.push(state);
    mkdirSync(join(state, "workspace", "skills"), { recursive: true });

    const findings: Finding[] = [];
    const s = sink();
    runOpenClawSoftRebindCheck(s, (f) => findings.push(f), {
      projectRoot: state,
      fixMode: false,
      jsonMode: false,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => state,
        isDir,
      },
    });
    expect(findings[0]?.status).toBe("incomplete");
    expect(s.lines.some((l) => l.startsWith("warn:"))).toBe(true);
  });
});
