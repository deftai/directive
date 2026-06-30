import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_KEY_PATTERN, isExtensionKey } from "@deftai/directive-types";
import { describe, expect, it } from "vitest";
import { evaluateConformance } from "./conformance.js";
import {
  collectExtensionEntries,
  EXTENSION_CONFORMANCE_FIXTURES_DIR,
  evaluateExtensionRoundtrip,
  findExtensionPreservationViolations,
  reEmitVbriefArtifact,
  VbriefSchemaValidationError,
} from "./roundtrip.js";
import type { JsonObject } from "./schema.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES_DIR = join(REPO_ROOT, EXTENSION_CONFORMANCE_FIXTURES_DIR);

function loadFixture(name: string): JsonObject {
  const text = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(text) as JsonObject;
}

describe("extension round-trip preservation (#715)", () => {
  it("uses EXTENSION_KEY_PATTERN from @deftai/directive-types as the namespace oracle", () => {
    expect(isExtensionKey("x-stream/runtime")).toBe(true);
    expect(isExtensionKey("x-directive/trace")).toBe(true);
    expect(EXTENSION_KEY_PATTERN.test("x-stream/runtime")).toBe(true);
    expect(isExtensionKey("x-stream-foo")).toBe(false);
  });

  it("collects extension keys at root, plan, item, and nested value levels", () => {
    const artifact = loadFixture("extension-at-root.vbrief.json");
    const keys = collectExtensionEntries(artifact).map((entry) => entry.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "x-stream/runtime",
        "x-directive/trace",
        "x-directive/tracking",
        "x-acme/widget",
      ]),
    );
  });

  it("preserves nested extension keys inside extension values", () => {
    const artifact = loadFixture("nested-extension-value.vbrief.json");
    const roundtripped = reEmitVbriefArtifact(artifact, "nested-extension-value.vbrief.json");
    expect(findExtensionPreservationViolations(artifact, roundtripped)).toEqual([]);
    expect(
      collectExtensionEntries(roundtripped).some((entry) => entry.key === "x-stream/inner"),
    ).toBe(true);
  });

  it("round-trips every packaged fixture with JSON-structural extension equality", () => {
    const result = evaluateExtensionRoundtrip(REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("names dropped extension keys when preservation fails", () => {
    const artifact = loadFixture("extension-at-root.vbrief.json");
    const mutated = structuredClone(artifact) as JsonObject;
    delete (mutated as Record<string, unknown>)["x-directive/trace"];
    const violations = findExtensionPreservationViolations(artifact, mutated);
    expect(violations.some((v) => v.includes("x-directive/trace"))).toBe(true);
  });

  it("wires extension round-trip into evaluateConformance on the maintainer repo", () => {
    expect(existsSync(FIXTURES_DIR)).toBe(true);
    const result = evaluateConformance(REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("extension fixture(s) round-trip clean (#715)");
  });

  it("rejects invalid artifacts in reEmitVbriefArtifact before round-trip", () => {
    expect(() =>
      reEmitVbriefArtifact(
        { xBRIEFInfo: { version: "0.8" }, plan: { title: "T", status: "auto", items: [] } },
        "invalid-status.json",
      ),
    ).toThrow(VbriefSchemaValidationError);
  });

  it("skips extension round-trip when packaged fixtures are absent", () => {
    const result = evaluateExtensionRoundtrip("/tmp/no-extension-fixtures-root");
    expect(result.exitCode).toBe(0);
    expect(result.message).toBe("");
  });
});
