import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateConformance } from "./conformance.js";
import { validateEpicStoryLinks } from "./epic-links.js";
import { validateFilename } from "./filename.js";
import { runConformance, runValidate } from "./main.js";
import { validateOriginProvenance } from "./origin.js";
import {
  validateSessionRitualStalenessHoursOnPlan,
  validateTriageRankingLabelsOnPlan,
  validateWipCapOnPlan,
} from "./plan-hooks.js";
import { isCurrentGeneratedSpecification } from "./precutover.js";
import { validateVbriefSchema } from "./schema.js";
import { checkRenderStaleness } from "./staleness.js";
import { discoverVbriefs, validateAll } from "./validate-all.js";

describe("vbrief-validate coverage boost", () => {
  it("exercises schema validation branches", () => {
    expect(
      validateVbriefSchema({}, "f.json").some((e) =>
        e.includes("missing required top-level key 'vBRIEFInfo'"),
      ),
    ).toBe(true);
    expect(
      validateVbriefSchema({ vBRIEFInfo: "x", plan: {} }, "f.json").some((e) =>
        e.includes("must be an object"),
      ),
    ).toBe(true);
    expect(
      validateVbriefSchema(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "",
            status: "running",
            items: [{ id: "a", status: "running" }],
            narratives: { x: 1 },
          },
        },
        "f.json",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateVbriefSchema(
        {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "T",
            status: "running",
            items: [{ id: "a", title: "t", status: "running", subItems: ["bad"] }],
          },
        },
        "f.json",
      ).some((e) => e.includes("subItems")),
    ).toBe(true);
  });

  it("exercises validate CLI success and failure paths", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-cov-cli-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(
      join(vbrief, "active", "2026-01-01-bad-status.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "proposed", items: [] },
      }),
      "utf8",
    );
    expect(runValidate(["--vbrief-dir", vbrief])).toBe(1);
    expect(runValidate(["-h"])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("exercises conformance config error branches", () => {
    expect(evaluateConformance("/tmp/no-vbrief-here", {}).exitCode).toBe(2);
    const root = mkdtempSync(join(tmpdir(), "vb-conf-err-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    expect(
      evaluateConformance(root, { allowListPath: join(root, "missing-allow.txt") }).exitCode,
    ).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it("exercises epic link backward and forward branches", () => {
    const vbrief = "/tmp/vb";
    const parent = join(vbrief, "proposed/parent.vbrief.json");
    const child = join(vbrief, "pending/child.vbrief.json");
    const all = new Map<string, Record<string, unknown>>([
      [
        parent,
        {
          plan: {
            references: [{ type: "x-vbrief/plan", uri: "pending/child.vbrief.json" }],
          },
        },
      ],
      [
        child,
        {
          plan: {
            references: [],
          },
        },
      ],
    ]);
    const display = new Map([
      [parent, "vbrief/proposed/parent.vbrief.json"],
      [child, "vbrief/pending/child.vbrief.json"],
    ]);
    expect(validateEpicStoryLinks(all, vbrief, display).length).toBeGreaterThan(0);
  });

  it("exercises validateAll load errors and discover", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-cov-all-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(join(vbrief, "active"), { recursive: true });
    writeFileSync(join(vbrief, "active", "2026-01-01-not-json.vbrief.json"), "{bad", "utf8");
    const { errors } = validateAll(vbrief);
    expect(errors.some((e) => e.includes("invalid JSON"))).toBe(true);
    expect(discoverVbriefs(vbrief).length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("exercises staleness and precutover generated spec branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-stale-"));
    const vbrief = join(root, "vbrief");
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(vbrief, folder), { recursive: true });
    }
    writeFileSync(
      join(vbrief, "specification.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "Title",
          status: "approved",
          narratives: { Overview: "X" },
          items: [{ title: "Item1" }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\nTitle\n",
      "utf8",
    );
    expect(
      isCurrentGeneratedSpecification(root, readFileSync(join(root, "SPECIFICATION.md"), "utf8")),
    ).toBe(true);
    expect(checkRenderStaleness(vbrief)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("exercises plan hook and origin edge branches", () => {
    expect(validateWipCapOnPlan(null, "f")).toEqual([]);
    expect(
      validateSessionRitualStalenessHoursOnPlan(
        { policy: { sessionRitualStalenessHours: true } },
        "f",
      )[0],
    ).toContain("integer");
    expect(
      validateTriageRankingLabelsOnPlan({ policy: { triageRankingLabels: "bad" } }, "f")[0],
    ).toContain("#1128");
    expect(validateOriginProvenance("vbrief/proposed/x.vbrief.json", {}, "vbrief")).toEqual([]);
    expect(validateFilename("vbrief/PROJECT-DEFINITION.vbrief.json")).toEqual([]);
    const legacyExt = {
      plan: {
        status: "pending",
        references: [{ type: "github-issue-v2", uri: "x" }],
      },
    };
    expect(validateOriginProvenance("vbrief/pending/l.vbrief.json", legacyExt, "vbrief")).toEqual(
      [],
    );
    const legacySlash = {
      plan: { status: "pending", references: [{ type: "github-issue/legacy", uri: "x" }] },
    };
    expect(validateOriginProvenance("vbrief/pending/s.vbrief.json", legacySlash, "vbrief")).toEqual(
      [],
    );
  });

  it("exercises staged conformance mode", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-staged-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    execSync("git init", { cwd: root, stdio: "ignore" });
    expect(runConformance(["--staged", "--project-root", root])).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
