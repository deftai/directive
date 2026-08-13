import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CEREMONY_MINIMAL_AGENTS_PROFILE_POINTER,
  CEREMONY_RAPID_STRATEGY_POINTER,
  ceremonyDialProfile,
  ceremonyDialToDict,
  detectCeremonyProjectShape,
  ENV_CEREMONY_MODEL_TIER,
  ENV_CEREMONY_TASK_SIZE,
  estimateProvisionalCeremonyInputs,
  FIELD_CEREMONY_DIAL,
  FIELD_CEREMONY_DIAL_CLI_ALIAS,
  formatCeremonyDialAuditLine,
  formatCeremonyDialStatusLine,
  inspectCeremonyDial,
  mergeCeremonyDialDeferrals,
  mergeCeremonyDialInputsWithProvisional,
  normalizeCeremonyModelTier,
  normalizeCeremonyProjectShape,
  normalizeCeremonyTaskSize,
  readCeremonyDialAudit,
  resolveCeremonyDial,
  resolveSessionCeremonyDialInputs,
  selectCeremonyColdStartDepth,
  selectCeremonyDepth,
  selectCeremonyDepthFromMatrix,
  selectCeremonyDepthFromPartialEvidence,
  setCeremonyDial,
  validateCeremonyDial,
} from "./ceremony-dial.js";
import { inspectOnePolicy } from "./index.js";

function makeProject(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "ceremony-dial-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: policy ?? {},
      },
    }),
    "utf8",
  );
  return root;
}

describe("selectCeremonyDepthFromMatrix (#3214)", () => {
  it("maps S × frontier → rapid (acceptance default)", () => {
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "project",
      }),
    ).toBe("rapid");
  });

  it("maps non-project → minimal regardless of size/tier", () => {
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "L",
        modelTier: "low",
        projectShape: "non-project",
      }),
    ).toBe("minimal");
  });

  it("maps S × mid → standard (structure helps mid-tier)", () => {
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "S",
        modelTier: "mid",
        projectShape: "project",
      }),
    ).toBe("standard");
  });

  it("maps S × low → elevated", () => {
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "S",
        modelTier: "low",
        projectShape: "project",
      }),
    ).toBe("elevated");
  });

  it("maps M × frontier → standard and M × low → elevated", () => {
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "M",
        modelTier: "frontier",
        projectShape: "project",
      }),
    ).toBe("standard");
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "M",
        modelTier: "low",
        projectShape: "project",
      }),
    ).toBe("elevated");
  });

  it("maps L × frontier → standard and XL → elevated", () => {
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "L",
        modelTier: "frontier",
        projectShape: "project",
      }),
    ).toBe("standard");
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "XL",
        modelTier: "frontier",
        projectShape: "project",
      }),
    ).toBe("elevated");
  });

  it("two-stage partial evidence: size-only escalates; tier-only is #3263 cold-start", () => {
    // Size-only.
    expect(selectCeremonyDepthFromMatrix({ taskSize: "S" })).toBe("rapid");
    expect(selectCeremonyDepthFromMatrix({ taskSize: "M" })).toBe("standard");
    expect(selectCeremonyDepthFromMatrix({ taskSize: "L" })).toBe("elevated");
    // Tier-only (size incomplete): tier-conditional cold-start (#3263).
    expect(selectCeremonyDepthFromMatrix({ modelTier: "frontier" })).toBe("rapid");
    expect(selectCeremonyDepthFromMatrix({ modelTier: "mid" })).toBe("standard");
    expect(selectCeremonyDepthFromMatrix({ modelTier: "low" })).toBe("standard");
    // Both missing → unknown-tier cold default rapid.
    expect(selectCeremonyDepthFromPartialEvidence({ taskSize: null, modelTier: null })).toBe(
      "rapid",
    );
  });
});

describe("tier-conditional cold-start (#3263)", () => {
  it("selectCeremonyColdStartDepth: mid/low → standard; frontier/unknown → rapid", () => {
    expect(selectCeremonyColdStartDepth("frontier")).toBe("rapid");
    expect(selectCeremonyColdStartDepth("mid")).toBe("standard");
    expect(selectCeremonyColdStartDepth("low")).toBe("standard");
    expect(selectCeremonyColdStartDepth(null)).toBe("rapid");
    expect(selectCeremonyColdStartDepth(undefined)).toBe("rapid");
  });

  it("matrix incomplete size: mid/low cold-start standard; frontier remains rapid", () => {
    expect(
      selectCeremonyDepthFromMatrix({
        modelTier: "mid",
        projectShape: "project",
      }),
    ).toBe("standard");
    expect(
      selectCeremonyDepthFromMatrix({
        modelTier: "low",
        projectShape: "project",
      }),
    ).toBe("standard");
    expect(
      selectCeremonyDepthFromMatrix({
        modelTier: "frontier",
        projectShape: "project",
      }),
    ).toBe("rapid");
  });

  it("selectCeremonyDepth wires mid/low incomplete-size inputs to standard", () => {
    const mid = selectCeremonyDepth({
      inputs: { modelTier: "mid", projectShape: "project" },
    });
    expect(mid.depth).toBe("standard");
    expect(mid.source).toBe("matrix");
    expect(mid.profile.skipFatPath).toBe(false);

    const low = selectCeremonyDepth({
      inputs: { modelTier: "low" },
    });
    expect(low.depth).toBe("standard");
    expect(low.profile.skipFatPath).toBe(false);

    const frontier = selectCeremonyDepth({
      inputs: { modelTier: "frontier" },
    });
    expect(frontier.depth).toBe("rapid");
    expect(frontier.profile.skipFatPath).toBe(true);
  });

  it("override still wins over tier-conditional cold-start", () => {
    const s = selectCeremonyDepth({
      config: { override: "rapid" },
      inputs: { modelTier: "mid", projectShape: "project" },
    });
    expect(s.depth).toBe("rapid");
    expect(s.source).toBe("override");
  });

  it("escalate-on-evidence: size M/L still raises depth when tier is mid", () => {
    // Cold mid is standard; known large size still elevates via full matrix.
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "L",
        modelTier: "mid",
        projectShape: "project",
      }),
    ).toBe("elevated");
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "M",
        modelTier: "mid",
        projectShape: "project",
      }),
    ).toBe("standard");
    // Low × M elevates once size is known (full matrix, not cold-start floor alone).
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "M",
        modelTier: "low",
        projectShape: "project",
      }),
    ).toBe("elevated");
  });
});

describe("selectCeremonyDepth precedence", () => {
  it("uses rapid when no inputs (unknown-tier cold default)", () => {
    const s = selectCeremonyDepth({});
    expect(s.depth).toBe("rapid");
    expect(s.source).toBe("default");
    // Ceremony light — but readiness is not part of skipFatPath contract for tools.
    expect(s.profile.skipFatPath).toBe(true);
    expect(s.profile.autoDeferSteps).toEqual(["triage_welcome"]);
  });

  it("override wins over matrix", () => {
    const s = selectCeremonyDepth({
      config: { override: "elevated" },
      inputs: { taskSize: "S", modelTier: "frontier", projectShape: "project" },
    });
    expect(s.depth).toBe("elevated");
    expect(s.source).toBe("override");
  });

  it("disabled forces standard", () => {
    const s = selectCeremonyDepth({
      config: { enabled: false, override: "rapid" },
      inputs: { taskSize: "S", modelTier: "frontier" },
    });
    // override still present in config but enabled=false short-circuits first
    expect(s.depth).toBe("standard");
    expect(s.source).toBe("disabled");
  });

  it("matrix path sets composition pointers", () => {
    const rapid = selectCeremonyDepth({
      inputs: { taskSize: "S", modelTier: "frontier", projectShape: "project" },
    });
    expect(rapid.depth).toBe("rapid");
    expect(rapid.source).toBe("matrix");
    expect(rapid.composition.rapidStrategy).toBe(CEREMONY_RAPID_STRATEGY_POINTER);
    expect(rapid.composition.minimalAgentsProfile).toBeNull();

    const minimal = selectCeremonyDepth({
      inputs: { projectShape: "non-project", taskSize: "S", modelTier: "frontier" },
    });
    expect(minimal.depth).toBe("minimal");
    expect(minimal.composition.minimalAgentsProfile).toBe(CEREMONY_MINIMAL_AGENTS_PROFILE_POINTER);
    expect(minimal.composition.rapidStrategy).toBeNull();
  });

  it("rapid/minimal profiles auto-defer cold triage only (not gated readiness)", () => {
    expect(ceremonyDialProfile("rapid").autoDeferSteps).toEqual(["triage_welcome"]);
    expect(ceremonyDialProfile("minimal").autoDeferSteps).toEqual(["triage_welcome"]);
    // Gated mutation readiness must never be auto-deferred (Greptile P1).
    expect(ceremonyDialProfile("rapid").autoDeferSteps).not.toContain("doctor");
    expect(ceremonyDialProfile("rapid").autoDeferSteps).not.toContain("cache_fresh");
    expect(ceremonyDialProfile("rapid").skipFatPath).toBe(true);
    expect(ceremonyDialProfile("minimal").lifecycleWrites).toBe("minimal");
    expect(ceremonyDialProfile("standard").autoDeferSteps).toEqual([]);
  });

  it("literal acceptance-command verification required at every dial depth (#3267)", () => {
    for (const depth of ["minimal", "rapid", "standard", "elevated"] as const) {
      expect(ceremonyDialProfile(depth).literalAcceptanceRequired).toBe(true);
    }
  });
});

describe("normalize helpers", () => {
  it("normalizes size/tier/shape aliases", () => {
    expect(normalizeCeremonyTaskSize("small")).toBe("S");
    expect(normalizeCeremonyTaskSize("medium")).toBe("M");
    expect(normalizeCeremonyModelTier("high")).toBe("frontier");
    expect(normalizeCeremonyModelTier("cheap")).toBe("low");
    expect(normalizeCeremonyProjectShape("adhoc")).toBe("non-project");
    expect(normalizeCeremonyProjectShape("repo")).toBe("project");
    expect(normalizeCeremonyTaskSize("nope")).toBeNull();
  });
});

describe("validateCeremonyDial", () => {
  it("accepts valid objects and rejects bad shapes", () => {
    expect(validateCeremonyDial({ enabled: true, override: "rapid" })).toEqual([]);
    expect(validateCeremonyDial(null)).toEqual([]);
    expect(validateCeremonyDial("x")).toEqual([expect.stringContaining("must be an object")]);
    expect(validateCeremonyDial({ override: "turbo" })).toEqual([
      expect.stringContaining("override"),
    ]);
  });
});

describe("resolveCeremonyDial + policy surface", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("reads typed override from PROJECT-DEFINITION", () => {
    root = makeProject({ ceremonyDial: { override: "rapid" } });
    const resolved = resolveCeremonyDial(root);
    expect(resolved.depth).toBe("rapid");
    expect(resolved.source).toBe("override");
  });

  it("inspectCeremonyDial exposes selectedDepth", () => {
    root = makeProject({ ceremonyDial: { enabled: true } });
    const data = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as Record<string, unknown>;
    const field = inspectCeremonyDial(data, root);
    expect(field.name).toBe(FIELD_CEREMONY_DIAL);
    expect(field.current.enabled).toBe(true);
    // Two-stage cold default when no size/tier inputs: rapid (#3214 design note).
    expect(field.current.selectedDepth).toBe("rapid");
  });

  it("policy:show alias ceremonyDial resolves", () => {
    root = makeProject({ ceremonyDial: { override: "minimal" } });
    const field = inspectOnePolicy(FIELD_CEREMONY_DIAL_CLI_ALIAS, root);
    expect(field).not.toBeNull();
    expect(field?.name).toBe(FIELD_CEREMONY_DIAL);
    expect((field?.current as { override?: string }).override).toBe("minimal");
  });

  it("setCeremonyDial requires confirm and audits", () => {
    root = makeProject({});
    const denied = setCeremonyDial(root, { override: "rapid" });
    expect(denied.exitCode).toBe(1);
    expect(denied.changed).toBe(false);

    const applied = setCeremonyDial(root, {
      override: "rapid",
      enabled: true,
      confirm: true,
      actor: "test",
    });
    expect(applied.exitCode).toBe(0);
    expect(applied.changed).toBe(true);
    expect(applied.stdout).toContain("depth=rapid");

    const pd = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as {
      plan: {
        policy?: { ceremonyDial?: { override: string } };
        "x-directive/policy"?: { ceremonyDial?: { override: string } };
      };
    };
    const block = pd.plan["x-directive/policy"] ?? pd.plan.policy;
    expect(block?.ceremonyDial?.override).toBe("rapid");

    const audit = readFileSync(join(root, "meta", "policy-changes.log"), "utf8");
    expect(audit).toContain("ceremonyDial.override=rapid");
  });

  it("mergeCeremonyDialDeferrals does not clobber operator reasons", () => {
    const selection = selectCeremonyDepth({
      inputs: { taskSize: "S", modelTier: "frontier", projectShape: "project" },
    });
    const merged = mergeCeremonyDialDeferrals({ triage_welcome: "operator-skip" }, selection);
    expect(merged.triage_welcome).toBe("operator-skip");
    // Gated readiness steps are not auto-deferred by the dial.
    expect(merged.doctor).toBeUndefined();
    expect(merged.cache_fresh).toBeUndefined();
  });

  it("format + dict helpers are stable", () => {
    const s = selectCeremonyDepth({
      inputs: { taskSize: "S", modelTier: "frontier", projectShape: "project" },
    });
    expect(formatCeremonyDialStatusLine(s)).toContain("depth=rapid");
    expect(ceremonyDialToDict(s).depth).toBe("rapid");
  });
});

describe("provisional intake estimate (#3214 design note option 1)", () => {
  it("classifies size from verb / file count / prompt without confirmation", () => {
    expect(estimateProvisionalCeremonyInputs({ verb: "fix", env: {} }).taskSize).toBe("S");
    expect(estimateProvisionalCeremonyInputs({ verb: "implement", env: {} }).taskSize).toBe("M");
    expect(estimateProvisionalCeremonyInputs({ verb: "refactor", env: {} }).taskSize).toBe("L");
    expect(
      estimateProvisionalCeremonyInputs({
        filePaths: Array.from({ length: 15 }, (_, i) => `f${i}.ts`),
        env: {},
      }).taskSize,
    ).toBe("L");
    expect(
      estimateProvisionalCeremonyInputs({
        promptText: "through-merge cohort multi-repo platform overhaul",
        env: {},
      }).taskSize,
    ).toBe("XL");
  });

  it("env overrides and deposit project-shape detection", () => {
    const root = makeProject({});
    const est = estimateProvisionalCeremonyInputs({
      projectRoot: root,
      env: {
        [ENV_CEREMONY_TASK_SIZE]: "M",
        [ENV_CEREMONY_MODEL_TIER]: "frontier",
      },
    });
    expect(est.taskSize).toBe("M");
    expect(est.modelTier).toBe("frontier");
    expect(est.projectShape).toBe("project");
    expect(detectCeremonyProjectShape(root)).toBe("project");
    expect(detectCeremonyProjectShape(join(tmpdir(), "no-such-ceremony-root"))).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("explicit inputs win over provisional; max-wins hard tasks escalate", () => {
    const provisional = estimateProvisionalCeremonyInputs({
      verb: "fix",
      fileCount: 25,
      env: {},
    });
    // fileCount L beats verb S (apps-bank: hard-looking scope escalates).
    expect(provisional.taskSize).toBe("L");
    const merged = mergeCeremonyDialInputsWithProvisional(
      { taskSize: "S", modelTier: null, projectShape: "project" },
      provisional,
    );
    expect(merged.taskSize).toBe("S"); // explicit wins
    expect(merged.projectShape).toBe("project");
  });

  it("resolveSessionCeremonyDialInputs fills vanilla deposit without policy opt-in", () => {
    const root = makeProject({});
    const { inputs, provisional } = resolveSessionCeremonyDialInputs(root, undefined, {
      verb: "build",
      env: {},
    });
    expect(provisional.projectShape).toBe("project");
    expect(inputs.projectShape).toBe("project");
    expect(inputs.taskSize).toBe("M");
    // M + no tier → standard (escalate on substantial size).
    expect(selectCeremonyDepth({ inputs }).depth).toBe("standard");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("deposit-as-project classifier (#3321 / #3214)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats .deft/core or AGENTS+xbrief as project; empty tree stays unknown", () => {
    const empty = mkdtempSync(join(tmpdir(), "ceremony-shape-empty-"));
    roots.push(empty);
    expect(detectCeremonyProjectShape(empty)).toBeNull();

    const coreOnly = mkdtempSync(join(tmpdir(), "ceremony-shape-core-"));
    roots.push(coreOnly);
    mkdirSync(join(coreOnly, ".deft", "core"), { recursive: true });
    expect(detectCeremonyProjectShape(coreOnly)).toBe("project");

    const agentsXbrief = mkdtempSync(join(tmpdir(), "ceremony-shape-agents-"));
    roots.push(agentsXbrief);
    writeFileSync(join(agentsXbrief, "AGENTS.md"), "# A\n", "utf8");
    mkdirSync(join(agentsXbrief, "xbrief"), { recursive: true });
    expect(detectCeremonyProjectShape(agentsXbrief)).toBe("project");
  });

  it("mid x L on a vanilla deposit selects elevated (hard-task profile)", () => {
    const root = makeProject({});
    roots.push(root);
    expect(detectCeremonyProjectShape(root)).toBe("project");
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "L",
        modelTier: "mid",
        projectShape: detectCeremonyProjectShape(root),
      }),
    ).toBe("elevated");
    expect(
      selectCeremonyDepthFromMatrix({
        taskSize: "L",
        modelTier: "mid",
        projectShape: "non-project",
      }),
    ).toBe("minimal");
  });
});

describe("readCeremonyDialAudit (#3263)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("reads depth + provisional reasons from ritual-state", () => {
    root = makeProject({});
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        ceremony_dial: {
          depth: "standard",
          source: "matrix",
          inputs: {
            taskSize: null,
            modelTier: "mid",
            projectShape: "project",
          },
          provisional: {
            taskSize: null,
            modelTier: "mid",
            projectShape: "project",
            reasons: ["modelTier=mid from env"],
          },
        },
      }),
      "utf8",
    );

    const audit = readCeremonyDialAudit(root);
    expect(audit.error).toBeNull();
    expect(audit.depth).toBe("standard");
    expect(audit.source).toBe("matrix");
    expect(audit.inputs?.modelTier).toBe("mid");
    expect(audit.provisional?.reasons).toContain("modelTier=mid from env");
    expect(formatCeremonyDialAuditLine(audit)).toContain("depth=standard");
    expect(formatCeremonyDialAuditLine(audit)).toContain("modelTier=mid");
    expect(formatCeremonyDialAuditLine(audit)).toContain("provisional.reasons=");
  });

  it("reports missing ritual-state and missing ceremony_dial", () => {
    root = makeProject({});
    const missing = readCeremonyDialAudit(root);
    expect(missing.depth).toBeNull();
    expect(missing.error).toMatch(/ritual-state missing/);

    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({ schemaVersion: 1, session_id: "x" }),
      "utf8",
    );
    const noDial = readCeremonyDialAudit(root);
    expect(noDial.error).toMatch(/no ceremony_dial/);
    expect(formatCeremonyDialAuditLine(noDial)).toContain("error=");
  });

  it("reports invalid JSON and non-object ceremony_dial", () => {
    root = makeProject({});
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "ritual-state.json"), "{not-json", "utf8");
    const badJson = readCeremonyDialAudit(root);
    expect(badJson.error).toMatch(/not valid JSON/);

    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({ ceremony_dial: ["not-an-object"] }),
      "utf8",
    );
    const badDial = readCeremonyDialAudit(root);
    expect(badDial.error).toMatch(/ceremony_dial must be an object/);

    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({
        ceremony_dial: {
          depth: "rapid",
          source: "default",
          inputs: null,
          provisional: { reasons: ["ok", 12, "kept"] },
        },
      }),
      "utf8",
    );
    const partial = readCeremonyDialAudit(root);
    expect(partial.error).toBeNull();
    expect(partial.depth).toBe("rapid");
    expect(partial.inputs).toBeNull();
    expect(partial.provisional?.reasons).toEqual(["ok", "kept"]);
    expect(formatCeremonyDialAuditLine(partial)).toContain("provisional.reasons=ok; kept");
  });

  it("formats empty provisional reasons", () => {
    root = makeProject({});
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({
        ceremony_dial: {
          depth: "standard",
          source: "matrix",
          inputs: { taskSize: "M", modelTier: "mid", projectShape: "project" },
          provisional: {
            taskSize: "M",
            modelTier: "mid",
            projectShape: "project",
            reasons: [],
          },
        },
      }),
      "utf8",
    );
    const audit = readCeremonyDialAudit(root);
    expect(formatCeremonyDialAuditLine(audit)).toContain("provisional.reasons=(none)");
  });

  it("collapses multiline reasons into a single audit line", () => {
    root = makeProject({});
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "ritual-state.json"),
      JSON.stringify({
        ceremony_dial: {
          depth: "standard",
          source: "matrix",
          inputs: { taskSize: null, modelTier: "mid", projectShape: "project" },
          provisional: {
            taskSize: null,
            modelTier: "mid",
            projectShape: "project",
            reasons: ["taskSize=M\nfrom verb", "modelTier=mid\r\nfrom env"],
          },
        },
      }),
      "utf8",
    );
    const line = formatCeremonyDialAuditLine(readCeremonyDialAudit(root));
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain("taskSize=M from verb");
    expect(line).toContain("modelTier=mid from env");
  });
});
