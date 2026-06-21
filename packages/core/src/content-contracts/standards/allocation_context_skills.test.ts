import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const BUILD = "skills/deft-directive-build/SKILL.md";
const SWARM = "skills/deft-directive-swarm/SKILL.md";

function buildStep0(text: string): string {
  const start = text.indexOf("## Step 0 -- Implementation Preflight (#810)");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("## Platform Detection", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function swarmStep0(text: string): string {
  const header = "### Step 0: Populate the allocation-context consent token (#1378)";
  const start = text.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("### Step 1: Runtime Capability Detection", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function swarmStep1a(text: string): string {
  const start = text.indexOf("### Step 1a: Worker Runtime and GitHub Auth Preflight (#1557)");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("### Step 1b: Provider-neutral sub-agent routing (#1531)", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("test_allocation_context_skills.py", () => {
  for (const token of [
    "Structured consent-token recognition (#1378)",
    "## Allocation context",
    "templates/agent-prompt-preamble.md",
    "dispatch_kind: swarm-cohort",
    "allocation_plan_id",
    "batching_rationale",
    "cohort_vbriefs",
    "consent token is satisfied mechanically",
  ]) {
    it(`test_build_step0_recognition_token_present ${token}`, () => {
      expect(buildStep0(readText(BUILD))).toContain(token);
    });
  }
  it("test_build_step0_recognition_is_must_bullet", () => {
    let found = false;
    for (const line of buildStep0(readText(BUILD)).split("\n")) {
      if (line.includes("Structured consent-token recognition (#1378)")) {
        expect(line.replace(/^[\s-]+/, "").startsWith("! ")).toBe(true);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
  it("test_build_step0_keeps_1371_prose_fallback", () => {
    const block = buildStep0(readText(BUILD));
    expect(block).toContain("ABSENT");
    expect(block).toContain("#1371 prose carve-out");
    expect(block).toContain("Swarm-cohort dispatch carve-out");
    expect(block).toContain("(#954)");
  });
  for (const token of [
    "## Allocation context",
    "templates/agent-prompt-preamble.md",
    "swarm cohort OR solo",
    "dispatch_kind",
    "allocation_plan_id",
    "batching_rationale",
    "cohort_vbriefs",
    "operator_approval_evidence",
    "build-skill Step 0 recognizes mechanically (#1378 Story B)",
  ]) {
    it(`test_swarm_phase3_population_token_present ${token}`, () => {
      expect(swarmStep0(readText(SWARM))).toContain(token);
    });
  }
  it("test_swarm_phase3_population_is_must_step", () => {
    const block = swarmStep0(readText(SWARM));
    expect(block).toContain("! Before dispatching ANY worker prompt");
    expect(block).toContain("MUST populate a `## Allocation context` section");
  });
  it("test_swarm_phase3_population_has_absent_section_prohibition", () => {
    let found = false;
    for (const line of swarmStep0(readText(SWARM)).split("\n")) {
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
  for (const token of [
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
  ]) {
    it(`test_swarm_phase3_step1a_sandbox_auth_token_present ${token}`, () => {
      expect(swarmStep1a(readText(SWARM))).toContain(token);
    });
  }
  it("test_swarm_phase3_step1a_is_must_step", () => {
    expect(swarmStep1a(readText(SWARM))).toContain(
      "! Before dispatching workers that will call `gh`",
    );
  });
});
