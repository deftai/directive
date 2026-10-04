/**
 * Prefer-A #1511: wire swarm:launch judgment-clearance posture + authenticity.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFT_ALLOW_JUDGMENT_GATE_ENFORCE } from "../policy/capacity.js";
import { GATE_ADVISE, GATE_ENFORCE } from "./constants.js";
import {
  evaluateJudgmentClearancePosture,
  filterAuthenticClearances,
  type ResolvedStory,
  storyFileScopePaths,
} from "./launch.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-jcp-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function writeStory(project: string, storyId: string, fileScope: string[]): ResolvedStory {
  const rel = `xbrief/active/${storyId}.xbrief.json`;
  const full = join(project, rel);
  mkdirSync(join(project, "xbrief", "active"), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      plan: {
        id: storyId,
        metadata: { swarm: { file_scope: fileScope } },
      },
    }),
    "utf8",
  );
  return { token: storyId, story_id: storyId, path: full, relpath: rel };
}

describe("filterAuthenticClearances (#1511)", () => {
  it("rejects caller-supplied actor/reviewer-only clearances", () => {
    const { authentic, rejected } = filterAuthenticClearances([
      { gate_id: "secrets-and-credentials", actor: "agent", reviewers: ["bot"] },
      {
        gate_id: "secrets-and-credentials",
        grant_id: "grant-1",
        origin_kind: "operator-cli",
        actor: "scott",
      },
      { gate_id: "x", origin_kind: "self-asserted", grant_id: "g2" },
      { gate_id: "y", origin_kind: "agent-authored" },
    ]);
    expect(rejected).toHaveLength(3);
    expect(authentic).toHaveLength(1);
    expect(authentic[0]?.grant_id).toBe("grant-1");
  });
});

function writeProjectDef(project: string): void {
  mkdirSync(join(project, "xbrief"), { recursive: true });
  writeFileSync(
    join(project, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({ plan: { policy: { swarmSubagentBackend: "grok-build" } } }),
    "utf8",
  );
}

describe("evaluateJudgmentClearancePosture (#1511 P2-a)", () => {
  it("advises and proceeds when block-tier matches without clearance", () => {
    const project = tempRoot();
    writeProjectDef(project);
    const story = writeStory(project, "agents-touch", ["AGENTS.md"]);
    const result = evaluateJudgmentClearancePosture({
      projectRoot: project,
      resolved: [story],
      gatePosture: GATE_ADVISE,
      gateClearances: [],
    });
    expect(result.ok).toBe(true);
    expect(result.posture).toBe(GATE_ADVISE);
    expect(result.advisory).toMatch(/agents-md-and-skills/);
  });

  it("refuses under enforce when uncleared block-tier gate matches", () => {
    const project = tempRoot();
    writeProjectDef(project);
    const story = writeStory(project, "secret-touch", ["secrets/prod.env"]);
    const result = evaluateJudgmentClearancePosture({
      projectRoot: project,
      resolved: [story],
      gatePosture: GATE_ENFORCE,
      gateClearances: [
        {
          gate_id: "secrets-and-credentials",
          actor: "worker",
          reviewers: ["self"],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/--enforce-gates refused/);
    expect(result.stderr).toMatch(/secrets-and-credentials/);
    expect(result.advisory).toMatch(/rejected 1 caller-supplied/);
  });

  it("emergency bypass DEFT_ALLOW_JUDGMENT_GATE_ENFORCE downgrades enforce to advise", () => {
    const project = tempRoot();
    writeProjectDef(project);
    const story = writeStory(project, "infra-touch", ["infra/main.tf"]);
    const result = evaluateJudgmentClearancePosture({
      projectRoot: project,
      resolved: [story],
      gatePosture: GATE_ENFORCE,
      gateClearances: [],
      environ: { [DEFT_ALLOW_JUDGMENT_GATE_ENFORCE]: "1" },
    });
    expect(result.ok).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(result.posture).toBe(GATE_ADVISE);
    expect(result.advisory).toMatch(DEFT_ALLOW_JUDGMENT_GATE_ENFORCE);
  });

  it("storyFileScopePaths reads swarm file_scope", () => {
    const project = tempRoot();
    const story = writeStory(project, "scoped", ["AGENTS.md", "src/a.ts"]);
    expect(storyFileScopePaths(story)).toEqual(["AGENTS.md", "src/a.ts"]);
  });
});
