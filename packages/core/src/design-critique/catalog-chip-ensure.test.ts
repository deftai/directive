import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GhRestError, type RunGhApiFn } from "../scm/gh-rest.js";
import {
  CHIP_MISS_CLASS_AUTH_OR_PERMISSION,
  CHIP_MISS_CLASS_ENSURE_FAILED,
  CHIP_MISS_CLASS_MISSING_REPO_LABEL,
  catalogChipCreateTableNames,
  classifyLabelProbeError,
  classifyLabelProbeStatus,
  DESIGN_CRITIQUE_CATALOG_CHIP_CREATE_TABLE,
  ensureCatalogChipLabel,
  hasDesignCritiqueJudgmentGate,
  isDesignCritiqueDeposited,
} from "./catalog-chip-ensure.js";
import { DESIGN_CRITIQUE_CATALOG_CHIPS } from "./exclusive-chip.js";

describe("classifyLabelProbeStatus (#5326)", () => {
  it("maps HTTP 404 to missing-repo-label", () => {
    expect(classifyLabelProbeStatus(404)).toBe(CHIP_MISS_CLASS_MISSING_REPO_LABEL);
  });

  it("maps gh process exit 1 + HTTP 404 stderr to missing-repo-label", () => {
    const stderr = 'gh: Not Found (HTTP 404)\n{"message":"Not Found","status":"404"}';
    expect(classifyLabelProbeStatus(1, stderr)).toBe(CHIP_MISS_CLASS_MISSING_REPO_LABEL);
  });

  it("maps 401/403/other to auth-or-permission", () => {
    expect(classifyLabelProbeStatus(401)).toBe(CHIP_MISS_CLASS_AUTH_OR_PERMISSION);
    expect(classifyLabelProbeStatus(403)).toBe(CHIP_MISS_CLASS_AUTH_OR_PERMISSION);
    expect(classifyLabelProbeStatus(500)).toBe(CHIP_MISS_CLASS_AUTH_OR_PERMISSION);
    expect(classifyLabelProbeStatus(1, "Forbidden (HTTP 403)")).toBe(
      CHIP_MISS_CLASS_AUTH_OR_PERMISSION,
    );
  });

  it("classifies GhRestError by exitCode and stderr", () => {
    const missingHttp = new GhRestError({
      stderr: "gh: Not Found (HTTP 404)",
      exitCode: 1,
      endpoint: "repos/o/r/labels/x",
      payload: null,
    });
    expect(classifyLabelProbeError(missingHttp)).toBe(CHIP_MISS_CLASS_MISSING_REPO_LABEL);
    const missing = new GhRestError({
      stderr: "Not Found",
      exitCode: 404,
      endpoint: "repos/o/r/labels/x",
      payload: null,
    });
    expect(classifyLabelProbeError(missing)).toBe(CHIP_MISS_CLASS_MISSING_REPO_LABEL);
    const forbidden = new GhRestError({
      stderr: "Forbidden",
      exitCode: 403,
      endpoint: "repos/o/r/labels/x",
      payload: null,
    });
    expect(classifyLabelProbeError(forbidden)).toBe(CHIP_MISS_CLASS_AUTH_OR_PERMISSION);
    expect(classifyLabelProbeError(new Error("boom"))).toBe(CHIP_MISS_CLASS_AUTH_OR_PERMISSION);
  });
});

describe("DESIGN_CRITIQUE_CATALOG_CHIP_CREATE_TABLE (#5326)", () => {
  it("covers exactly the three catalog chips with color+description", () => {
    expect(catalogChipCreateTableNames()).toEqual([...DESIGN_CRITIQUE_CATALOG_CHIPS]);
    for (const chip of DESIGN_CRITIQUE_CATALOG_CHIPS) {
      const row = DESIGN_CRITIQUE_CATALOG_CHIP_CREATE_TABLE[chip];
      expect(row.name).toBe(chip);
      expect(row.color).toMatch(/^[0-9A-Fa-f]{6}$/);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });
});

describe("ensureCatalogChipLabel (#5326)", () => {
  it("creates once on 404 then reports created", () => {
    const calls: string[] = [];
    const run: RunGhApiFn = (args) => {
      const joined = args.join(" ");
      calls.push(joined);
      if (joined.includes("--method GET") && joined.includes("/labels/")) {
        return { returncode: 404, stdout: "", stderr: "Not Found" };
      }
      if (joined.includes("--method POST")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ name: "design-critique:in-progress" }),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: "{}", stderr: "" };
    };
    const result = ensureCatalogChipLabel("o/r", "design-critique:in-progress", {
      runGhApiFn: run,
    });
    expect(result).toEqual({ ok: true, created: true, skippedExisting: false });
    expect(calls.some((c) => c.includes("GET"))).toBe(true);
    expect(calls.some((c) => c.includes("POST"))).toBe(true);
  });

  it("creates when real gh exits 1 with HTTP 404 stderr", () => {
    const calls: string[] = [];
    const run: RunGhApiFn = (args) => {
      const joined = args.join(" ");
      calls.push(joined);
      if (joined.includes("--method GET") && joined.includes("/labels/")) {
        return {
          returncode: 1,
          stdout: "",
          stderr: 'gh: Not Found (HTTP 404)\n{"message":"Not Found","status":"404"}',
        };
      }
      if (joined.includes("--method POST")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ name: "design-critique:mechanism-shaped" }),
          stderr: "",
        };
      }
      return { returncode: 0, stdout: "{}", stderr: "" };
    };
    const result = ensureCatalogChipLabel("o/r", "design-critique:mechanism-shaped", {
      runGhApiFn: run,
    });
    expect(result).toEqual({ ok: true, created: true, skippedExisting: false });
    expect(calls.some((c) => c.includes("POST"))).toBe(true);
  });

  it("skips create when label already present", () => {
    const run: RunGhApiFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ name: "design-critique:mechanism-shaped" }),
      stderr: "",
    });
    const result = ensureCatalogChipLabel("o/r", "design-critique:mechanism-shaped", {
      runGhApiFn: run,
    });
    expect(result).toEqual({ ok: true, created: false, skippedExisting: true });
  });

  it("maps probe auth failure to auth-or-permission without create", () => {
    const run: RunGhApiFn = () => ({ returncode: 403, stdout: "", stderr: "Forbidden" });
    const result = ensureCatalogChipLabel("o/r", "design-critique:ingest-ready", {
      runGhApiFn: run,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missClass).toBe(CHIP_MISS_CLASS_AUTH_OR_PERMISSION);
    }
  });

  it("maps create auth failure to ensure-failed", () => {
    const run: RunGhApiFn = (args) => {
      const joined = args.join(" ");
      if (joined.includes("POST")) {
        return { returncode: 403, stdout: "", stderr: "Forbidden create" };
      }
      return { returncode: 404, stdout: "", stderr: "Not Found" };
    };
    const result = ensureCatalogChipLabel("o/r", "design-critique:ingest-ready", {
      runGhApiFn: run,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missClass).toBe(CHIP_MISS_CLASS_ENSURE_FAILED);
    }
  });

  it("treats create 422 already_exists as skippedExisting", () => {
    const run: RunGhApiFn = (args) => {
      const joined = args.join(" ");
      if (joined.includes("POST")) {
        return { returncode: 422, stdout: "", stderr: "already_exists" };
      }
      return { returncode: 404, stdout: "", stderr: "Not Found" };
    };
    const result = ensureCatalogChipLabel("o/r", "design-critique:mechanism-shaped", {
      runGhApiFn: run,
    });
    expect(result).toEqual({ ok: true, created: false, skippedExisting: true });
  });
});

describe("isDesignCritiqueDeposited / judgmentGates (#5326)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("is false on an empty tree", () => {
    root = mkdtempSync(join(tmpdir(), "dc-deposit-"));
    expect(isDesignCritiqueDeposited(root)).toBe(false);
  });

  it("is true when contract is present under content/", () => {
    root = mkdtempSync(join(tmpdir(), "dc-deposit-"));
    const rel = join(root, "content", "contracts");
    mkdirSync(rel, { recursive: true });
    writeFileSync(join(rel, "design-critique.md"), "# contract\n", "utf8");
    expect(isDesignCritiqueDeposited(root)).toBe(true);
  });

  it("is true for consumer .deft/core skill path", () => {
    root = mkdtempSync(join(tmpdir(), "dc-deposit-"));
    const rel = join(root, ".deft", "core", "skills", "deft-directive-design-critique");
    mkdirSync(rel, { recursive: true });
    writeFileSync(join(rel, "SKILL.md"), "# skill\n", "utf8");
    expect(isDesignCritiqueDeposited(root)).toBe(true);
  });

  it("detects missing vs present judgmentGates design-critique entry", () => {
    root = mkdtempSync(join(tmpdir(), "dc-deposit-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({ plan: { title: "t", status: "running", policy: {} } }),
      "utf8",
    );
    expect(hasDesignCritiqueJudgmentGate(root)).toBe(false);
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "t",
          status: "running",
          policy: {
            judgmentGates: [
              {
                id: "design-critique",
                class: "declared",
                tier: "review",
                reason: "ADR-005",
                match: { labels: { "any-of": ["design-critique:mechanism-shaped"] } },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    expect(hasDesignCritiqueJudgmentGate(root)).toBe(true);
  });

  it("does not treat body-text-only mechanism-shaped match as gate present", () => {
    root = mkdtempSync(join(tmpdir(), "dc-deposit-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        plan: {
          title: "t",
          status: "running",
          policy: {
            judgmentGates: [
              {
                id: "design-critique",
                class: "declared",
                tier: "review",
                reason: "ADR-005",
                match: {
                  "body-text": { "any-of": ["design-critique:mechanism-shaped"] },
                },
              },
            ],
          },
        },
      }),
      "utf8",
    );
    expect(hasDesignCritiqueJudgmentGate(root)).toBe(false);
  });
});
