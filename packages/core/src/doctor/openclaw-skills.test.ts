import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessOpenClawPins,
  detectOpenClaw,
  installOpenClawPin,
  listInScopeSkillsDirs,
  OPENCLAW_ALWAYS_PIN_SKILLS,
  OPENCLAW_SKILL_PINS_CHECK,
  resolveMainSkillsDir,
  resolveOpenClawStateDir,
  resolvePinSourceDir,
  runOpenClawSkillPinsCheck,
} from "./openclaw-skills.js";
import { createPlainSink } from "./output.js";
import type { Finding } from "./types.js";

const tempRoots: string[] = [];

function makeTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(dir: string, id: string, body = "# skill\n"): string {
  const skillDir = join(dir, id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body, "utf8");
  return skillDir;
}

function makeContentPackage(root: string): string {
  const contentBase = join(root, "content-pkg");
  for (const id of OPENCLAW_ALWAYS_PIN_SKILLS) {
    writeSkill(join(contentBase, "skills"), id, `# ${id}\n`);
  }
  return contentBase;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("detectOpenClaw (#3001)", () => {
  it("detects env OPENCLAW / DEFT_PROBE_OPENCLAW / DEFT_AGENT_RUNTIME", () => {
    const home = makeTemp("oc-home-");
    expect(detectOpenClaw({ OPENCLAW: "1" }, { homeDir: home }).detected).toBe(true);
    expect(detectOpenClaw({ DEFT_PROBE_OPENCLAW: "true" }, { homeDir: home }).detected).toBe(true);
    expect(detectOpenClaw({ DEFT_AGENT_RUNTIME: "openclaw" }, { homeDir: home }).detected).toBe(
      true,
    );
    expect(detectOpenClaw({ DEFT_AGENT_RUNTIME: "cursor" }, { homeDir: home }).detected).toBe(
      false,
    );
    expect(detectOpenClaw({ OPENCLAW: "0" }, { homeDir: home }).detected).toBe(false);
  });

  it("detects ~/.openclaw directory presence", () => {
    const home = makeTemp("oc-home-dir-");
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const result = detectOpenClaw({}, { homeDir: home });
    expect(result.detected).toBe(true);
    expect(result.stateDir).toBe(join(home, ".openclaw"));
    expect(result.mainSkillsDir).toBe(join(home, ".openclaw", "workspace", "skills"));
  });

  it("honours OPENCLAW_STATE_DIR", () => {
    const root = makeTemp("oc-state-");
    const state = join(root, "custom-state");
    mkdirSync(state, { recursive: true });
    const result = detectOpenClaw({ OPENCLAW_STATE_DIR: state }, { homeDir: root });
    expect(result.detected).toBe(true);
    expect(result.stateDir).toBe(state);
    expect(resolveOpenClawStateDir({ OPENCLAW_STATE_DIR: state }, root)).toBe(state);
  });
});

describe("listInScopeSkillsDirs (#3001)", () => {
  it("defaults to main workspace skills only", () => {
    const state = makeTemp("oc-scope-");
    mkdirSync(join(state, "workspace-scotty"), { recursive: true });
    const dirs = listInScopeSkillsDirs(state, false);
    expect(dirs).toEqual([resolveMainSkillsDir(state)]);
  });

  it("includes workspace-* seats when allAgents is true", () => {
    const state = makeTemp("oc-scope-all-");
    mkdirSync(join(state, "workspace-scotty"), { recursive: true });
    mkdirSync(join(state, "workspace-pike"), { recursive: true });
    mkdirSync(join(state, "not-a-workspace"), { recursive: true });
    const dirs = listInScopeSkillsDirs(state, true);
    expect(dirs).toContain(resolveMainSkillsDir(state));
    expect(dirs).toContain(join(state, "workspace-scotty", "skills"));
    expect(dirs).toContain(join(state, "workspace-pike", "skills"));
    expect(dirs).not.toContain(join(state, "not-a-workspace", "skills"));
  });
});

describe("assessOpenClawPins (#3001)", () => {
  it("reports all missing when skills dir is empty", () => {
    const skills = join(makeTemp("oc-assess-"), "skills");
    mkdirSync(skills, { recursive: true });
    const assessment = assessOpenClawPins(skills);
    expect(assessment.missing).toEqual([...OPENCLAW_ALWAYS_PIN_SKILLS]);
    expect(assessment.present).toEqual([]);
  });

  it("reports hit when all pins have SKILL.md", () => {
    const skills = join(makeTemp("oc-hit-"), "skills");
    for (const id of OPENCLAW_ALWAYS_PIN_SKILLS) writeSkill(skills, id);
    const assessment = assessOpenClawPins(skills);
    expect(assessment.present).toEqual([...OPENCLAW_ALWAYS_PIN_SKILLS]);
    expect(assessment.missing).toEqual([]);
  });

  it("classifies empty dir as divergent", () => {
    const skills = join(makeTemp("oc-div-"), "skills");
    mkdirSync(join(skills, "deft-directive-build"), { recursive: true });
    const assessment = assessOpenClawPins(skills);
    expect(assessment.divergent).toContain("deft-directive-build");
  });
});

describe("installOpenClawPin (#3001)", () => {
  it("symlinks or copies a missing pin", () => {
    const root = makeTemp("oc-install-");
    const content = makeContentPackage(root);
    const skills = join(root, "skills");
    const source = resolvePinSourceDir(content, "deft-directive-build");
    const result = installOpenClawPin("deft-directive-build", source, skills);
    expect(["symlink", "copy"]).toContain(result.method);
    expect(readFileSync(join(skills, "deft-directive-build", "SKILL.md"), "utf8")).toContain(
      "deft-directive-build",
    );
  });

  it("does not overwrite divergent target without force", () => {
    const root = makeTemp("oc-no-ow-");
    const content = makeContentPackage(root);
    const skills = join(root, "skills");
    mkdirSync(join(skills, "deft-directive-build"), { recursive: true });
    writeFileSync(join(skills, "deft-directive-build", "OTHER.md"), "user", "utf8");
    const source = resolvePinSourceDir(content, "deft-directive-build");
    const result = installOpenClawPin("deft-directive-build", source, skills, { force: false });
    expect(result.method).toBe("skipped");
    expect(readFileSync(join(skills, "deft-directive-build", "OTHER.md"), "utf8")).toBe("user");
  });

  it("replaces divergent target with force", () => {
    const root = makeTemp("oc-force-");
    const content = makeContentPackage(root);
    const skills = join(root, "skills");
    mkdirSync(join(skills, "deft-directive-build"), { recursive: true });
    writeFileSync(join(skills, "deft-directive-build", "OTHER.md"), "user", "utf8");
    const source = resolvePinSourceDir(content, "deft-directive-build");
    const result = installOpenClawPin("deft-directive-build", source, skills, { force: true });
    expect(["symlink", "copy"]).toContain(result.method);
    expect(readFileSync(join(skills, "deft-directive-build", "SKILL.md"), "utf8")).toContain(
      "deft-directive-build",
    );
  });

  it("leaves other user skills in place", () => {
    const root = makeTemp("oc-user-");
    const content = makeContentPackage(root);
    const skills = join(root, "skills");
    writeSkill(skills, "vbrief", "# user skill\n");
    const source = resolvePinSourceDir(content, "deft-directive-pre-pr");
    installOpenClawPin("deft-directive-pre-pr", source, skills);
    expect(readFileSync(join(skills, "vbrief", "SKILL.md"), "utf8")).toContain("user skill");
  });
});

describe("runOpenClawSkillPinsCheck (#3001)", () => {
  it("skips when OpenClaw is not detected", () => {
    const home = makeTemp("oc-skip-");
    const findings: Finding[] = [];
    const lines: string[] = [];
    runOpenClawSkillPinsCheck(
      createPlainSink({ write: (t) => lines.push(t) }),
      (f) => findings.push(f),
      {
        frameworkRoot: home,
        fixMode: false,
        jsonMode: false,
        force: false,
        allAgents: false,
        seams: {
          env: {},
          homeDir: () => home,
          contentRootFor: () => join(home, "content"),
        },
      },
    );
    expect(findings[0]).toEqual(
      expect.objectContaining({
        check: OPENCLAW_SKILL_PINS_CHECK,
        status: "skip",
        reason: "openclaw-not-detected",
      }),
    );
  });

  it("detect miss: warns with remediation when pins missing", () => {
    const home = makeTemp("oc-miss-");
    mkdirSync(join(home, ".openclaw", "workspace", "skills"), { recursive: true });
    const content = makeContentPackage(home);
    const findings: Finding[] = [];
    const lines: string[] = [];
    runOpenClawSkillPinsCheck(
      createPlainSink({ write: (t) => lines.push(t) }),
      (f) => findings.push(f),
      {
        frameworkRoot: home,
        fixMode: false,
        jsonMode: false,
        force: false,
        allAgents: false,
        seams: {
          env: { DEFT_PROBE_OPENCLAW: "1" },
          homeDir: () => home,
          contentRootFor: () => content,
        },
      },
    );
    const finding = findings.find((f) => f.check === OPENCLAW_SKILL_PINS_CHECK);
    expect(finding?.severity).toBe("warning");
    expect(finding?.status).toBe("missing");
    expect(String(finding?.message)).toContain("deft doctor --fix");
    expect(String(finding?.message)).toContain("openclaw-agent-host");
    expect(finding?.missing).toEqual(expect.arrayContaining([...OPENCLAW_ALWAYS_PIN_SKILLS]));
  });

  it("detect hit: clean when all pins present", () => {
    const home = makeTemp("oc-hit-run-");
    const skills = join(home, ".openclaw", "workspace", "skills");
    for (const id of OPENCLAW_ALWAYS_PIN_SKILLS) writeSkill(skills, id);
    const content = makeContentPackage(home);
    const findings: Finding[] = [];
    runOpenClawSkillPinsCheck(
      createPlainSink({ write: () => undefined }),
      (f) => findings.push(f),
      {
        frameworkRoot: home,
        fixMode: false,
        jsonMode: true,
        force: false,
        allAgents: false,
        seams: {
          env: { OPENCLAW: "1" },
          homeDir: () => home,
          contentRootFor: () => content,
        },
      },
    );
    expect(findings[0]).toEqual(
      expect.objectContaining({
        check: OPENCLAW_SKILL_PINS_CHECK,
        status: "present",
        severity: "skip",
      }),
    );
  });

  it("fixMode wires missing pins so re-check is clean", () => {
    const home = makeTemp("oc-fix-");
    const skills = join(home, ".openclaw", "workspace", "skills");
    mkdirSync(skills, { recursive: true });
    writeSkill(skills, "vbrief", "# keep me\n");
    const content = makeContentPackage(home);
    const findings: Finding[] = [];
    runOpenClawSkillPinsCheck(
      createPlainSink({ write: () => undefined }),
      (f) => findings.push(f),
      {
        frameworkRoot: home,
        fixMode: true,
        jsonMode: true,
        force: false,
        allAgents: false,
        seams: {
          env: { DEFT_PROBE_OPENCLAW: "1" },
          homeDir: () => home,
          contentRootFor: () => content,
          isTty: () => false,
        },
      },
    );
    expect(findings[0]?.status).toBe("fixed");
    for (const id of OPENCLAW_ALWAYS_PIN_SKILLS) {
      expect(readFileSync(join(skills, id, "SKILL.md"), "utf8")).toContain(id);
    }
    expect(readFileSync(join(skills, "vbrief", "SKILL.md"), "utf8")).toContain("keep me");

    // Re-run detect → present
    const findings2: Finding[] = [];
    runOpenClawSkillPinsCheck(
      createPlainSink({ write: () => undefined }),
      (f) => findings2.push(f),
      {
        frameworkRoot: home,
        fixMode: false,
        jsonMode: true,
        force: false,
        allAgents: false,
        seams: {
          env: { DEFT_PROBE_OPENCLAW: "1" },
          homeDir: () => home,
          contentRootFor: () => content,
        },
      },
    );
    expect(findings2[0]?.status).toBe("present");
  });

  it("allAgents flag assesses crew workspace skills", () => {
    const home = makeTemp("oc-all-");
    mkdirSync(join(home, ".openclaw", "workspace", "skills"), { recursive: true });
    mkdirSync(join(home, ".openclaw", "workspace-scotty", "skills"), { recursive: true });
    const content = makeContentPackage(home);
    // Only main is fully pinned
    for (const id of OPENCLAW_ALWAYS_PIN_SKILLS) {
      writeSkill(join(home, ".openclaw", "workspace", "skills"), id);
    }
    const findings: Finding[] = [];
    runOpenClawSkillPinsCheck(
      createPlainSink({ write: () => undefined }),
      (f) => findings.push(f),
      {
        frameworkRoot: home,
        fixMode: false,
        jsonMode: true,
        force: false,
        allAgents: true,
        seams: {
          env: { OPENCLAW: "1" },
          homeDir: () => home,
          contentRootFor: () => content,
        },
      },
    );
    expect(findings[0]?.status).toBe("missing");
    expect(String(findings[0]?.message)).toContain("workspace-scotty");
  });
});

describe("symlink pin body is accepted as present", () => {
  it("treats symlink-to-content as present", () => {
    const root = makeTemp("oc-link-");
    const content = makeContentPackage(root);
    const skills = join(root, "skills");
    mkdirSync(skills, { recursive: true });
    const source = resolvePinSourceDir(content, "deft-directive-swarm");
    try {
      symlinkSync(source, join(skills, "deft-directive-swarm"), "dir");
    } catch {
      // Windows without symlink privilege: skip assertion path
      symlinkSync(source, join(skills, "deft-directive-swarm"), "junction");
    }
    const assessment = assessOpenClawPins(skills);
    expect(assessment.present).toContain("deft-directive-swarm");
  });
});
