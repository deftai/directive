import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateOpenClawSkillArtifacts } from "../slash/openclaw-adapter.js";
import {
  OPENCLAW_L2_ADAPTER_CHECK,
  OPENCLAW_MAIN_WORKSPACE_ONLY_NOTE,
  runOpenClawL2AdapterCheck,
} from "./openclaw-l2-adapter.js";
import { createPlainSink } from "./output.js";
import type { Finding } from "./types.js";

const tempRoots: string[] = [];

function makeTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("doctor OpenClaw L2 adapter check (#3064)", () => {
  it("skips when OpenClaw not detected", () => {
    const project = makeTemp("oc-l2-doc-skip-");
    const home = makeTemp("oc-l2-doc-home-");
    const findings: Finding[] = [];
    const sink = createPlainSink({ write: () => undefined, jsonMode: true });
    runOpenClawL2AdapterCheck(sink, (f) => findings.push(f), {
      projectRoot: project,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: {},
        openclawHomeDir: () => home,
      },
    });
    expect(findings[0]?.check).toBe(OPENCLAW_L2_ADAPTER_CHECK);
    expect(findings[0]?.status).toBe("skip");
  });

  it("warns when missing, names repair, and writes nothing (AC12.1, #6622)", () => {
    const project = makeTemp("oc-l2-doc-fix-");
    const home = makeTemp("oc-l2-doc-home2-");
    const state = join(home, ".openclaw");
    const skills = join(state, "workspace", "skills");
    mkdirSync(skills, { recursive: true });

    const findings: Finding[] = [];
    const sink = createPlainSink({ write: () => undefined, jsonMode: true });
    runOpenClawL2AdapterCheck(sink, (f) => findings.push(f), {
      projectRoot: project,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => home,
      },
    });
    const missing = findings.find((f) => f.status === "missing");
    expect(missing).toBeDefined();
    expect(missing?.suggestion).toBe("directive install --repair");
    expect(readdirSync(skills)).toEqual([]);
  });

  it("reports a policy opt-out and names repair to remove managed skills", () => {
    const project = makeTemp("oc-l2-doc-opt-");
    mkdirSync(join(project, "xbrief"), { recursive: true });
    writeFileSync(
      join(project, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { openClawProductCommands: false } } }),
      "utf8",
    );
    const home = makeTemp("oc-l2-doc-home3-");
    const state = join(home, ".openclaw");
    mkdirSync(join(state, "workspace", "skills"), { recursive: true });
    const sink = createPlainSink({ write: () => undefined, jsonMode: true });
    const findings: Finding[] = [];
    runOpenClawL2AdapterCheck(sink, (f) => findings.push(f), {
      projectRoot: project,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW: "1", OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => home,
      },
    });
    expect(findings[0]?.status).toBe("opted-out");
    expect(String(findings[0]?.message)).toContain("directive install --repair");
  });

  it("counts skills that setup rewrote to the runtime path as present", () => {
    const project = makeTemp("oc-l2-doc-rewritten-");
    const home = makeTemp("oc-l2-doc-home4-");
    const state = join(home, ".openclaw");
    const skills = join(state, "workspace", "skills");
    for (const art of generateOpenClawSkillArtifacts()) {
      mkdirSync(join(skills, art.slug), { recursive: true });
      const rewritten = art.skillMarkdown
        .split(".deft/core/")
        .join("node_modules/@deftai/directive-runtime/");
      writeFileSync(
        join(skills, art.slug, "SKILL.md"),
        rewritten.endsWith("\n") ? rewritten : `${rewritten}\n`,
      );
    }
    const findings: Finding[] = [];
    runOpenClawL2AdapterCheck(
      createPlainSink({ write: () => undefined, jsonMode: true }),
      (f) => findings.push(f),
      {
        projectRoot: project,
        jsonMode: true,
        allAgents: false,
        seams: { openclawEnv: { OPENCLAW_STATE_DIR: state }, openclawHomeDir: () => home },
      },
    );
    expect(findings[0]?.status).toBe("present");
  });

  it("says repair covers only the main workspace when all seats were checked", () => {
    const project = makeTemp("oc-l2-doc-seats-");
    const home = makeTemp("oc-l2-doc-home5-");
    const state = join(home, ".openclaw");
    mkdirSync(join(state, "workspace", "skills"), { recursive: true });
    const findings: Finding[] = [];
    runOpenClawL2AdapterCheck(
      createPlainSink({ write: () => undefined, jsonMode: true }),
      (f) => findings.push(f),
      {
        projectRoot: project,
        jsonMode: true,
        allAgents: true,
        seams: { openclawEnv: { OPENCLAW_STATE_DIR: state }, openclawHomeDir: () => home },
      },
    );
    expect(String(findings[0]?.message)).toContain(OPENCLAW_MAIN_WORKSPACE_ONLY_NOTE);
  });
});
