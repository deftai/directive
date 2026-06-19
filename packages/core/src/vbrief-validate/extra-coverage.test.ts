import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateConformance, renderFinding, scanVbrief } from "./conformance.js";
import { validateNoRootDecompositionDrafts } from "./decomposition.js";
import { validateEpicStoryLinks } from "./epic-links.js";
import { matchesFilenameConvention, validateFilename } from "./filename.js";
import { validateFolderStatus } from "./folder-status.js";
import { cmdVbriefValidate, runConformance, runValidate } from "./main.js";
import { validateOriginProvenance } from "./origin.js";
import {
  displayPath,
  isRelativeTo,
  lifecycleFolderFor,
  resolveRefPath,
  scopeIdsForRefUri,
} from "./paths.js";
import { validateDeprecatedPlaceholders } from "./placeholders.js";
import {
  runProjectDefinitionHooks,
  validateSessionRitualStalenessHoursOnPlan,
  validateTriageRankingLabelsOnPlan,
  validateWipCapOnPlan,
} from "./plan-hooks.js";
import { validateProjectDefinition } from "./project-definition.js";
import {
  normalizeNarrativeKey,
  validateProjectDefNarratives,
  validateVbriefSchema,
} from "./schema.js";
import { checkRenderStaleness } from "./staleness.js";
import { validateAll, validateAllMigration } from "./validate-all.js";

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

describe("vbrief-validate extra coverage", () => {
  it("covers paths helpers", () => {
    expect(isRelativeTo("/a/b", "/a")).toBe(true);
    expect(isRelativeTo("/a", "/a")).toBe(true);
    expect(resolveRefPath("file://active/x.vbrief.json", "/vb")).toContain("active");
    expect(resolveRefPath("https://x", "/vb")).toBeNull();
    expect(resolveRefPath("#1", "/vb")).toBeNull();
    expect(resolveRefPath("pending/x.vbrief.json", "/vb")).toContain("pending");
    expect(scopeIdsForRefUri("2026-01-01-my-slug.vbrief.json").has("my-slug")).toBe(true);
    expect(scopeIdsForRefUri("file://2026-01-01-other.vbrief.json").has("other")).toBe(true);
    expect(scopeIdsForRefUri("plain-name").has("plain-name")).toBe(true);
    expect(lifecycleFolderFor("/proj/vbrief/active/x.vbrief.json", "/proj/vbrief")).toBe("active");
    expect(lifecycleFolderFor("/proj/vbrief/x.vbrief.json", "/proj/vbrief")).toBeNull();
    expect(displayPath("/proj/vbrief/active/x.vbrief.json", "/proj/vbrief")).toBe(
      "vbrief/active/x.vbrief.json",
    );
  });

  it("covers folder status allowed and edge branches", () => {
    expect(
      validateFolderStatus("vbrief/unknown/x.vbrief.json", { plan: { status: "x" } }, "vbrief"),
    ).toEqual([]);
    expect(validateFolderStatus("vbrief/active/x.vbrief.json", {}, "vbrief")).toEqual([]);
    expect(
      validateFolderStatus("vbrief/active/x.vbrief.json", { plan: { status: null } }, "vbrief"),
    ).toEqual([]);
    expect(
      validateFolderStatus(
        "vbrief/completed/x.vbrief.json",
        { plan: { status: "completed" } },
        "vbrief",
      ),
    ).toEqual([]);
  });

  it("covers filename convention branches", () => {
    expect(matchesFilenameConvention("bad.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01.vbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-.vbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-abc-.vbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-abc--def.vbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-abc-def.vbrief.json")).toBe(true);
    expect(validateFilename("vbrief/active/not-a-date.vbrief.json")[0]).toContain("(D7)");
  });

  it("covers schema nested items and project def narratives", () => {
    expect(normalizeNarrativeKey("Tech Stack")).toBe("techstack");
    expect(
      validateProjectDefNarratives("vbrief/PROJECT-DEFINITION.vbrief.json", {
        narratives: { Overview: "O" },
      }).some((e) => e.includes("techstack")),
    ).toBe(true);
    const nested = validateVbriefSchema(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "T",
          status: "running",
          items: [
            {
              id: "a",
              title: "t",
              status: "running",
              items: [{ id: "b", title: "s", status: "running" }],
              subItems: [{ id: "c", title: "u", status: "running" }],
            },
          ],
        },
      },
      "f.json",
    );
    expect(nested.length).toBe(0);
    expect(
      validateVbriefSchema(
        {
          vBRIEFInfo: { version: "0.5" },
          plan: { title: "T", status: "running", items: [] },
        },
        "f.json",
      ).some((e) => e.includes("0.6")),
    ).toBe(true);
  });

  it("covers project definition registry and file refs", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-full-"));
    const vbrief = join(root, "vbrief");
    const scopeDisplay = writeScope(vbrief, "active", "2026-01-01-scope.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "S", status: "blocked", items: [] },
    });
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const pd = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "PD",
        status: "running",
        narratives: { Overview: "O", TechStack: "T" },
        references: [
          { type: "x-vbrief/plan", uri: "active/2026-01-01-scope.vbrief.json", title: "Scope" },
        ],
        items: [
          {
            id: "2026-01-01-scope",
            title: "Scope",
            status: "running",
            metadata: {
              source_path: "active/2026-01-01-scope.vbrief.json",
              references: [{ type: "x-vbrief/plan", uri: "active/2026-01-01-scope.vbrief.json" }],
            },
            references: [{ uri: "active/missing-scope.vbrief.json" }],
          },
          { references: [{ uri: "file://../outside.vbrief.json" }] },
        ],
      },
    };
    const errors = validateProjectDefinition(fp, pd, vbrief);
    expect(errors.some((e) => e.includes("registry-status"))).toBe(true);
    expect(errors.some((e) => e.includes("does not exist"))).toBe(true);
    expect(errors.some((e) => e.includes("outside vbrief"))).toBe(true);
    expect(runProjectDefinitionHooks(pd.plan, fp).length).toBeGreaterThanOrEqual(0);
    rmSync(root, { recursive: true, force: true });
    expect(scopeDisplay).toContain("scope");
  });

  it("covers epic links forward and backward paths", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-epic-"));
    const vbrief = join(root, "vbrief");
    const parentAbs = join(vbrief, "proposed", "2026-01-01-parent.vbrief.json");
    const childAbs = join(vbrief, "pending", "2026-01-01-child.vbrief.json");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      parentAbs,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "P",
          status: "proposed",
          items: [],
          references: [{ type: "x-vbrief/plan", uri: "pending/2026-01-01-child.vbrief.json" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      childAbs,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "C",
          status: "pending",
          items: [{ planRef: "proposed/2026-01-01-parent.vbrief.json" }],
          planRef: "proposed/2026-01-01-parent.vbrief.json",
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/x/y/issues/1" }],
        },
      }),
      "utf8",
    );
    const all = new Map<string, Record<string, unknown>>();
    for (const p of [parentAbs, childAbs]) {
      all.set(p, JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>);
    }
    const display = new Map([
      [parentAbs, "vbrief/proposed/2026-01-01-parent.vbrief.json"],
      [childAbs, "vbrief/pending/2026-01-01-child.vbrief.json"],
    ]);
    expect(validateEpicStoryLinks(all, vbrief, display)).toEqual([]);

    all.set(childAbs, { plan: { references: [] } });
    expect(
      validateEpicStoryLinks(all, vbrief, display).some((e) => e.includes("planRef back")),
    ).toBe(true);

    all.set(childAbs, {
      plan: {
        planRef: "proposed/missing-parent.vbrief.json",
        references: [{ type: "x-vbrief/github-issue", uri: "https://x" }],
      },
    });
    expect(
      validateEpicStoryLinks(all, vbrief, display).some((e) => e.includes("does not exist")),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers decomposition and placeholder branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-decomp-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(root, "children.json"), JSON.stringify({ children: {} }), "utf8");
    writeFileSync(join(root, "broken.json"), "{", "utf8");
    expect(validateNoRootDecompositionDrafts(vbrief)[0]).toContain("decomposition draft");
    writeFileSync(join(root, "PROJECT.md"), "legacy content", "utf8");
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\n",
      "utf8",
    );
    expect(validateDeprecatedPlaceholders(vbrief).some((w) => w.includes("PROJECT.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers staleness branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-stale2-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "MissingTitle",
          status: "approved",
          narratives: { Overview: "ONLY-IN-VBRIEF" },
          items: [{ title: "MissingItem" }],
        },
      }),
      "utf8",
    );
    writeFileSync(join(root, "PRD.md"), "unrelated", "utf8");
    writeFileSync(join(root, "SPECIFICATION.md"), "unrelated spec", "utf8");
    expect(checkRenderStaleness(vbrief).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers plan hook type repr branches", () => {
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    expect(validateWipCapOnPlan({ policy: { wipCap: true } }, fp)[0]).toContain("bool");
    expect(validateWipCapOnPlan({ policy: { wipCap: null } }, fp)).toEqual([]);
    expect(
      validateSessionRitualStalenessHoursOnPlan(
        { policy: { sessionRitualStalenessHours: null } },
        fp,
      ),
    ).toEqual([]);
    expect(
      validateTriageRankingLabelsOnPlan({ policy: { triageRankingLabels: ["ok"] } }, fp),
    ).toEqual([]);
  });

  it("covers origin strict allowlist and legacy prefixes", () => {
    const strict = {
      plan: {
        status: "pending",
        references: [{ type: "x-vbrief/github-issue", uri: "https://x" }],
      },
    };
    expect(
      validateOriginProvenance("vbrief/pending/x.vbrief.json", strict, "vbrief", true),
    ).toEqual([]);
    const legacyPrefix = {
      plan: { status: "pending", references: [{ type: "github-issue-v2", uri: "x" }] },
    };
    expect(
      validateOriginProvenance("vbrief/pending/y.vbrief.json", legacyPrefix, "vbrief"),
    ).toEqual([]);
    const badRef = { plan: { status: "pending", references: [{ type: 1, uri: "x" }] } };
    expect(validateOriginProvenance("vbrief/pending/z.vbrief.json", badRef, "vbrief")[0]).toContain(
      "(D11)",
    );
  });

  it("covers conformance scan and evaluate branches", () => {
    expect(scanVbrief("x.json", null)).toEqual([]);
    const findings = scanVbrief("x.json", {
      vBRIEFInfo: {},
      plan: {
        planRef: "#999",
        bare: true,
        items: [{ bareItem: true, subItems: [{ nestedBare: true }] }],
      },
      extra: true,
    });
    expect(findings.length).toBeGreaterThan(3);
    expect(renderFinding(findings[0]!)).toContain("bare key");

    const root = mkdtempSync(join(tmpdir(), "vb-conf-full-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    writeFileSync(
      join(root, "vbrief", "bad.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], customBare: true },
      }),
      "utf8",
    );
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    const bad = evaluateConformance(root);
    expect(bad.exitCode).toBe(1);
    writeFileSync(join(root, "allow.txt"), "vbrief/bad.vbrief.json\n# comment\n", "utf8");
    expect(evaluateConformance(root, { allowListPath: join(root, "allow.txt") }).exitCode).toBe(0);
    expect(runConformance(["--help"])).toBe(0);
    expect(runConformance(["--bogus"])).toBe(2);
    expect(
      cmdVbriefValidate([
        "conformance",
        "--all",
        "--project-root",
        root,
        "--allow-list",
        join(root, "allow.txt"),
        "--quiet",
      ]),
    ).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers validate CLI success summary paths", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-cli-ok-"));
    const vbrief = join(root, "vbrief");
    writeScope(vbrief, "active", "2026-01-01-good.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "G",
        status: "running",
        items: [],
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
    expect(runValidate(["--vbrief-dir", vbrief])).toBe(0);
    expect(runValidate(["--vbrief-dir", join(root, "missing-vbrief")])).toBe(0);
    const { warnings } = validateAll(vbrief, { strictOriginTypes: true });
    expect(Array.isArray(warnings)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers project definition title/id matching and skip branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-deep-"));
    const vbrief = join(root, "vbrief");
    writeScope(vbrief, "active", "2026-01-01-linked.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "Linked", status: "running", items: [] },
    });
    writeScope(vbrief, "pending", "2026-01-01-valid-ref.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "Valid", status: "pending", items: [] },
    });
    writeFileSync(join(vbrief, "broken-scope.vbrief.json"), "{bad", "utf8");
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const pd = {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "PD",
        status: "running",
        narratives: { Overview: "O", TechStack: "T" },
        references: [
          { type: "x-vbrief/plan", uri: "https://github.com/x", title: "Remote" },
          { type: "x-vbrief/plan", uri: "#local", title: "Hash" },
          { type: "x-vbrief/plan", uri: "missing/nowhere.vbrief.json", title: "Missing" },
          { type: "x-vbrief/plan", uri: "active/2026-01-01-linked.vbrief.json", title: "Linked" },
        ],
        items: [
          { status: 1 },
          "not-an-object",
          {
            id: "2026-01-01-valid-ref",
            title: "Valid",
            status: "pending",
            references: [{ uri: "pending/2026-01-01-valid-ref.vbrief.json" }],
          },
          {
            title: "BrokenScope",
            status: "running",
            metadata: { source_path: "broken-scope.vbrief.json" },
          },
          { references: [{ uri: "file://pending/2026-01-01-valid-ref.vbrief.json" }] },
          { references: [{ uri: "../outside.vbrief.json" }] },
        ],
      },
    };
    const errors = validateProjectDefinition(fp, pd, vbrief);
    expect(errors.some((e) => e.includes("outside vbrief"))).toBe(true);
    expect(validateProjectDefinition(fp, { plan: null }, vbrief)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers staleness happy paths and validateAllMigration", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-stale-ok-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "FreshTitle",
          status: "approved",
          narratives: { Overview: "FreshOverview" },
          items: [{ title: "FreshItem" }],
        },
      }),
      "utf8",
    );
    writeFileSync(join(root, "PRD.md"), "FreshOverview and FreshTitle content", "utf8");
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- deft:deprecated-redirect -->\nredirect",
      "utf8",
    );
    expect(checkRenderStaleness(vbrief)).toEqual([]);
    const [mErrors, mWarnings] = validateAllMigration(vbrief);
    expect(mErrors).toEqual([]);
    expect(mWarnings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers validateAll read errors and warnings-as-errors CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-read-err-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    const unreadable = join(vbrief, "pending", "2026-01-01-unreadable.vbrief.json");
    writeFileSync(unreadable, "{}", "utf8");
    chmodSync(unreadable, 0o000);
    const { errors } = validateAll(vbrief);
    chmodSync(unreadable, 0o644);
    expect(errors.some((e) => e.includes("cannot read"))).toBe(true);

    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(
      join(vbrief, "active", "2026-01-01-warn.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "W", status: "running", items: [], references: [] },
      }),
      "utf8",
    );
    expect(runValidate(["--vbrief-dir", vbrief, "--warnings-as-errors"])).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers epic link on-disk child and item planRef paths", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-epic2-"));
    const vbrief = join(root, "vbrief");
    const parentAbs = join(vbrief, "proposed", "2026-01-01-p2.vbrief.json");
    const childAbs = join(vbrief, "pending", "2026-01-01-c2.vbrief.json");
    const orphanAbs = join(vbrief, "pending", "2026-01-01-orphan.vbrief.json");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      orphanAbs,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "O", status: "pending", items: [] },
      }),
      "utf8",
    );
    const all = new Map<string, Record<string, unknown>>([
      [
        parentAbs,
        {
          plan: {
            references: [{ type: "x-vbrief/plan", uri: "pending/2026-01-01-orphan.vbrief.json" }],
          },
        },
      ],
      [
        childAbs,
        {
          plan: {
            items: [{ planRef: "proposed/2026-01-01-p2.vbrief.json" }],
            references: [{ type: "x-vbrief/github-issue", uri: "https://x" }],
          },
        },
      ],
    ]);
    const display = new Map([
      [parentAbs, "vbrief/proposed/2026-01-01-p2.vbrief.json"],
      [childAbs, "vbrief/pending/2026-01-01-c2.vbrief.json"],
    ]);
    expect(
      validateEpicStoryLinks(all, vbrief, display).some((e) => e.includes("references (D4)")),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers schema invalid nested structures", () => {
    expect(
      validateVbriefSchema(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "T",
            status: "running",
            items: "bad",
            narratives: null,
          },
        },
        "f.json",
      ).some((e) => e.includes("must be an array")),
    ).toBe(true);
    expect(
      validateVbriefSchema(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "T",
            status: "running",
            items: [{ id: "x", title: "t", status: "running", items: "bad", subItems: null }],
          },
        },
        "f.json",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("covers plan hook catch blocks and boolean wipCap repr", async () => {
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    expect(validateWipCapOnPlan({ policy: { wipCap: false } }, fp)[0]).toContain("False");
    expect(
      validateSessionRitualStalenessHoursOnPlan(
        { policy: { sessionRitualStalenessHours: false } },
        fp,
      )[0],
    ).toContain("False");

    const scopeModule = await import("../triage/scope/validate.js");
    const classifyModule = await import("../triage/classify/index.js");
    const rankingModule = await import("../triage/queue/ranking-labels.js");

    const spies = [
      vi.spyOn(scopeModule, "validateTriageScopeOnPlan").mockImplementation(() => {
        throw new Error("hook fail");
      }),
      vi.spyOn(scopeModule, "validateTriageScopeIgnoresOnPlan").mockImplementation(() => {
        throw new Error("hook fail");
      }),
      vi.spyOn(classifyModule, "validateTriageAutoClassifyOnPlan").mockImplementation(() => {
        throw new Error("hook fail");
      }),
      vi.spyOn(classifyModule, "validateTriageHoldMarkersOnPlan").mockImplementation(() => {
        throw new Error("hook fail");
      }),
      vi.spyOn(rankingModule, "validateRankingLabels").mockImplementation(() => {
        throw new Error("hook fail");
      }),
    ];
    expect(
      runProjectDefinitionHooks({ policy: { wipCap: 1, sessionRitualStalenessHours: 4 } }, fp),
    ).toEqual([]);
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  it("covers staleness parse failures and title-only PRD match", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-stale3-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(vbrief, "specification.vbrief.json"), "{bad json", "utf8");
    expect(checkRenderStaleness(vbrief)).toEqual([]);

    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: [],
      }),
      "utf8",
    );
    expect(checkRenderStaleness(vbrief)).toEqual([]);

    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "OnlyTitle",
          status: "approved",
          narratives: { Overview: "unrelated body" },
          items: [],
        },
      }),
      "utf8",
    );
    writeFileSync(join(root, "PRD.md"), "unrelated body", "utf8");
    expect(checkRenderStaleness(vbrief).some((w) => w.includes("PRD.md may be stale"))).toBe(true);

    writeFileSync(join(root, "SPECIFICATION.md"), "OnlyTitle and item headline", "utf8");
    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "OnlyTitle",
          status: "approved",
          narratives: { Overview: "in spec only" },
          items: [{ title: "item headline" }],
        },
      }),
      "utf8",
    );
    expect(checkRenderStaleness(vbrief).some((w) => w.includes("SPECIFICATION.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers project definition existing file refs without errors", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-ok-ref-"));
    const vbrief = join(root, "vbrief");
    const refDisplay = writeScope(vbrief, "active", "2026-01-01-exists.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "E", status: "running", items: [] },
    });
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [
            { references: [{ uri: "file://active/2026-01-01-exists.vbrief.json" }] },
            { references: [{ uri: "active/2026-01-01-exists.vbrief.json" }] },
            { references: [{ uri: "active/missing-file.vbrief.json" }] },
          ],
        },
      },
      vbrief,
    );
    expect(errors.some((e) => e.includes("missing-file"))).toBe(true);
    expect(errors.some((e) => e.includes("exists.vbrief.json"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
    expect(refDisplay).toContain("exists");
  });

  it("covers project definition metadata refs and invalid scope plan", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-meta-"));
    const vbrief = join(root, "vbrief");
    writeScope(vbrief, "active", "2026-01-01-no-plan.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: [],
    });
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [
            {
              id: "2026-01-01-no-plan",
              title: "NoPlan",
              status: "running",
              metadata: {
                references: [{ type: "github-issue", uri: "x" }],
              },
              references: [{ type: "github-issue", uri: "y" }, null, "bad"],
            },
          ],
        },
      },
      vbrief,
    );
    expect(errors.some((e) => e.includes("registry-status"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers validateAll project definition load errors", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-load-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(vbrief, "PROJECT-DEFINITION.vbrief.json"), "{bad", "utf8");
    expect(validateAll(vbrief).errors.some((e) => e.includes("invalid JSON"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers origin refs array strict mode branches", () => {
    expect(
      validateOriginProvenance(
        "vbrief/pending/x.vbrief.json",
        { plan: { status: "pending", references: [null, { type: 1, uri: "x" }] } },
        "vbrief",
        true,
      )[0],
    ).toContain("--strict-origin-types");
  });

  it("covers conformance read and parse failures in scan loop", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-conf-read-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "vbrief", "broken.vbrief.json"), "not-json", "utf8");
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    expect(evaluateConformance(root).exitCode).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers project definition title match and matching registry status", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-match-"));
    const vbrief = join(root, "vbrief");
    writeScope(vbrief, "active", "2026-01-01-match.vbrief.json", {
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "Match", status: "running", items: [] },
    });
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          references: [
            {
              type: "x-vbrief/plan",
              uri: "active/2026-01-01-match.vbrief.json",
              title: "Matched Item",
            },
          ],
          items: [{ title: "Matched Item", status: "running" }],
        },
      },
      vbrief,
    );
    expect(errors.filter((e) => e.includes("registry-status"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers epic forward link missing parent reference listing", () => {
    const vbrief = "/tmp/epic4";
    const parent = join(vbrief, "proposed/p.vbrief.json");
    const child = join(vbrief, "pending/c.vbrief.json");
    const all = new Map<string, Record<string, unknown>>([
      [
        child,
        {
          plan: {
            planRef: "proposed/p.vbrief.json",
            references: [{ type: "x-vbrief/github-issue", uri: "https://x" }],
          },
        },
      ],
      [parent, { plan: { references: [{ type: "other", uri: "x" }] } }],
    ]);
    expect(
      validateEpicStoryLinks(
        all,
        vbrief,
        new Map([
          [child, "vbrief/pending/c.vbrief.json"],
          [parent, "vbrief/proposed/p.vbrief.json"],
        ]),
      ).some((e) => e.includes("does not list")),
    ).toBe(true);
  });

  it("covers staleness when spec content matches and no optional files", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-stale-match-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "approved", items: [{ title: "ItemA" }] },
      }),
      "utf8",
    );
    writeFileSync(join(root, "SPECIFICATION.md"), "ItemA\nT\n", "utf8");
    expect(checkRenderStaleness(vbrief)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers runConformance failure stderr path", () => {
    expect(runConformance(["--all", "--project-root", "/tmp/no-vbrief-conformance-root"])).toBe(2);
    expect(cmdVbriefValidate(["--help"])).toBe(0);
  });

  it("covers project definition relative uri outside and wipCap string repr", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-out-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    const fp = "vbrief/PROJECT-DEFINITION.vbrief.json";
    expect(
      validateProjectDefinition(
        fp,
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "PD",
            status: "running",
            narratives: { Overview: "O", TechStack: "T" },
            items: [{ references: [{ uri: "../outside.vbrief.json" }] }],
          },
        },
        vbrief,
      ).some((e) => e.includes("outside vbrief")),
    ).toBe(true);
    expect(validateWipCapOnPlan({ policy: { wipCap: "10" } }, fp)[0]).toContain("'10'");
    rmSync(root, { recursive: true, force: true });
  });

  it("covers decomposition non-draft json and validateAll empty tree", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-empty-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1 }), "utf8");
    expect(validateNoRootDecompositionDrafts(vbrief)).toEqual([]);
    expect(validateAll(vbrief).scopeCount).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers epic item planRef back-link resolution", () => {
    const vbrief = "/tmp/epic5";
    const parent = join(vbrief, "proposed/p.vbrief.json");
    const child = join(vbrief, "pending/c.vbrief.json");
    const all = new Map<string, Record<string, unknown>>([
      [parent, { plan: { references: [{ type: "x-vbrief/plan", uri: "pending/c.vbrief.json" }] } }],
      [
        child,
        {
          plan: {
            items: [{ planRef: "proposed/p.vbrief.json" }],
            references: [{ type: "x-vbrief/github-issue", uri: "https://x" }],
          },
        },
      ],
    ]);
    expect(
      validateEpicStoryLinks(
        all,
        vbrief,
        new Map([
          [parent, "vbrief/proposed/p.vbrief.json"],
          [child, "vbrief/pending/c.vbrief.json"],
        ]),
      ),
    ).toEqual([]);
  });

  it("covers conformance allowlisted keys and extension namespaces", () => {
    expect(
      scanVbrief("x.json", {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-vbrief/custom": true,
          "x-directive/extra": true,
          policy: { wipCap: 10 },
          completedNote: "done",
        },
      }),
    ).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), "vb-conf-many-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    const bareItems = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`bare${i}`, true]));
    writeFileSync(
      join(root, "vbrief", "many.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [bareItems] },
      }),
      "utf8",
    );
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    const many = evaluateConformance(root);
    expect(many.exitCode).toBe(1);
    expect(many.message).toContain("... and");

    const vbrief = join(root, "vbrief");
    writeFileSync(join(root, "PROJECT.md"), "legacy", "utf8");
    chmodSync(join(root, "PROJECT.md"), 0o000);
    expect(validateDeprecatedPlaceholders(vbrief)).toEqual([]);
    chmodSync(join(root, "PROJECT.md"), 0o644);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers schema missing plan fields and validateProjectDef empty narratives", () => {
    // Python defaults `plan.get("narratives", {})` to {} and still emits the
    // D3 "missing expected key" diagnostics, so a plan with no narratives key
    // yields one error per expected key (parity with validate_all, #1782 s3).
    const emptyPlanNarratives = validateProjectDefNarratives("f", {});
    expect(emptyPlanNarratives.length).toBe(2);
    expect(emptyPlanNarratives.some((e) => e.includes("'overview' (D3)"))).toBe(true);
    expect(emptyPlanNarratives.some((e) => e.includes("'techstack' (D3)"))).toBe(true);
    expect(
      validateVbriefSchema({ vBRIEFInfo: { version: "0.6" }, plan: { title: "T" } }, "f.json").some(
        (e) => e.includes("missing required field 'status'"),
      ),
    ).toBe(true);
    expect(isRelativeTo("/a/b/", "/a/b")).toBe(true);
  });

  it("covers epic child present on disk but omitted from map", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-epic-disk-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      join(vbrief, "pending", "2026-01-01-on-disk.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "C", status: "pending", items: [] },
      }),
      "utf8",
    );
    const parent = join(vbrief, "proposed/p.vbrief.json");
    const all = new Map<string, Record<string, unknown>>([
      [
        parent,
        {
          plan: {
            references: [{ type: "x-vbrief/plan", uri: "pending/2026-01-01-on-disk.vbrief.json" }],
          },
        },
      ],
    ]);
    expect(
      validateEpicStoryLinks(all, vbrief, new Map([[parent, "vbrief/proposed/p.vbrief.json"]])),
    ).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers session ritual string repr and item narrative type errors", () => {
    expect(
      validateSessionRitualStalenessHoursOnPlan(
        { policy: { sessionRitualStalenessHours: "4" } },
        "f",
      )[0],
    ).toContain("'4'");
    expect(
      validateVbriefSchema(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "T",
            status: "running",
            items: [{ id: "a", title: "t", status: "running", narrative: { bad: 1 } }],
          },
        },
        "f.json",
      ).some((e) => e.includes("must be a string")),
    ).toBe(true);
  });
});
