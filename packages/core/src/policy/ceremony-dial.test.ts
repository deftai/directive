import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CEREMONY_MINIMAL_AGENTS_PROFILE_POINTER,
  CEREMONY_RAPID_STRATEGY_POINTER,
  ceremonyDialProfile,
  ceremonyDialToDict,
  FIELD_CEREMONY_DIAL,
  FIELD_CEREMONY_DIAL_CLI_ALIAS,
  formatCeremonyDialStatusLine,
  inspectCeremonyDial,
  mergeCeremonyDialDeferrals,
  normalizeCeremonyModelTier,
  normalizeCeremonyProjectShape,
  normalizeCeremonyTaskSize,
  resolveCeremonyDial,
  selectCeremonyDepth,
  detectCeremonyProjectShape,
  ENV_CEREMONY_MODEL_TIER,
  ENV_CEREMONY_TASK_SIZE,
  estimateProvisionalCeremonyInputs,
  mergeCeremonyDialInputsWithProvisional,
  resolveSessionCeremonyDialInputs,
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

  it("two-stage partial evidence: start light; escalate on M/L or mid/low", () => {
    // Size-only.
    expect(selectCeremonyDepthFromMatrix({ taskSize: "S" })).toBe("rapid");
    expect(selectCeremonyDepthFromMatrix({ taskSize: "M" })).toBe("standard");
    expect(selectCeremonyDepthFromMatrix({ taskSize: "L" })).toBe("elevated");
    // Tier-only.
    expect(selectCeremonyDepthFromMatrix({ modelTier: "frontier" })).toBe("rapid");
    expect(selectCeremonyDepthFromMatrix({ modelTier: "mid" })).toBe("standard");
    expect(selectCeremonyDepthFromMatrix({ modelTier: "low" })).toBe("elevated");
    // Both missing.
    expect(selectCeremonyDepthFromPartialEvidence({ taskSize: null, modelTier: null })).toBe(
      "rapid",
    );
  });
});

describe("selectCeremonyDepth precedence", () => {
  it("uses rapid when no inputs (two-stage cold default)", () => {
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
