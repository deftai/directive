import { describe, expect, it } from "vitest";
import { readAgentsMd, readRepoFile } from "./helpers.js";

/** Port of tests/content/test_swarm_headless_launch.py (#1838 #1530) */

const SWARM_PATH = "skills/deft-directive-swarm/SKILL.md";
const _AGENTS_PATH = "AGENTS.md";

const PHASE0_HEADLESS_HEADER = "### Headless cohort fast-path: low-ceremony launch (C1 / #1387)";
const PHASE2_STEP1_HEADER = "### Step 1: Create Worktrees";
const PHASE3_STEP05_HEADER =
  "### Step 0.5: Consume the launch-manifest before dispatch (headless path, C2 / #1387)";
const AGENTS_HEADER = "## Headless swarm launch gate-stack (#1387)";

function read(relPath: string): string {
  return readRepoFile(relPath);
}

function boundedBlock(text: string, startMarker: string, endMarker: string, path: string): string {
  const start = text.indexOf(startMarker);
  expect(start).not.toBe(-1);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  void path;
  return text.slice(start, end);
}

function phase0HeadlessBlock(text: string): string {
  return boundedBlock(
    text,
    PHASE0_HEADLESS_HEADER,
    "### Step 0: Queue-driven cohort selection (#1142 / N2)",
    SWARM_PATH,
  );
}

function phase2Step1Block(text: string): string {
  return boundedBlock(text, PHASE2_STEP1_HEADER, "### Step 2: Generate Prompt Files", SWARM_PATH);
}

function phase3Step05Block(text: string): string {
  return boundedBlock(
    text,
    PHASE3_STEP05_HEADER,
    "### Step 1: Runtime Capability Detection",
    SWARM_PATH,
  );
}

function agentsBlock(text: string): string {
  const start = text.indexOf(AGENTS_HEADER);
  expect(start).not.toBe(-1);
  const rest = text.slice(start + AGENTS_HEADER.length);
  const match = /\n## /.exec(rest);
  const end = match ? start + AGENTS_HEADER.length + (match.index ?? 0) : text.length;
  return text.slice(start, end);
}

const PHASE0_TOKENS = [
  "task swarm:launch",
  "--stories",
  "--group",
  "--worktree-map",
  "--base-branch",
  "--autonomous",
  "C1",
  "## Allocation context",
  "#1378",
  "#1387",
  "dispatch_kind: swarm-cohort",
  "promote-fill loop",
  "pre-approved cohort",
  "SINGLE consent",
];

const PHASE2_TOKENS = [
  "pre-created worktree map",
  "C3",
  "--worktree-map",
  "resolve_worktree_map",
  "scripts/swarm_worktrees.py",
  "story_id",
  "worktree_path",
  "base_branch",
  "same-path collisions",
  "git worktree add",
];

const PHASE3_TOKENS = [
  "launch-manifest",
  "C2",
  "task swarm:launch",
  "story_id",
  "vbrief_path",
  "worktree_path",
  "allocation_context",
  "PREP ONLY",
  "start_agent",
  "spawn_subagent",
  "does NOT spawn agents",
];

const AGENTS_TOKENS = [
  "task swarm:launch",
  "--stories",
  "--worktree-map",
  "pre-created worktree map",
  "launch-manifest",
  "resolve_worktree_map",
  "scripts/swarm_worktrees.py",
  "C1",
  "C2",
  "C3",
  "#1378",
  "#1387",
  "dispatch_kind: swarm-cohort",
  "agent-driven",
  "does NOT spawn agents",
];

const CROSS_SURFACE_TOKENS = ["swarm:launch", "pre-created worktree map", "launch-manifest"];

describe("test_swarm_headless_launch", () => {
  it.each(PHASE0_TOKENS)("swarm_phase0_headless_token_present %s", (token) => {
    const block = phase0HeadlessBlock(read(SWARM_PATH));
    expect(block).toContain(token);
  });

  it("swarm_phase0_headless_reprompt_prohibition", () => {
    const block = phase0HeadlessBlock(read(SWARM_PATH));
    let found = false;
    for (const line of block.split("\n")) {
      if (line.includes("Re-prompt the operator for per-phase batching approval")) {
        expect(line).toContain("\u2297");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it.each(PHASE2_TOKENS)("swarm_phase2_worktree_map_token_present %s", (token) => {
    const block = phase2Step1Block(read(SWARM_PATH));
    expect(block).toContain(token);
  });

  it("swarm_phase2_has_both_modes", () => {
    const block = phase2Step1Block(read(SWARM_PATH));
    expect(block).toContain("Mode A");
    expect(block).toContain("Mode B");
  });

  it.each(PHASE3_TOKENS)("swarm_phase3_manifest_token_present %s", (token) => {
    const block = phase3Step05Block(read(SWARM_PATH));
    expect(block).toContain(token);
  });

  it("swarm_phase3_manifest_is_prep_not_spawn", () => {
    const block = phase3Step05Block(read(SWARM_PATH));
    let found = false;
    for (const line of block.split("\n")) {
      if (line.includes("Treat the C2 launch-manifest as the spawn itself")) {
        expect(line).toContain("\u2297");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it.each(AGENTS_TOKENS)("agents_headless_mirror_token_present %s", (token) => {
    const block = agentsBlock(readAgentsMd());
    expect(block).toContain(token);
  });

  it("agents_headless_mirror_reprompt_prohibition", () => {
    const block = agentsBlock(readAgentsMd());
    let found = false;
    for (const line of block.split("\n")) {
      if (line.includes("Re-prompt the operator for per-phase batching approval")) {
        expect(line).toContain("\u2297");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it.each(CROSS_SURFACE_TOKENS)("headless_contract_present_in_both_surfaces %s", (token) => {
    const swarm = read(SWARM_PATH);
    const agents = readAgentsMd();
    expect(swarm).toContain(token);
    expect(agents).toContain(token);
  });
});
