import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodebaseMap } from "./default-extractor.js";
import { validateProviderArtifact } from "./provider.js";

function validArtifact(): Record<string, unknown> {
  return {
    formatVersion: "codebase-map.v1",
    contractVersion: "codebase-provider.v1",
    kind: "codebase-map",
    provider: { name: "fixture-provider", version: "1.0" },
    source: { projectRoot: "/fixture" },
    modules: [
      {
        id: "app",
        files: ["app/main.py"],
        derivedFrom: { files: "provider", intent: "provider" },
      },
    ],
    coupling: [],
    entryPoints: [],
    languageDistribution: [{ language: "Python", files: 1, derivedFrom: "extension-heuristic" }],
    degraded: [],
  };
}

describe("codebase provider contract", () => {
  it("accepts a valid artifact", () => {
    expect(validateProviderArtifact(validArtifact())).toEqual([]);
  });

  it("reports contract mismatch", () => {
    const artifact = validArtifact();
    artifact.contractVersion = "wrong";
    artifact.modules = [];
    const errors = validateProviderArtifact(artifact);
    expect(errors.some((e) => e.includes("contractVersion"))).toBe(true);
    expect(errors.some((e) => e.includes("modules"))).toBe(true);
  });
});

describe("default extractor", () => {
  it("derives directory modules without codeStructure", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-extractor-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.py"), "print('hello')\n", { encoding: "utf8" });
    const artifact = buildCodebaseMap(root);
    expect(artifact.modules).toHaveLength(1);
    expect((artifact.modules as { id: string }[])[0]?.id).toBe("src");
  });
});
