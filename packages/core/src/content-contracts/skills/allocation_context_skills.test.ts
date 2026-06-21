import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_allocation_context_skills.py (#1838 #1530) */

const _BUILD_PATH = "skills/deft-directive-build/SKILL.md";
const _SWARM_PATH = "skills/deft-directive-swarm/SKILL.md";
const _SWARM_STEP0_HEADER = "### Step 0: Populate the allocation-context consent token (#1378)";
const _BUILD_RECOGNITION_TOKENS = [
  "Structured consent-token recognition (#1378)",
  "## Allocation context",
  "templates/agent-prompt-preamble.md",
  "dispatch_kind: swarm-cohort",
  "allocation_plan_id",
  "batching_rationale",
  "cohort_vbriefs",
  "consent token is satisfied mechanically",
];
const _SWARM_POPULATION_TOKENS = [
  "## Allocation context",
  "templates/agent-prompt-preamble.md",
  "swarm cohort OR solo",
  "dispatch_kind",
  "allocation_plan_id",
  "batching_rationale",
  "cohort_vbriefs",
  "operator_approval_evidence",
  "build-skill Step 0 recognizes mechanically (#1378 Story B)",
];
const _STEP1A_HEADER = "### Step 1a: Worker Runtime and GitHub Auth Preflight (#1557)";
const _STEP1A_END = "### Step 1b: Provider-neutral sub-agent routing (#1531)";
const _SWARM_SANDBOX_AUTH_TOKENS = [
  "scripts/platform_capabilities.py",
  "scripts/github_auth_modes.py",
  "sandbox_uid_remap",
  "host-gh",
  "injected-token",
  "missing_injected_token",
  "cloud-headless",
  "Full-access execution",
  "Trusted `gh` command allowlisting",
  "Injected-token handoff",
];

function _read(rel_path: string) {
  return readRepoFile(rel_path);
}

function _build_step0_block(text: string) {
  const start = text.indexOf("## Step 0 -- Implementation Preflight (#810)");
  expect(start).not.toBe(-1);
  const end = text.indexOf("## Platform Detection", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _swarm_phase3_step0_block(text: string) {
  const start = text.indexOf(_SWARM_STEP0_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Step 1: Runtime Capability Detection", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _swarm_phase3_step1a_block(text: string) {
  const start = text.indexOf(_STEP1A_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_STEP1A_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("test_allocation_context_skills", () => {
  it.each([
    "Structured consent-token recognition (#1378)",
    "## Allocation context",
    "templates/agent-prompt-preamble.md",
    "dispatch_kind: swarm-cohort",
    "allocation_plan_id",
    "batching_rationale",
    "cohort_vbriefs",
    "consent token is satisfied mechanically",
  ])("build_step0_recognition_token_present %s", (token) => {
    const block = _build_step0_block(readRepoFile(_BUILD_PATH));
    expect(block).toContain(token);
  });
  it("build_step0_recognition_is_must_bullet", () => {
    const block = _build_step0_block(readRepoFile(_BUILD_PATH));
    let found = false;
    for (const line of block.split("\n")) {
      if (line.includes("Structured consent-token recognition (#1378)")) {
        const stripped = line.trimStart().replace(/^-\s*/, "");
        expect(stripped.startsWith("! ")).toBe(true);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
  it("build_step0_keeps_1371_prose_fallback", () => {
    const block = _build_step0_block(readRepoFile(_BUILD_PATH));
    expect(block).toContain("ABSENT");
    expect(block).toContain("#1371 prose carve-out");
    expect(block).toContain("Swarm-cohort dispatch carve-out");
    expect(block).toContain("(#954)");
  });
  it.each([
    "## Allocation context",
    "templates/agent-prompt-preamble.md",
    "swarm cohort OR solo",
    "dispatch_kind",
    "allocation_plan_id",
    "batching_rationale",
    "cohort_vbriefs",
    "operator_approval_evidence",
    "build-skill Step 0 recognizes mechanically (#1378 Story B)",
  ])("swarm_phase3_population_token_present %s", (token) => {
    const block = _swarm_phase3_step0_block(readRepoFile(_SWARM_PATH));
    expect(block).toContain(token);
  });
  it("swarm_phase3_population_is_must_step", () => {
    const block = _swarm_phase3_step0_block(readRepoFile(_SWARM_PATH));
    expect(block).toContain("! Before dispatching ANY worker prompt");
    expect(block).toContain("MUST populate a `## Allocation context` section");
  });
  it("swarm_phase3_population_has_absent_section_prohibition", () => {
    const block = _swarm_phase3_step0_block(readRepoFile(_SWARM_PATH));
    let found = false;
    for (const line of block.split("\n")) {
      if (
        line.includes("without a populated `## Allocation context` section") &&
        line.includes("#1378")
      ) {
        expect(line).toContain("⊗");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
  it.each([
    "scripts/platform_capabilities.py",
    "scripts/github_auth_modes.py",
    "sandbox_uid_remap",
    "host-gh",
    "injected-token",
    "missing_injected_token",
    "cloud-headless",
    "Full-access execution",
    "Trusted `gh` command allowlisting",
    "Injected-token handoff",
  ])("swarm_phase3_step1a_sandbox_auth_token_present %s", (token) => {
    const block = _swarm_phase3_step1a_block(readRepoFile(_SWARM_PATH));
    expect(block).toContain(token);
  });
  it("swarm_phase3_step1a_is_must_step", () => {
    const block = _swarm_phase3_step1a_block(readRepoFile(_SWARM_PATH));
    expect(block).toContain("! Before dispatching workers that will call `gh`");
  });
});
