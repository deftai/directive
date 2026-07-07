import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodebaseMap, fileSha256 } from "./default-extractor.js";
import { ensureAscii } from "./json.js";
import {
  artifactSha256,
  loadProviderArtifactPolicy,
  selectCodebaseMap,
  validateProviderArtifact,
} from "./provider.js";

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

describe("artifactSha256 ensure_ascii parity with Python", () => {
  it("escapes non-ASCII to \\uXXXX like json.dumps(ensure_ascii=True)", () => {
    expect(ensureAscii('{"x":"café"}')).toBe('{"x":"caf\\u00e9"}');
    // astral characters become surrogate pairs, matching CPython's escaping
    expect(ensureAscii("🚀")).toBe("\\ud83d\\ude80");
    // ASCII (including DEL 0x7f) is left untouched
    expect(ensureAscii("a~\u007f")).toBe("a~\u007f");
  });

  it("matches the Python digest for non-ASCII artifacts", () => {
    // Golden computed independently from
    // json.dumps({sorted}, separators=(",",":"), ensure_ascii=True) bytes.
    const artifact = { name: "café", emoji: "🚀", nested: { ñ: "façade" } };
    expect(artifactSha256(artifact)).toBe(
      "2084406b6dbde39c466b1760f9ec3cc3c1c1dd706da698ac7683e52f116f19a6",
    );
  });
});

function writePolicyProject(root: string, policy: Record<string, unknown>): void {
  const vbrief = join(root, "xbrief");
  mkdirSync(vbrief, { recursive: true });
  writeFileSync(
    join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Fixture",
          status: "running",
          items: [],
          policy,
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

function artifactWithHash(root: string, relPath = "src/main.py"): Record<string, unknown> {
  const sourceFile = join(root, relPath);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(sourceFile, "print('hello')\n", { encoding: "utf8" });
  return {
    ...validArtifact(),
    provider: { name: "fixture-provider", version: "1.0" },
    source: {
      projectRoot: root,
      contentHashes: {
        algorithm: "sha256",
        files: [{ path: relPath, sha256: fileSha256(sourceFile) }],
      },
    },
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

  it("reads projection provider artifact policy", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-provider-policy-"));
    writePolicyProject(root, {
      projectionProviders: {
        "codebase-map": {
          artifactPath: ".planning/codebase/provider-map.json",
          expect: { provider: "fixture-provider", version: "1.0" },
        },
      },
    });

    const policy = loadProviderArtifactPolicy(root);

    expect(policy.artifact_path).toBe(".planning/codebase/provider-map.json");
    expect(policy.expect_provider).toBe("fixture-provider");
    expect(policy.expect_version).toBe("1.0");
    expect(policy.invalid_reason).toBeNull();
  });

  it("accepts a fresh policy artifact path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-provider-policy-"));
    const artifactPath = join(root, ".planning", "codebase", "provider-map.json");
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(artifactWithHash(root)), { encoding: "utf8" });
    writePolicyProject(root, {
      projectionProviders: {
        "codebase-map": {
          artifactPath: ".planning/codebase/provider-map.json",
          expect: { provider: "fixture-provider", version: "1.0" },
        },
      },
    });

    const selection = selectCodebaseMap(root);

    expect(selection.used_external_provider).toBe(true);
    expect((selection.artifact.provider as Record<string, unknown>).name).toBe("fixture-provider");
  });

  it("accepts an explicit absolute artifact path", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-provider-policy-"));
    const artifactPath = join(root, "provider-map.json");
    writeFileSync(artifactPath, JSON.stringify(artifactWithHash(root)), { encoding: "utf8" });
    writePolicyProject(root, {});

    const selection = selectCodebaseMap(root, null, { artifactPath });

    expect(selection.used_external_provider).toBe(true);
    expect(selection.fallback_reason).toBeNull();
  });

  it("falls back when policy artifact expectation mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-provider-policy-"));
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "codebase", "provider-map.json"),
      JSON.stringify(artifactWithHash(root)),
      { encoding: "utf8" },
    );
    writePolicyProject(root, {
      projectionProviders: {
        "codebase-map": {
          artifactPath: ".planning/codebase/provider-map.json",
          expect: { provider: "other-provider" },
        },
      },
    });

    const selection = selectCodebaseMap(root);

    expect(selection.used_external_provider).toBe(false);
    expect(selection.fallback_reason).toContain("provider artifact expectation mismatch");
  });

  it("falls back when policy artifact is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-provider-policy-"));
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "codebase", "provider-map.json"),
      JSON.stringify(artifactWithHash(root)),
      { encoding: "utf8" },
    );
    writeFileSync(join(root, "src", "main.py"), "print('changed')\n", { encoding: "utf8" });
    writePolicyProject(root, {
      projectionProviders: {
        "codebase-map": {
          artifactPath: ".planning/codebase/provider-map.json",
        },
      },
    });

    const selection = selectCodebaseMap(root);

    expect(selection.used_external_provider).toBe(false);
    expect(selection.fallback_reason).toContain("provider artifact is stale");
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
