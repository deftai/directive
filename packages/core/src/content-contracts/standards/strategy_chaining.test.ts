import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const VALID_TYPES = new Set(["preparatory", "spec-generating"]);

function parseReadmeTable(): Array<Record<string, string>> {
  const text = readText("strategies/README.md");
  const rows: Array<Record<string, string>> = [];
  let inTable = false;
  let headers: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    const cells = stripped
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (!inTable) {
      headers = cells.map((h) => h.toLowerCase());
      inTable = true;
      continue;
    }
    if (cells.every((c) => [...c].every((ch) => "- :".includes(ch)))) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

describe("test_strategy_chaining.py", () => {
  describe("TestInterviewGateSections", () => {
    const text = readText("strategies/interview.md");
    it("test_chaining_gate_section_exists", () => {
      expect(text).toContain("## Chaining Gate");
    });
    it("test_acceptance_gate_section_exists", () => {
      expect(text).toContain("## Acceptance Gate");
    });
    it("test_chaining_gate_before_sizing_gate", () => {
      expect(text.indexOf("## Chaining Gate")).toBeLessThan(text.indexOf("## Sizing Gate"));
    });
    it("test_acceptance_gate_after_transition_criteria", () => {
      expect(text.lastIndexOf("### Transition Criteria")).toBeLessThan(
        text.indexOf("## Acceptance Gate"),
      );
    });
  });

  /** #2925 — Chaining Gate brownfield create-vs-update + interview guard wiring. */
  describe("TestChainingGateArtifactAware", () => {
    const interview = readText("strategies/interview.md");
    const guards = readText("strategies/artifact-guards.md");
    const chaining = interview.includes("## Chaining Gate")
      ? (interview.split("## Chaining Gate")[1]?.split("## Sizing Gate")[0] ?? "")
      : "";
    const specGenRosterLine =
      guards
        .split("\n")
        .find((line) => line.includes("Referenced by spec-generating strategies:")) ?? "";

    it("test_interview_cites_artifact_guards_and_before_writing", () => {
      expect(interview).toContain("artifact-guards.md");
      expect(interview).toContain("Before writing");
      expect(interview).toContain("Spec-Generating Guard");
      expect(interview).toContain("Preparatory Guard");
    });

    it("test_chaining_gate_documents_brownfield_add_scope_default", () => {
      expect(chaining).toContain("Brownfield Detector");
      expect(chaining).toContain("Add scope to this project");
      expect(chaining).toMatch(/Add scope to this project[\s\S]*\(default\)/);
      expect(chaining).toContain("Update project definition");
      expect(chaining).toContain("Replace specification (scrap)");
      expect(chaining).toContain("yes");
      expect(chaining).toContain("confirmed");
      // Greenfield keeps Proceed default; brownfield must not default only to Proceed.
      expect(chaining).toContain("Proceed to specification");
      // #4390 — identity-only shares Proceed / Starting-new; not PD-existence brownfield
      expect(chaining.toLowerCase()).toContain("identity-only");
      expect(chaining).toContain("plan.items");
      expect(chaining).toContain(".gitkeep");
      expect(chaining).toContain("*.premigrate.*");
      expect(chaining.toLowerCase()).toContain("convention-valid");
      // #5692 — who/need ProblemStatement reframes solution-first "ask what to build"
      expect(chaining.toLowerCase()).toContain("who/need");
      expect(chaining).toContain("ProblemStatement");
      expect(chaining).toContain("Starting-new / Proceed skip");
      expect(chaining.toLowerCase()).toContain("overview");
      expect(chaining.toLowerCase()).toContain("xbrief/proposed/");
      expect(chaining).toContain("\u2297 Treat PROJECT-DEFINITION existence alone as brownfield");
      expect(chaining).toContain("\u2297 Skip this gate on scoped/brownfield repos");
      // Deterministic-questions: example menus end with Discuss + Back (#2925 greptile).
      expect(chaining).toContain("Discuss");
      expect(chaining).toMatch(/Other \(specify\)[\s\S]*Discuss[\s\S]*Back/);
      // #4337 -- labeled no-write leave-strategy (not Back or Other)
      expect(chaining).toContain("Process-only (keep Phase 2 identity)");
      expect(chaining.toLowerCase()).toContain("leave strategy");
      expect(chaining).toMatch(
        /Process-only \(keep Phase 2 identity\)[\s\S]*Other \(specify\)[\s\S]*Discuss[\s\S]*Back/,
      );
      expect(chaining.toLowerCase()).toContain("do not emit");
      expect(chaining.toLowerCase()).toContain("acceptance gate");
      expect(chaining).toContain("\u2297 Use Back or Other");
    });

    /** #5692 — ProblemStatement before sizing SHOULD (Light and Full). */
    it("test_interview_presizing_problemstatement_should", () => {
      const sizing = interview.includes("## Sizing Gate")
        ? (interview.split("## Sizing Gate")[1]?.split("## Workflow Overview")[0] ?? "")
        : "";
      expect(sizing).toContain("Pre-sizing ProblemStatement");
      expect(sizing.toLowerCase()).toContain("lawful exemption");
      expect(sizing).toContain("recorded reason");
      expect(sizing).toContain("#4536");
      expect(sizing).toContain("Post-Interview Confirmation Gate");
      expect(sizing).toContain("\u2297 Promote this ask to MUST");
      expect(sizing).toContain("Sizing confirmation (blocking)");
      const light = interview.split("## Light Path")[1]?.split("## Full Path")[0] ?? "";
      expect(light).toContain("ProblemStatement");
      const full =
        interview.split("## Full Path")[1]?.split("## SPECIFICATION Guidelines")[0] ?? "";
      expect(full.toLowerCase()).toContain("reuse");
      expect(full).toContain("ProblemStatement");
    });

    it("test_discuss_challenge_vagueness_solution_first", () => {
      const discuss = readText("strategies/discuss.md");
      const challenge = discuss.includes("### Challenge Vagueness")
        ? (discuss.split("### Challenge Vagueness")[1]?.split("### Scope Guardrails")[0] ?? "")
        : "";
      expect(challenge).toContain("build a dashboard");
      expect(challenge.toLowerCase()).toContain("what does the user need to see");
      expect(challenge).toContain("#5692");
    });

    it("test_spec_generating_roster_includes_interview_and_yolo", () => {
      expect(specGenRosterLine).toContain("interview");
      expect(specGenRosterLine).toContain("yolo");
      expect(guards).toMatch(
        /\*\*speckit\*\*, \*\*enterprise\*\*, \*\*rapid\*\*, \*\*interview\*\*, \*\*yolo\*\*/,
      );
    });

    it("test_spec_generating_guard_is_xbrief_first", () => {
      expect(guards).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
      expect(guards).toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
      expect(guards.toLowerCase()).toContain("xbrief-first");
      expect(guards).toContain("live identity");
    });

    it("test_interview_light_full_paths_are_xbrief_first", () => {
      const light = interview.split("## Light Path")[1]?.split("## Full Path")[0] ?? "";
      const full =
        interview.split("## Full Path")[1]?.split("## SPECIFICATION Guidelines")[0] ?? "";
      for (const section of [light, full, interview]) {
        expect(section.toLowerCase()).toContain("xbrief-first");
        expect(section).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
        expect(section).toContain("xbrief/proposed/");
      }
      // Must not hardcode only the legacy write target on Light/Full emission steps.
      expect(light).not.toContain(
        "Write scope vBRIEF(s) to `./vbrief/proposed/YYYY-MM-DD-<slug>.vbrief.json`",
      );
      expect(full).not.toContain(
        "Write scope vBRIEF(s) to `./vbrief/proposed/YYYY-MM-DD-<slug>.vbrief.json`",
      );
    });
  });

  describe("TestReadmeTypeColumn", () => {
    const rows = parseReadmeTable();
    it("test_type_column_exists", () => {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toHaveProperty("type");
    });
    it("test_all_rows_have_valid_type", () => {
      for (const row of rows) {
        expect(VALID_TYPES.has(row.type ?? "")).toBe(true);
      }
    });
    it("test_known_preparatory_strategies", () => {
      for (const row of rows) {
        const m = (row.strategy ?? "").match(/\[([^\]]+)\]/);
        const name = m?.[1] ?? row.strategy ?? "";
        if (
          ["map.md", "discuss.md", "research.md", "design-thinking.md", "bdd.md"].includes(name)
        ) {
          expect(row.type).toBe("preparatory");
        }
      }
    });
    it("test_known_spec_generating_strategies", () => {
      for (const row of rows) {
        const m = (row.strategy ?? "").match(/\[([^\]]+)\]/);
        const name = m?.[1] ?? row.strategy ?? "";
        if (["interview.md", "yolo.md", "speckit.md"].includes(name)) {
          expect(row.type).toBe("spec-generating");
        }
      }
    });
  });

  for (const filename of [
    "map.md",
    "research.md",
    "discuss.md",
    "probe.md",
    "design-thinking.md",
  ]) {
    it(`test_preparatory_strategy_references_chaining_gate ${filename}`, () => {
      const text = readText(`strategies/${filename}`);
      expect(
        text.includes("## Then: Chaining Gate") ||
          (text.includes("### Chained Mode") && text.toLowerCase().includes("chaining gate")),
      ).toBe(true);
    });
  }
  for (const filename of ["interview.md", "yolo.md", "speckit.md"]) {
    it(`test_spec_generating_strategy_no_then_chaining_gate ${filename}`, () => {
      expect(readText(`strategies/${filename}`)).not.toContain("## Then: Chaining Gate");
    });
  }

  describe("TestVbriefSchemaDocumentation", () => {
    const text = readText("vbrief/vbrief.md");
    it("test_completed_strategies_documented", () => {
      expect(text).toContain("completedStrategies");
    });
    it("test_artifacts_field_documented", () => {
      expect(text).toContain("Strategy Chaining Fields");
    });
    it("test_run_count_documented", () => {
      expect(text).toContain("runCount");
    });
  });

  describe("TestYoloV020OutputShape", () => {
    it("test_yolo_md_emits_v020_output_shape", () => {
      const text = readText("strategies/yolo.md");
      expect(text).toContain("v0.20 Output Shape (s3-migrate-yolo / #1166)");
      expect(text).toContain("task project:render");
      expect(text).toContain("PROJECT-DEFINITION.vbrief.json");
      expect(
        text.includes("vbrief/proposed/YYYY-MM-DD-") ||
          text.toLowerCase().includes("date-prefixed"),
      ).toBe(true);
      expect(text).toContain("Never emit `vbrief/specification.vbrief.json`");
      expect(text).toContain("artifact-guards.md");
      expect(text).toContain("Pre-Cutover Detection Guard");
    });
  });

  /** #5691 — design-thinking preparatory UAT-planning Prefer-A Bound. */
  describe("TestDesignThinkingUatPlanning", () => {
    const text = readText("strategies/design-thinking.md");
    const interview = readText("strategies/interview.md");
    const guards = readText("strategies/artifact-guards.md");
    const chaining = interview.includes("## Chaining Gate")
      ? (interview.split("## Chaining Gate")[1]?.split("## Sizing Gate")[0] ?? "")
      : "";

    it("test_design_thinking_uat_planning_emits_requires_uat_and_handoff", () => {
      expect(text).toContain("UAT-planning");
      expect(text).toContain("x-directive/requires: uat");
      expect(text).toContain("Handoff carrier");
      expect(text).toContain("omission check");
      expect(text).toContain("source→destination compare");
      expect(text).toContain("missing-item");
      expect(text).toContain("changed-scope");
      expect(text).toContain("preserved-disposition");
      expect(text).toContain("**recovery:** copy the source item");
      expect(text).toContain("evaluateAcceptanceEvidenceGate");
      expect(text).toContain(
        "Do **not** run `evaluateAcceptanceEvidenceGate` at the handoff boundary",
      );
      expect(text).toContain("Keep `evaluateAcceptanceEvidenceGate` at **`scope:complete`**");
      expect(text).toContain(
        "\u2297 Run `evaluateAcceptanceEvidenceGate` immediately after handoff transfer",
      );
      expect(text).toContain("stable source identity");
      expect(text).toContain('Name this phase **UAT-planning** (not "Test completed")');
      expect(text).toMatch(/UAT-planning[\s\S]*not "Test completed"/);
      expect(text).toContain("\u2297 Close UAT planning with LockedDecisions-style");
      expect(text).toContain("fall back to the [interview.md Chaining Gate]");
    });

    it("test_design_thinking_item_fields_and_nonterminal", () => {
      expect(text.toLowerCase()).toContain("audience");
      expect(text.toLowerCase()).toContain("hypothesis");
      expect(text).toContain("pass/fail");
      expect(text).toContain("uat-evidence/**");
      expect(text).toContain("stampNamespacedDisposition");
      expect(text).toContain("parseDisposition");
      expect(text.toLowerCase()).toContain("non-terminal");
      expect(text).toContain("not_applicable");
      expect(text).toContain("waived");
      expect(text).toContain("deferred");
      expect(text).toContain("ceremonyDial");
      expect(text).toContain("\u2297 Omit the uat item on skip");
    });

    it("test_design_thinking_narratives_keepouts", () => {
      expect(text).toContain("ProblemStatement");
      expect(text).toContain("UserStories");
      expect(text).toContain("UserInsights");
      expect(text).toContain("HowMightWe");
      expect(text).toContain("SolutionConcepts");
      expect(text).toContain("SPECIFICATION_NARRATIVE_KEY_ORDER");
      expect(text).toContain("NARRATIVE_KEYS");
      expect(text).toContain("\u2297 Use narrative key `Test`");
      expect(text).toContain("HBS Develop / Implement");
    });

    it("test_design_thinking_data_trustlevel_security", () => {
      expect(text).toContain("Scope Confirmation");
      expect(text).toContain("TrustLevel: external");
      expect(text).toContain("## Security context (#480)");
      expect(text).toContain("Discuss");
      expect(text).toContain("Back");
      expect(text).toContain("\u2297 Copy raw PII");
    });

    it("test_design_thinking_registration_surfaces", () => {
      expect(text).toContain("## Then: Chaining Gate");
      expect(chaining).toContain("Design-thinking");
      expect(chaining).toContain("Run a design-thinking phase");
      expect(chaining).toContain("Run a bdd phase");
      expect(chaining).toContain("omission check");
      expect(chaining).toContain("source→destination compare");
      expect(chaining).toContain("evaluateAcceptanceEvidenceGate");
      expect(chaining).toContain("do **not** run `evaluateAcceptanceEvidenceGate` at handoff");
      expect(chaining).toContain("keep that gate at `scope:complete`");
      expect(guards).toContain("design-thinking");
      const rows = parseReadmeTable();
      const dt = rows.find((row) => (row.strategy ?? "").includes("design-thinking.md"));
      expect(dt?.type).toBe("preparatory");
      const pack = JSON.parse(readText("packs/strategies/strategies-pack-0.1.json")) as {
        strategies: Array<{ id: string; body: string }>;
      };
      expect(pack.strategies.some((s) => s.id === "design-thinking")).toBe(true);
    });
  });

  describe("TestProbeMechanicalGuard", () => {
    const text = readText("strategies/probe.md");
    it("test_probe_strategy_documents_mechanical_guard_module", () => {
      expect(text).not.toContain("scripts/probe_session.py");
      expect(text).not.toContain("uv run python");
      expect(text).toContain("deft probe-session");
      expect(
        text.includes("Mechanical guard") || text.toLowerCase().includes("mechanical guard"),
      ).toBe(true);
    });
    it("test_probe_strategy_documents_interrogate_complete_states", () => {
      expect(text).toContain("interrogate");
      expect(text).toContain("complete");
      expect(text).toContain(".deft/probe-session.json");
    });
    it("test_probe_strategy_documents_guard_commands", () => {
      expect(text).toContain("guard-artifact");
      expect(text).toContain("guard-plan-registration");
      expect(text).toContain("completedStrategies.probe");
      expect(text).toContain("xbrief/proposed/YYYY-MM-DD-{scope}-probe.xbrief.json");
      expect(text).toContain("deft probe-session guard-artifact");
    });
    it("test_probe_strategy_documents_recovery_path", () => {
      expect(text.includes("Recovery") || text.toLowerCase().includes("recovery")).toBe(true);
      expect(text).toContain("deft probe-session complete");
      expect(text.toLowerCase()).toContain("transition criteria");
    });
    it("test_probe_strategy_live_contract_xbrief_and_waiver", () => {
      expect(text).toMatch(/Waiver[\s\S]*#3556/);
      expect(text).toContain("xbrief/plan.xbrief.json");
      expect(text).not.toContain("vbrief/proposed/{scope}-probe");
      const pack = JSON.parse(readText("packs/strategies/strategies-pack-0.1.json")) as {
        strategies: Array<{ id: string; body: string }>;
      };
      const probe = pack.strategies.find((s) => s.id === "probe");
      expect(probe).toBeDefined();
      expect(probe?.body).not.toContain("scripts/probe_session.py");
      expect(probe?.body).toContain("deft probe-session");
      expect(probe?.body).toContain("xbrief/proposed/YYYY-MM-DD-{scope}-probe.xbrief.json");
      expect(probe?.body).not.toContain("xbrief/proposed/{scope}-probe.xbrief.json");
    });
  });
});
