import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignSpecNarratives, ingestSpecNarratives, parseSpecTasks } from "./fidelity.js";
import { runParityScenario } from "./parity-scenarios.js";
import {
  loadSafetyManifest,
  nowUtcIso,
  rollback,
  SafetyManifest,
  writeSafetyManifest,
} from "./safety.js";
import {
  acceptanceTextsFromItems,
  asStrList,
  deprecatedSubitemsIssues,
  itemHasAcceptance,
  itemHasTraces,
  itemsHaveAcceptance,
  missingRequiredSwarmFields,
} from "./story-quality.js";
import {
  finalizeMigration,
  isolateInvalidOutput,
  setValidateAllForTests,
  slugifyId,
} from "./validation.js";

describe("vbrief-validation coverage boost", () => {
  it("covers story-quality helpers", () => {
    expect(asStrList(null)).toEqual([]);
    expect(asStrList("  hi ")).toEqual(["hi"]);
    expect(
      acceptanceTextsFromItems([
        { narrative: { Acceptance: " ok " }, items: [{ narrative: { Acceptance: "child" } }] },
      ]),
    ).toEqual(["ok", "child"]);
    expect(itemHasAcceptance({ narrative: { Acceptance: "x" } })).toBe(true);
    expect(itemHasTraces({ narrative: { Traces: "FR-1" } })).toBe(true);
    expect(itemsHaveAcceptance([{ narrative: { Acceptance: "x" } }])).toBe(true);
    expect(missingRequiredSwarmFields({})).toContain("plan.metadata.swarm.file_scope");
    expect(deprecatedSubitemsIssues([{ subItems: [] }])).toContain(
      "plan.items[0].subItems is deprecated; use items",
    );
  });

  it("covers fidelity branches", () => {
    expect(parseSpecTasks("## Other\n\nNo tasks\n")).toEqual([]);
    expect(alignSpecNarratives(null)).toEqual({});
    expect(ingestSpecNarratives("## Summary\n\nBody\n")[0]).toHaveProperty("Overview");
  });

  it("covers validation finalize/isolate branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-boost-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    setValidateAllForTests(() => [["bad"], []]);
    const stderr: string[] = [];
    const [ok, actions] = finalizeMigration(root, vbrief, ["seed"], {
      stderrWriter: (c) => stderr.push(c),
      isolateInvalid: () => join(root, "outside.invalid"),
    });
    expect(ok).toBe(false);
    expect(actions.some((a) => a.includes("outside.invalid"))).toBe(true);
    setValidateAllForTests(null);
    expect(isolateInvalidOutput(root, join(root, "missing"))).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("covers safety manifest IO and rollback branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-safety-boost-"));
    mkdirSync(join(root, "vbrief", "migration"), { recursive: true });
    const manifest = new SafetyManifest({ backups: [] });
    writeSafetyManifest(root, manifest, { dryRun: true });
    writeSafetyManifest(root, manifest, { dryRun: false });
    expect(loadSafetyManifest(root)).not.toBeNull();
    expect(nowUtcIso()).toMatch(/Z$/);
    const [ok] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers CLI all-mode and unknown scenario", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-cli-all-"));
    expect(runParityScenario("unknown-scenario", { fixtureRoot: root }).ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("slugify handles long collision base", () => {
    const existing = new Set<string>();
    const first = slugifyId("a".repeat(100), existing);
    const second = slugifyId("a".repeat(100), existing);
    expect(first.length).toBeLessThanOrEqual(80);
    expect(second).not.toBe(first);
  });
});
