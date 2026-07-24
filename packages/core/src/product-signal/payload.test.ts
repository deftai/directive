import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION,
  readSkillsSummarySidecar,
  validateProductSignalPayload,
} from "./payload.js";
import { assembleProductSignalPayload } from "./submit.js";

// Synthetic GitHub PAT-shaped token split across literals (#2792 / #1070 precedent).
const SYNTHETIC_GHP_TOKEN = `ghp_${"1234567890123456789012345678901234"}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function basePayload(root: string) {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{}", "utf8");
  return assembleProductSignalPayload(root, { surface: "pulse" });
}

describe("validateProductSignalPayload", () => {
  it("rejects secret-shaped free text", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-payload-"));
    roots.push(root);
    const payload = assembleProductSignalPayload(root, {
      surface: "pulse",
      human: {
        nps: 8,
        answers: [],
        freeText: `token ${SYNTHETIC_GHP_TOKEN}`,
      },
    });
    expect(validateProductSignalPayload(payload).length).toBeGreaterThan(0);
    expect(payload.schemaVersion).toBe(PRODUCT_SIGNAL_PAYLOAD_SCHEMA_VERSION);
  });

  it("accepts valid minimal payload", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-payload-ok-"));
    roots.push(root);
    const payload = basePayload(root);
    expect(validateProductSignalPayload(payload)).toEqual([]);
  });

  it("rejects bad schemaVersion and surface", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-payload-bad-"));
    roots.push(root);
    const payload = basePayload(root);
    const bad = {
      ...payload,
      schemaVersion: 2 as typeof payload.schemaVersion,
      surface: "bad" as typeof payload.surface,
      installId: "  ",
      actorName: "",
    };
    const errors = validateProductSignalPayload(bad);
    expect(errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    expect(errors.some((e) => e.includes("surface"))).toBe(true);
    expect(errors.some((e) => e.includes("installId"))).toBe(true);
    expect(errors.some((e) => e.includes("actorName"))).toBe(true);
  });

  it("rejects too many answers and empty q/a", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-payload-ans-"));
    roots.push(root);
    const payload = basePayload(root);
    const bad = {
      ...payload,
      human: {
        nps: null,
        answers: [
          { q: "", a: "x" },
          { q: "q", a: "" },
          { q: "q2", a: "a2" },
          { q: "q3", a: "a3" },
          { q: "q4", a: "a4" },
        ],
        freeText: null,
      },
    };
    const errors = validateProductSignalPayload(bad);
    expect(errors.length).toBeGreaterThan(2);
  });

  it("rejects oversize freeText and agentNotes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-payload-size-"));
    roots.push(root);
    const payload = basePayload(root);
    const big = "x".repeat(5000);
    const bad = {
      ...payload,
      human: { ...payload.human, freeText: big },
      agentNotes: "y".repeat(3000),
    };
    const errors = validateProductSignalPayload(bad);
    expect(errors.some((e) => e.includes("freeText"))).toBe(true);
    expect(errors.some((e) => e.includes("agentNotes"))).toBe(true);
  });

  it("rejects bad human nps values", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-payload-nps-"));
    roots.push(root);
    const payload = basePayload(root);
    expect(
      validateProductSignalPayload({ ...payload, human: { ...payload.human, nps: 11 } }).some((e) =>
        e.includes("human.nps"),
      ),
    ).toBe(true);
    expect(
      validateProductSignalPayload({ ...payload, human: { ...payload.human, nps: 1.5 } }).some(
        (e) => e.includes("human.nps"),
      ),
    ).toBe(true);
  });
});

describe("readSkillsSummarySidecar", () => {
  it("returns null when sidecar missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-skills-miss-"));
    roots.push(root);
    expect(readSkillsSummarySidecar(root)).toBeNull();
  });

  it("parses valid sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-skills-ok-"));
    roots.push(root);
    const cache = join(root, ".deft-cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(
      join(cache, "skills-telemetry.json"),
      JSON.stringify({
        top: [{ skill: "build", useCount: 3, viewCount: 1, lastUsed: "2026-07-21T12:00:00Z" }],
        skillCount: 1,
      }),
      "utf8",
    );
    const summary = readSkillsSummarySidecar(root);
    expect(summary?.top[0]?.skill).toBe("build");
    expect(summary?.skillCount).toBe(1);
  });

  it("returns null on invalid sidecar", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-skills-bad-"));
    roots.push(root);
    const cache = join(root, ".deft-cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "skills-telemetry.json"), "not-json", "utf8");
    expect(readSkillsSummarySidecar(root)).toBeNull();
    writeFileSync(join(cache, "skills-telemetry.json"), JSON.stringify([]), "utf8");
    expect(readSkillsSummarySidecar(root)).toBeNull();
    writeFileSync(
      join(cache, "skills-telemetry.json"),
      JSON.stringify({ top: [{ skill: "" }] }),
      "utf8",
    );
    expect(readSkillsSummarySidecar(root)?.top).toEqual([]);
  });

  it("uses explicit skillCount when provided", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ps-skills-count-"));
    roots.push(root);
    const cache = join(root, ".deft-cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(
      join(cache, "skills-telemetry.json"),
      JSON.stringify({
        top: [{ skill: "build", useCount: 1, viewCount: 0, lastUsed: null }],
        skillCount: 99,
      }),
      "utf8",
    );
    expect(readSkillsSummarySidecar(root)?.skillCount).toBe(99);
  });
});
