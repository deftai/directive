import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_SUFFIXES,
  hasArtifactSuffix,
  isLifecycleArtifactPath,
  LIFECYCLE_DIR_NAMES,
  projectDefinitionFilename,
  projectDefinitionRelPath,
  resolveAuditDir,
  resolveAuditPath,
  resolveEvalDir,
  resolveEvalPath,
  resolveLifecycleFolder,
  resolveLifecycleLayout,
  resolveLifecycleRoot,
  resolveProjectDefinitionPath,
  specArtifactRelPath,
  stripArtifactSuffix,
} from "./resolve.js";

describe("layout resolution (#2109 part 1)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "layout-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedVbrief(): void {
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "2026-06-30-story.vbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
  }

  function seedXbrief(): void {
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "2026-06-30-story.xbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
  }

  it("throws with a migration hint when only vbrief/ is present (#2112)", () => {
    seedVbrief();
    expect(() => resolveLifecycleLayout(root)).toThrow(/deft migrate:xbrief/);
    expect(() => resolveLifecycleLayout(root)).toThrow(/No xbrief\/ layout found/);
    expect(() => resolveLifecycleRoot(root)).toThrow(/deft migrate:xbrief/);
  });

  it("returns the xbrief layout when an xbrief/ tree with .xbrief.json files exists", () => {
    seedXbrief();
    const layout = resolveLifecycleLayout(root);
    expect(layout.artifactDir).toBe("xbrief");
    expect(layout.artifactSuffix).toBe(".xbrief.json");
    expect(layout.infoRootKey).toBe("xBRIEFInfo");
    expect(layout.migrated).toBe(true);
    expect(layout.root).toBe(join(root, "xbrief"));
  });

  it("prefers xbrief/ when BOTH layouts are present", () => {
    seedVbrief();
    seedXbrief();
    const layout = resolveLifecycleLayout(root);
    expect(layout.artifactDir).toBe("xbrief");
    expect(layout.migrated).toBe(true);
  });

  it("throws when xbrief/ exists but has no .xbrief.json artifacts and only vbrief/ has content (#2112)", () => {
    seedVbrief();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    // Only a legacy-suffixed file under xbrief/ -- not a migrated artifact.
    writeFileSync(join(root, "xbrief", "active", "stray.vbrief.json"), "{}", "utf8");
    expect(() => resolveLifecycleLayout(root)).toThrow(/deft migrate:xbrief/);
  });

  it("throws with a migration hint when neither layout is present (#2112)", () => {
    expect(() => resolveLifecycleLayout(root)).toThrow(/No xbrief\/ layout found/);
    expect(() => resolveLifecycleLayout(root)).toThrow(/deft migrate:xbrief/);
  });
});

describe("artifact suffix helpers (#2109 part 1)", () => {
  it("recognizes both artifact suffixes", () => {
    expect(hasArtifactSuffix("2026-06-30-x.vbrief.json")).toBe(true);
    expect(hasArtifactSuffix("2026-06-30-x.xbrief.json")).toBe(true);
    expect(hasArtifactSuffix("README.md")).toBe(false);
    expect(hasArtifactSuffix("plan.json")).toBe(false);
  });

  it("strips whichever artifact suffix is present", () => {
    expect(stripArtifactSuffix("2026-06-30-x.vbrief.json")).toBe("2026-06-30-x");
    expect(stripArtifactSuffix("2026-06-30-x.xbrief.json")).toBe("2026-06-30-x");
    expect(stripArtifactSuffix("PROJECT-DEFINITION.xbrief.json")).toBe("PROJECT-DEFINITION");
    expect(stripArtifactSuffix("no-suffix.json")).toBe("no-suffix.json");
  });

  it("accepts both lifecycle roots and both suffixes for artifact paths", () => {
    expect(isLifecycleArtifactPath("vbrief/active/2026-06-30-x.vbrief.json")).toBe(true);
    expect(isLifecycleArtifactPath("xbrief/active/2026-06-30-x.xbrief.json")).toBe(true);
    // Mixed tree: either suffix under either root validates.
    expect(isLifecycleArtifactPath("xbrief/active/2026-06-30-x.vbrief.json")).toBe(true);
    expect(isLifecycleArtifactPath("vbrief/active/2026-06-30-x.xbrief.json")).toBe(true);
    // Not a lifecycle artifact.
    expect(isLifecycleArtifactPath("docs/notes.vbrief.json")).toBe(false);
    expect(isLifecycleArtifactPath("vbrief/active/README.md")).toBe(false);
  });

  it("exposes stable preference-ordered constants", () => {
    expect([...LIFECYCLE_DIR_NAMES]).toEqual(["xbrief", "vbrief"]);
    expect([...ARTIFACT_SUFFIXES]).toEqual([".xbrief.json", ".vbrief.json"]);
  });
});

describe("layout-aware path helpers (#2109 part 2a)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "layout-paths-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedVbrief(): void {
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "s.vbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
  }

  function seedXbrief(): void {
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "s.xbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
  }

  it("throws on a pure vbrief/ tree -- no fallback read path after #2112", () => {
    seedVbrief();
    expect(() => resolveLifecycleFolder(root, "pending")).toThrow(/deft migrate:xbrief/);
    expect(() => resolveEvalDir(root)).toThrow(/deft migrate:xbrief/);
    expect(() => resolveAuditDir(root)).toThrow(/deft migrate:xbrief/);
    expect(() => resolveProjectDefinitionPath(root)).toThrow(/deft migrate:xbrief/);
    expect(() => projectDefinitionFilename(root)).toThrow(/deft migrate:xbrief/);
    expect(() => projectDefinitionRelPath(root)).toThrow(/deft migrate:xbrief/);
  });

  it("resolves the same helpers under xbrief once the migrated tree exists", () => {
    seedXbrief();
    expect(resolveLifecycleFolder(root, "pending")).toBe(join(root, "xbrief", "pending"));
    expect(resolveEvalPath(root, "results", "ledger.json")).toBe(
      join(root, "xbrief", ".eval", "results", "ledger.json"),
    );
    expect(resolveAuditPath(root, "pending-human-decisions.jsonl")).toBe(
      join(root, "xbrief", ".audit", "pending-human-decisions.jsonl"),
    );
    expect(resolveProjectDefinitionPath(root)).toBe(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    );
    expect(projectDefinitionFilename(root)).toBe("PROJECT-DEFINITION.xbrief.json");
    expect(projectDefinitionRelPath(root)).toBe("xbrief/PROJECT-DEFINITION.xbrief.json");
  });

  it("resolveLifecycleRoot equals the resolved layout root under the xbrief layout", () => {
    seedXbrief();
    expect(resolveLifecycleRoot(root)).toBe(resolveLifecycleLayout(root).root);
    expect(resolveLifecycleRoot(root)).toBe(join(root, "xbrief"));
  });

  it("specArtifactRelPath returns xbrief/specification.xbrief.json path under the migrated layout", () => {
    seedXbrief();
    expect(specArtifactRelPath(root)).toBe("xbrief/specification.xbrief.json");
  });

  it("projectDefinitionFilename falls back to canonical name when no layout exists at all", () => {
    // Covers the catch-block return path (line 206) -- empty dir, no vbrief/ and no xbrief/.
    expect(projectDefinitionFilename(root)).toBe("PROJECT-DEFINITION.xbrief.json");
  });
});
