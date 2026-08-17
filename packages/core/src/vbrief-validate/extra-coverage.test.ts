import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  validateForgeOutageRetryMinutesOnPlan,
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

// chmod-based tests don't reliably block access on Windows; skip there.
const itChmod = it.skipIf(process.platform === "win32");

function writeScope(
  vbrief: string,
  folder: string,
  name: string,
  body: Record<string, unknown>,
): string {
  const dir = join(vbrief, folder);
  mkdirSync(dir, { recursive: true });
  const display = `xbrief/${folder}/${name}`;
  writeFileSync(join(dir, name), JSON.stringify(body), "utf8");
  return display;
}

describe("vbrief-validate extra coverage", () => {
  it("covers paths helpers", () => {
    expect(isRelativeTo("/a/b", "/a")).toBe(true);
    expect(isRelativeTo("/a", "/a")).toBe(true);
    expect(resolveRefPath("file://active/x.xbrief.json", "/vb")).toContain("active");
    expect(resolveRefPath("https://x", "/vb")).toBeNull();
    expect(resolveRefPath("#1", "/vb")).toBeNull();
    expect(resolveRefPath("pending/x.xbrief.json", "/vb")).toContain("pending");
    expect(scopeIdsForRefUri("2026-01-01-my-slug.xbrief.json").has("my-slug")).toBe(true);
    expect(scopeIdsForRefUri("file://2026-01-01-other.xbrief.json").has("other")).toBe(true);
    expect(scopeIdsForRefUri("plain-name").has("plain-name")).toBe(true);
    expect(lifecycleFolderFor("/proj/xbrief/active/x.xbrief.json", "/proj/xbrief")).toBe("active");
    expect(lifecycleFolderFor("/proj/xbrief/x.xbrief.json", "/proj/xbrief")).toBeNull();
    expect(displayPath("/proj/xbrief/active/x.xbrief.json", "/proj/xbrief")).toBe(
      "xbrief/active/x.xbrief.json",
    );
  });

  it("covers folder status allowed and edge branches", () => {
    expect(
      validateFolderStatus("xbrief/unknown/x.xbrief.json", { plan: { status: "x" } }, "xbrief"),
    ).toEqual([]);
    expect(validateFolderStatus("xbrief/active/x.xbrief.json", {}, "xbrief")).toEqual([]);
    expect(
      validateFolderStatus("xbrief/active/x.xbrief.json", { plan: { status: null } }, "xbrief"),
    ).toEqual([]);
    expect(
      validateFolderStatus(
        "xbrief/completed/x.xbrief.json",
        { plan: { status: "completed" } },
        "xbrief",
      ),
    ).toEqual([]);
    // Mismatch branch: running under completed/ (pairs with #3242 folder/status gate).
    const mismatch = validateFolderStatus(
      "xbrief/completed/x.xbrief.json",
      { plan: { status: "running" } },
      "xbrief",
    );
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]).toContain("running");
    expect(mismatch[0]).toContain("completed/");
    // plan as array / non-object
    expect(
      validateFolderStatus(
        "xbrief/active/x.xbrief.json",
        { plan: [] as unknown as object },
        "xbrief",
      ),
    ).toEqual([]);
    expect(
      validateFolderStatus(
        "xbrief/active/x.xbrief.json",
        { plan: "nope" as unknown as object },
        "xbrief",
      ),
    ).toEqual([]);
  });

  it("covers displayPath and lifecycleFolderFor residual edges (#3242 headroom)", () => {
    expect(lifecycleFolderFor("/proj/xbrief/pending/a.xbrief.json", "/proj/xbrief")).toBe(
      "pending",
    );
    expect(lifecycleFolderFor("/proj/xbrief/cancelled/a.xbrief.json", "/proj/xbrief")).toBe(
      "cancelled",
    );
    expect(displayPath("/proj/xbrief/pending/a.xbrief.json", "/proj/xbrief")).toContain(
      "pending/a.xbrief.json",
    );
    expect(scopeIdsForRefUri("file://pending/2026-01-01-story.xbrief.json").has("story")).toBe(
      true,
    );
    expect(scopeIdsForRefUri("2026-01-01-story.xbrief.json").has("2026-01-01-story")).toBe(true);
  });

  it("covers filename convention branches", () => {
    expect(matchesFilenameConvention("bad.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-abc-.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-abc--def.xbrief.json")).toBe(false);
    expect(matchesFilenameConvention("2026-01-01-abc-def.xbrief.json")).toBe(true);
    expect(validateFilename("xbrief/active/not-a-date.xbrief.json")[0]).toContain("(D7)");
  });

  it("covers schema nested items and project def narratives", () => {
    expect(normalizeNarrativeKey("Tech Stack")).toBe("techstack");
    expect(
      validateProjectDefNarratives("xbrief/PROJECT-DEFINITION.xbrief.json", {
        narratives: { Overview: "O" },
      }).some((e) => e.includes("techstack")),
    ).toBe(true);
    const nested = validateVbriefSchema(
      {
        xBRIEFInfo: { version: "0.8" },
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
    const vbrief = join(root, "xbrief");
    const scopeDisplay = writeScope(vbrief, "active", "2026-01-01-scope.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "S", status: "blocked", items: [] },
    });
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
    const pd = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "PD",
        status: "running",
        narratives: { Overview: "O", TechStack: "T" },
        references: [
          { type: "x-vbrief/plan", uri: "active/2026-01-01-scope.xbrief.json", title: "Scope" },
        ],
        items: [
          {
            id: "2026-01-01-scope",
            title: "Scope",
            status: "running",
            metadata: {
              source_path: "active/2026-01-01-scope.xbrief.json",
              references: [{ type: "x-vbrief/plan", uri: "active/2026-01-01-scope.xbrief.json" }],
            },
            references: [{ uri: "active/missing-scope.xbrief.json" }],
          },
          { references: [{ uri: "file://../outside.xbrief.json" }] },
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
    const vbrief = join(root, "xbrief");
    const parentAbs = join(vbrief, "proposed", "2026-01-01-parent.xbrief.json");
    const childAbs = join(vbrief, "pending", "2026-01-01-child.xbrief.json");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      parentAbs,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "P",
          status: "proposed",
          items: [],
          references: [{ type: "x-vbrief/plan", uri: "pending/2026-01-01-child.xbrief.json" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      childAbs,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "C",
          status: "pending",
          items: [{ planRef: "proposed/2026-01-01-parent.xbrief.json" }],
          planRef: "proposed/2026-01-01-parent.xbrief.json",
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
      [parentAbs, "xbrief/proposed/2026-01-01-parent.xbrief.json"],
      [childAbs, "xbrief/pending/2026-01-01-child.xbrief.json"],
    ]);
    expect(validateEpicStoryLinks(all, vbrief, display)).toEqual([]);

    all.set(childAbs, { plan: { references: [] } });
    expect(
      validateEpicStoryLinks(all, vbrief, display).some((e) => e.includes("planRef back")),
    ).toBe(true);

    all.set(childAbs, {
      plan: {
        planRef: "proposed/missing-parent.xbrief.json",
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
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(root, "children.json"), JSON.stringify({ children: {} }), "utf8");
    writeFileSync(join(root, "broken.json"), "{", "utf8");
    expect(validateNoRootDecompositionDrafts(vbrief)[0]).toContain("decomposition draft");
    writeFileSync(join(root, "PROJECT.md"), "legacy content", "utf8");
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.xbrief.json -->\n",
      "utf8",
    );
    expect(validateDeprecatedPlaceholders(vbrief).some((w) => w.includes("PROJECT.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers staleness branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-stale2-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
    expect(validateWipCapOnPlan({ policy: { wipCap: true } }, fp)[0]).toContain("bool");
    expect(validateWipCapOnPlan({ policy: { wipCap: null } }, fp)).toEqual([]);
    expect(
      validateSessionRitualStalenessHoursOnPlan(
        { policy: { sessionRitualStalenessHours: null } },
        fp,
      ),
    ).toEqual([]);
    expect(
      validateForgeOutageRetryMinutesOnPlan({ policy: { forgeOutageRetryMinutes: null } }, fp),
    ).toEqual([]);
    expect(
      validateForgeOutageRetryMinutesOnPlan({ policy: { forgeOutageRetryMinutes: 4 } }, fp)[0],
    ).toContain("#3422");
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
      validateOriginProvenance("xbrief/pending/x.xbrief.json", strict, "xbrief", true),
    ).toEqual([]);
    const legacyPrefix = {
      plan: { status: "pending", references: [{ type: "github-issue-v2", uri: "x" }] },
    };
    expect(
      validateOriginProvenance("xbrief/pending/y.xbrief.json", legacyPrefix, "xbrief"),
    ).toEqual([]);
    const badRef = { plan: { status: "pending", references: [{ type: 1, uri: "x" }] } };
    expect(validateOriginProvenance("xbrief/pending/z.xbrief.json", badRef, "xbrief")[0]).toContain(
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
    const first = findings[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error("expected at least one finding");
    }
    expect(renderFinding(first)).toContain("bare key");

    const root = mkdtempSync(join(tmpdir(), "vb-conf-full-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    writeFileSync(
      join(root, "xbrief", "bad.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", items: [], customBare: true },
      }),
      "utf8",
    );
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    const bad = evaluateConformance(root);
    expect(bad.exitCode).toBe(1);
    writeFileSync(join(root, "allow.txt"), "xbrief/bad.xbrief.json\n# comment\n", "utf8");
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
    const vbrief = join(root, "xbrief");
    writeScope(vbrief, "active", "2026-01-01-good.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "G",
        status: "running",
        items: [],
        references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/x/y/issues/1" }],
      },
    });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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
    const vbrief = join(root, "xbrief");
    writeScope(vbrief, "active", "2026-01-01-linked.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Linked", status: "running", items: [] },
    });
    writeScope(vbrief, "pending", "2026-01-01-valid-ref.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Valid", status: "pending", items: [] },
    });
    writeFileSync(join(vbrief, "broken-scope.xbrief.json"), "{bad", "utf8");
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
    const pd = {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "PD",
        status: "running",
        narratives: { Overview: "O", TechStack: "T" },
        references: [
          { type: "x-vbrief/plan", uri: "https://github.com/x", title: "Remote" },
          { type: "x-vbrief/plan", uri: "#local", title: "Hash" },
          { type: "x-vbrief/plan", uri: "missing/nowhere.xbrief.json", title: "Missing" },
          { type: "x-vbrief/plan", uri: "active/2026-01-01-linked.xbrief.json", title: "Linked" },
        ],
        items: [
          { status: 1 },
          "not-an-object",
          {
            id: "2026-01-01-valid-ref",
            title: "Valid",
            status: "pending",
            references: [{ uri: "pending/2026-01-01-valid-ref.xbrief.json" }],
          },
          {
            title: "BrokenScope",
            status: "running",
            metadata: { source_path: "broken-scope.xbrief.json" },
          },
          { references: [{ uri: "file://pending/2026-01-01-valid-ref.xbrief.json" }] },
          { references: [{ uri: "../outside.xbrief.json" }] },
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
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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

  itChmod("covers validateAll read errors and warnings-as-errors CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-read-err-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    const unreadable = join(vbrief, "pending", "2026-01-01-unreadable.xbrief.json");
    writeFileSync(unreadable, "{}", "utf8");
    chmodSync(unreadable, 0o000);
    const { errors } = validateAll(vbrief);
    chmodSync(unreadable, 0o644);
    expect(errors.some((e) => e.includes("cannot read"))).toBe(true);

    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(
      join(vbrief, "active", "2026-01-01-warn.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "W", status: "running", items: [], references: [] },
      }),
      "utf8",
    );
    expect(runValidate(["--vbrief-dir", vbrief, "--warnings-as-errors"])).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers epic link on-disk child and item planRef paths", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-epic2-"));
    const vbrief = join(root, "xbrief");
    const parentAbs = join(vbrief, "proposed", "2026-01-01-p2.xbrief.json");
    const childAbs = join(vbrief, "pending", "2026-01-01-c2.xbrief.json");
    const orphanAbs = join(vbrief, "pending", "2026-01-01-orphan.xbrief.json");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      orphanAbs,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "O", status: "pending", items: [] },
      }),
      "utf8",
    );
    const all = new Map<string, Record<string, unknown>>([
      [
        parentAbs,
        {
          plan: {
            references: [{ type: "x-vbrief/plan", uri: "pending/2026-01-01-orphan.xbrief.json" }],
          },
        },
      ],
      [
        childAbs,
        {
          plan: {
            items: [{ planRef: "proposed/2026-01-01-p2.xbrief.json" }],
            references: [{ type: "x-vbrief/github-issue", uri: "https://x" }],
          },
        },
      ],
    ]);
    const display = new Map([
      [parentAbs, "xbrief/proposed/2026-01-01-p2.xbrief.json"],
      [childAbs, "xbrief/pending/2026-01-01-c2.xbrief.json"],
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
          xBRIEFInfo: { version: "0.8" },
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
          xBRIEFInfo: { version: "0.8" },
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
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
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
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(vbrief, "specification.xbrief.json"), "{bad json", "utf8");
    expect(checkRenderStaleness(vbrief)).toEqual([]);

    writeFileSync(
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: [],
      }),
      "utf8",
    );
    expect(checkRenderStaleness(vbrief)).toEqual([]);

    writeFileSync(
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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

  it("skips non-string and blank narrative values when checking PRD staleness", () => {
    // Covers the `typeof value === "string"` and `value.trim()` sub-branches
    // in checkPrdStaleness -- non-string / blank narrative entries never
    // trigger a staleness warning by themselves.
    const root = mkdtempSync(join(tmpdir(), "vb-stale4-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "",
          status: "approved",
          narratives: { Count: 3, Blank: "   " },
          items: [],
        },
      }),
      "utf8",
    );
    writeFileSync(join(root, "PRD.md"), "some content", "utf8");
    expect(checkRenderStaleness(vbrief)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers project definition existing file refs without errors", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-ok-ref-"));
    const vbrief = join(root, "xbrief");
    const refDisplay = writeScope(vbrief, "active", "2026-01-01-exists.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "E", status: "running", items: [] },
    });
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [
            { references: [{ uri: "file://active/2026-01-01-exists.xbrief.json" }] },
            { references: [{ uri: "active/2026-01-01-exists.xbrief.json" }] },
            { references: [{ uri: "active/missing-file.xbrief.json" }] },
          ],
        },
      },
      vbrief,
    );
    expect(errors.some((e) => e.includes("missing-file"))).toBe(true);
    expect(errors.some((e) => e.includes("exists.xbrief.json"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
    expect(refDisplay).toContain("exists");
  });

  it("covers project definition metadata refs and invalid scope plan", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-meta-"));
    const vbrief = join(root, "xbrief");
    writeScope(vbrief, "active", "2026-01-01-no-plan.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: [],
    });
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        xBRIEFInfo: { version: "0.8" },
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
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(vbrief, "PROJECT-DEFINITION.xbrief.json"), "{bad", "utf8");
    expect(validateAll(vbrief).errors.some((e) => e.includes("invalid JSON"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers origin refs array strict mode branches", () => {
    expect(
      validateOriginProvenance(
        "xbrief/pending/x.xbrief.json",
        { plan: { status: "pending", references: [null, { type: 1, uri: "x" }] } },
        "xbrief",
        true,
      )[0],
    ).toContain("--strict-origin-types");
  });

  it("covers conformance read and parse failures in scan loop", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-conf-read-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "xbrief", "broken.xbrief.json"), "not-json", "utf8");
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    expect(evaluateConformance(root).exitCode).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers project definition title match and matching registry status", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-match-"));
    const vbrief = join(root, "xbrief");
    writeScope(vbrief, "active", "2026-01-01-match.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Match", status: "running", items: [] },
    });
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
    const errors = validateProjectDefinition(
      fp,
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          references: [
            {
              type: "x-vbrief/plan",
              uri: "active/2026-01-01-match.xbrief.json",
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

  it("allows terminal project items to reference terminal child scopes", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-terminal-"));
    const vbrief = join(root, "xbrief");
    writeScope(vbrief, "completed", "2026-01-01-done-child.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Done Child", status: "completed", items: [] },
    });
    writeScope(vbrief, "completed", "2026-01-01-failed-child.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Failed Child", status: "failed", items: [] },
    });
    const errors = validateProjectDefinition(
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          references: [
            {
              type: "x-vbrief/plan",
              uri: "completed/2026-01-01-done-child.xbrief.json",
              title: "Terminal Epic",
            },
          ],
          items: [
            {
              title: "Terminal Epic",
              status: "cancelled",
              metadata: {
                references: [
                  {
                    type: "x-vbrief/plan",
                    uri: "completed/2026-01-01-failed-child.xbrief.json",
                  },
                ],
              },
            },
          ],
        },
      },
      vbrief,
    );
    expect(errors.filter((e) => e.includes("registry-status"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("allows non-terminal project items to reference completed child scopes", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-nonterminal-"));
    const vbrief = join(root, "xbrief");
    writeScope(vbrief, "completed", "2026-01-01-child.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Child", status: "completed", items: [] },
    });
    const errors = validateProjectDefinition(
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [
            {
              title: "Proposed Parent",
              status: "proposed",
              metadata: {
                references: [
                  { type: "x-vbrief/plan", uri: "completed/2026-01-01-child.xbrief.json" },
                ],
              },
            },
          ],
        },
      },
      vbrief,
    );
    expect(errors.filter((e) => e.includes("registry-status"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps project source_path status checks exact for terminal scopes", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-source-exact-"));
    const vbrief = join(root, "xbrief");
    writeScope(vbrief, "completed", "2026-01-01-source.xbrief.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "Source", status: "completed", items: [] },
    });
    const errors = validateProjectDefinition(
      "xbrief/PROJECT-DEFINITION.xbrief.json",
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "PD",
          status: "running",
          narratives: { Overview: "O", TechStack: "T" },
          items: [
            {
              title: "Source",
              status: "cancelled",
              metadata: {
                source_path: "completed/2026-01-01-source.xbrief.json",
                references: [
                  { type: "x-vbrief/plan", uri: "completed/2026-01-01-source.xbrief.json" },
                ],
              },
            },
          ],
        },
      },
      vbrief,
    );
    expect(errors.some((e) => e.includes("registry-status"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers epic forward link missing parent reference listing", () => {
    const vbrief = resolve("/tmp/epic4");
    const parent = join(vbrief, "proposed", "p.xbrief.json");
    const child = join(vbrief, "pending", "c.xbrief.json");
    const all = new Map<string, Record<string, unknown>>([
      [
        child,
        {
          plan: {
            planRef: "proposed/p.xbrief.json",
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
          [child, "xbrief/pending/c.xbrief.json"],
          [parent, "xbrief/proposed/p.xbrief.json"],
        ]),
      ).some((e) => e.includes("does not list")),
    ).toBe(true);
  });

  it("covers staleness when spec content matches and no optional files", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-stale-match-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
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
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    const fp = "xbrief/PROJECT-DEFINITION.xbrief.json";
    expect(
      validateProjectDefinition(
        fp,
        {
          xBRIEFInfo: { version: "0.8" },
          plan: {
            title: "PD",
            status: "running",
            narratives: { Overview: "O", TechStack: "T" },
            items: [{ references: [{ uri: "../outside.xbrief.json" }] }],
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
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1 }), "utf8");
    expect(validateNoRootDecompositionDrafts(vbrief)).toEqual([]);
    expect(validateAll(vbrief).scopeCount).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers epic item planRef back-link resolution", () => {
    const vbrief = resolve("/tmp/epic5");
    const parent = join(vbrief, "proposed", "p.xbrief.json");
    const child = join(vbrief, "pending", "c.xbrief.json");
    const all = new Map<string, Record<string, unknown>>([
      [parent, { plan: { references: [{ type: "x-vbrief/plan", uri: "pending/c.xbrief.json" }] } }],
      [
        child,
        {
          plan: {
            items: [{ planRef: "proposed/p.xbrief.json" }],
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
          [parent, "xbrief/proposed/p.xbrief.json"],
          [child, "xbrief/pending/c.xbrief.json"],
        ]),
      ),
    ).toEqual([]);
  });

  it("covers namespaced Category B keys and extension namespaces", () => {
    // Post-#1650: the two Category B keys MUST be namespaced under x-directive/.
    expect(
      scanVbrief("x.json", {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          "x-vbrief/custom": true,
          "x-directive/extra": true,
          "x-directive/policy": { wipCap: 10 },
          "x-directive/completedNote": "done",
        },
      }),
    ).toEqual([]);

    // The previously-grandfathered bare forms now FAIL conformance (#1650).
    const bareFindings = scanVbrief("bare.json", {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { wipCap: 10 },
        completedNote: "done",
      },
    });
    expect(bareFindings.map((f) => f.key).sort()).toEqual(["completedNote", "policy"]);

    const root = mkdtempSync(join(tmpdir(), "vb-conf-many-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    const bareItems = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`bare${i}`, true]));
    writeFileSync(
      join(root, "xbrief", "many.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", items: [bareItems] },
      }),
      "utf8",
    );
    execSync("git add -A", { cwd: root, stdio: "ignore" });
    const many = evaluateConformance(root);
    expect(many.exitCode).toBe(1);
    expect(many.message).toContain("... and");

    const vbrief = join(root, "xbrief");
    writeFileSync(join(root, "PROJECT.md"), "legacy", "utf8");
    if (process.platform !== "win32") {
      chmodSync(join(root, "PROJECT.md"), 0o000);
      expect(validateDeprecatedPlaceholders(vbrief)).toEqual([]);
      chmodSync(join(root, "PROJECT.md"), 0o644);
    }
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
      validateVbriefSchema({ xBRIEFInfo: { version: "0.8" }, plan: { title: "T" } }, "f.json").some(
        (e) => e.includes("missing required field 'status'"),
      ),
    ).toBe(true);
    expect(isRelativeTo("/a/b/", "/a/b")).toBe(true);
  });

  it("covers epic child present on disk but omitted from map", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-epic-disk-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "pending"), { recursive: true });
    writeFileSync(
      join(vbrief, "pending", "2026-01-01-on-disk.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "C", status: "pending", items: [] },
      }),
      "utf8",
    );
    const parent = join(vbrief, "proposed/p.xbrief.json");
    const all = new Map<string, Record<string, unknown>>([
      [
        parent,
        {
          plan: {
            references: [{ type: "x-vbrief/plan", uri: "pending/2026-01-01-on-disk.xbrief.json" }],
          },
        },
      ],
    ]);
    expect(
      validateEpicStoryLinks(all, vbrief, new Map([[parent, "xbrief/proposed/p.xbrief.json"]])),
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
      validateForgeOutageRetryMinutesOnPlan({ policy: { forgeOutageRetryMinutes: "15" } }, "f")[0],
    ).toContain("'15'");
    expect(
      validateForgeOutageRetryMinutesOnPlan({ policy: { forgeOutageRetryMinutes: true } }, "f")[0],
    ).toContain("True");
    expect(
      validateVbriefSchema(
        {
          xBRIEFInfo: { version: "0.8" },
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
