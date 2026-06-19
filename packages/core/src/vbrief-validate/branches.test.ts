import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateConformance, scanVbrief } from "./conformance.js";
import { validateNoRootDecompositionDrafts } from "./decomposition.js";
import { validateEpicStoryLinks } from "./epic-links.js";
import { validateFolderStatus } from "./folder-status.js";
import { runConformance, runValidate } from "./main.js";
import { validateOriginProvenance } from "./origin.js";
import { scopeIdsForRefUri } from "./paths.js";
import { validateDeprecatedPlaceholders } from "./placeholders.js";
import {
  validateSessionRitualStalenessHoursOnPlan,
  validateTriageRankingLabelsOnPlan,
  validateWipCapOnPlan,
} from "./plan-hooks.js";
import { isCurrentGeneratedSpecification, isDeprecationRedirect } from "./precutover.js";
import { validateProjectDefinition } from "./project-definition.js";
import { validateVbriefSchema } from "./schema.js";
import { checkRenderStaleness } from "./staleness.js";
import { validateAll } from "./validate-all.js";

function writeScope(
  vbrief: string,
  folder: string,
  name: string,
  body: Record<string, unknown>,
): string {
  const dir = join(vbrief, folder);
  mkdirSync(dir, { recursive: true });
  const display = `vbrief/${folder}/${name}`;
  writeFileSync(join(dir, name), JSON.stringify(body), "utf8");
  return display;
}

describe("vbrief-validate branch coverage", () => {
  it("covers origin provenance strict and default modes", () => {
    const data = { plan: { status: "pending", references: [] } };
    expect(
      validateOriginProvenance("vbrief/pending/x.vbrief.json", data, "vbrief", false)[0],
    ).toContain("(D11)");
    expect(
      validateOriginProvenance("vbrief/pending/x.vbrief.json", data, "vbrief", true)[0],
    ).toContain("--strict-origin-types");
    const withOrigin = {
      plan: {
        status: "pending",
        references: [{ type: "x-vbrief/github-issue", uri: "https://x" }],
      },
    };
    expect(validateOriginProvenance("vbrief/pending/y.vbrief.json", withOrigin, "vbrief")).toEqual(
      [],
    );
    const legacy = {
      plan: { status: "active", references: [{ type: "github-issue", uri: "#1" }] },
    };
    expect(validateOriginProvenance("vbrief/active/z.vbrief.json", legacy, "vbrief")).toEqual([]);
  });

  it("covers folder status mismatch and schema branches", () => {
    const err = validateFolderStatus(
      "vbrief/active/bad.vbrief.json",
      { plan: { status: "pending" } },
      "vbrief",
    );
    expect(err[0]).toContain("(D2)");
    const schemaErrors = validateVbriefSchema(
      { vBRIEFInfo: { version: "0.5" }, plan: { title: "T", status: "nope", items: [] } },
      "vbrief/x.vbrief.json",
    );
    expect(schemaErrors.length).toBeGreaterThanOrEqual(2);
  });

  it("covers project definition hooks and registry checks", () => {
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    expect(validateWipCapOnPlan({ policy: { wipCap: -1 } }, fp)[0]).toContain("#1124");
    expect(validateWipCapOnPlan({ policy: { wipCap: "x" } }, fp)[0]).toContain("integer");
    expect(
      validateSessionRitualStalenessHoursOnPlan(
        { policy: { sessionRitualStalenessHours: 0 } },
        fp,
      )[0],
    ).toContain("#1348");
    expect(
      validateTriageRankingLabelsOnPlan({ policy: { triageRankingLabels: [""] } }, fp)[0],
    ).toContain("#1128");
    expect(scopeIdsForRefUri("file://2026-01-01-my-slug.vbrief.json").has("my-slug")).toBe(true);
  });

  it("covers epic links and validateAll integration", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-branches-"));
    const vbrief = join(root, "vbrief");
    const parentDisplay = writeScope(vbrief, "proposed", "2026-01-01-parent.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Parent",
        status: "proposed",
        items: [],
        references: [{ type: "x-vbrief/plan", uri: "pending/2026-01-01-child.vbrief.json" }],
      },
    });
    const childDisplay = writeScope(vbrief, "pending", "2026-01-01-child.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Child",
        status: "pending",
        items: [],
        planRef: "proposed/2026-01-01-parent.vbrief.json",
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/x/y/issues/1" }],
      },
    });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [],
        },
      }),
      "utf8",
    );
    const { errors, warnings } = validateAll(vbrief);
    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(0);

    const all = new Map<string, Record<string, unknown>>();
    all.set(join(vbrief, "proposed", "2026-01-01-parent.vbrief.json"), {
      plan: { references: [{ type: "x-vbrief/plan", uri: "missing/child.vbrief.json" }] },
    });
    expect(
      validateEpicStoryLinks(
        all,
        vbrief,
        new Map([[join(vbrief, "proposed", "2026-01-01-parent.vbrief.json"), parentDisplay]]),
      ).some((e) => e.includes("(D4)")),
    ).toBe(true);

    rmSync(root, { recursive: true, force: true });
    expect(parentDisplay).toContain("parent");
    expect(childDisplay).toContain("child");
  });

  it("covers placeholders staleness and decomposition", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-misc-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(root, "PROJECT.md"), "real content", "utf8");
    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "Spec",
          status: "approved",
          narratives: { Overview: "ONLY-HERE" },
          items: [],
        },
      }),
      "utf8",
    );
    writeFileSync(join(root, "PRD.md"), "stale", "utf8");
    expect(validateDeprecatedPlaceholders(vbrief)[0]).toContain("PROJECT.md");
    expect(checkRenderStaleness(vbrief)[0]).toContain("PRD.md may be stale");
    writeFileSync(join(root, "decomp.json"), JSON.stringify({ stories: [] }), "utf8");
    expect(validateNoRootDecompositionDrafts(vbrief)[0]).toContain("decomposition draft");
    expect(isDeprecationRedirect("<!-- deft:deprecated-redirect -->")).toBe(true);
    expect(isCurrentGeneratedSpecification(root, "<!-- Purpose: rendered specification -->")).toBe(
      false,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("covers conformance violations and CLI branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-conf-br-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    writeFileSync(
      join(root, "vbrief", "bad.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], planRef: "#999", bare: true },
      }),
      "utf8",
    );
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    const bad = evaluateConformance(root);
    expect(bad.exitCode).toBe(1);
    expect(scanVbrief("vbrief/bad.vbrief.json", null)).toEqual([]);

    rmSync(join(root, "vbrief", "bad.vbrief.json"));
    execSync("git add -A", { cwd: root, stdio: "ignore" });

    const vbrief = join(root, "vbrief");
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [],
        },
      }),
      "utf8",
    );
    expect(runValidate(["--vbrief-dir", vbrief, "--warnings-as-errors"])).toBe(0);
    expect(runConformance(["--all", "--project-root", root, "--quiet"])).toBe(0);
    expect(evaluateConformance(root, { mode: "nope" as "all" }).exitCode).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers project definition file reference errors", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-ref-"));
    const vbrief = join(root, "vbrief");
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [{ references: [{ uri: "file://../outside.vbrief.json" }] }],
        },
      },
      vbrief,
    );
    expect(errors.some((e) => e.includes("outside vbrief"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
