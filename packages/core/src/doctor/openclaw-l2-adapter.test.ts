import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_L2_ADAPTER_CHECK, runOpenClawL2AdapterCheck } from "./openclaw-l2-adapter.js";
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
      fixMode: false,
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

  it("warns when missing and deposits under --fix", () => {
    const project = makeTemp("oc-l2-doc-fix-");
    const home = makeTemp("oc-l2-doc-home2-");
    const state = join(home, ".openclaw");
    mkdirSync(join(state, "workspace", "skills"), { recursive: true });

    const findings: Finding[] = [];
    const sink = createPlainSink({ write: () => undefined, jsonMode: true });
    runOpenClawL2AdapterCheck(sink, (f) => findings.push(f), {
      projectRoot: project,
      fixMode: false,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => home,
      },
    });
    expect(findings.some((f) => f.status === "missing")).toBe(true);

    const findings2: Finding[] = [];
    runOpenClawL2AdapterCheck(sink, (f) => findings2.push(f), {
      projectRoot: project,
      fixMode: true,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW_STATE_DIR: state },
        openclawHomeDir: () => home,
      },
    });
    expect(findings2.some((f) => f.status === "fixed" || f.status === "present")).toBe(true);
  });

  it("honours policy opt-out", () => {
    const project = makeTemp("oc-l2-doc-opt-");
    mkdirSync(join(project, "xbrief"), { recursive: true });
    writeFileSync(
      join(project, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { policy: { openClawProductCommands: false } } }),
      "utf8",
    );
    const home = makeTemp("oc-l2-doc-home3-");
    mkdirSync(join(home, ".openclaw", "workspace", "skills"), { recursive: true });
    const findings: Finding[] = [];
    const sink = createPlainSink({ write: () => undefined, jsonMode: true });
    runOpenClawL2AdapterCheck(sink, (f) => findings.push(f), {
      projectRoot: project,
      fixMode: true,
      jsonMode: true,
      allAgents: false,
      seams: {
        openclawEnv: { OPENCLAW: "1", OPENCLAW_STATE_DIR: join(home, ".openclaw") },
        openclawHomeDir: () => home,
      },
    });
    expect(findings[0]?.status).toBe("opted-out");
  });
});
