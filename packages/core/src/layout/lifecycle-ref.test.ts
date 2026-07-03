import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVbriefRef } from "../scope/vbrief-ref.js";
import { resolveRefPath } from "../vbrief-validate/paths.js";
import { validateAll } from "../vbrief-validate/validate-all.js";
import { resolveLifecycleArtifactRef } from "./lifecycle-ref.js";

describe("resolveLifecycleArtifactRef (#1926)", () => {
  it("returns direct path when it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-ref-direct-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    const artifact = join(vbrief, "proposed", "2026-01-01-parent.xbrief.json");
    writeFileSync(artifact, "{}", "utf8");
    expect(resolveLifecycleArtifactRef("proposed/2026-01-01-parent.xbrief.json", vbrief)).toBe(
      resolve(artifact),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("searches lifecycle folders when folder-qualified ref dangles", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-ref-search-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "completed"), { recursive: true });
    const artifact = join(vbrief, "completed", "2026-01-01-parent.xbrief.json");
    writeFileSync(artifact, "{}", "utf8");
    expect(resolveLifecycleArtifactRef("proposed/2026-01-01-parent.xbrief.json", vbrief)).toBe(
      resolve(artifact),
    );
    expect(resolveRefPath("proposed/2026-01-01-parent.xbrief.json", vbrief)).toBe(
      resolve(artifact),
    );
    expect(resolveVbriefRef("proposed/2026-01-01-parent.xbrief.json", vbrief)).toBe(
      resolve(artifact),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("validates green after parent moves proposed to completed without rewriting child planRef", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-ref-validate-"));
    const vbrief = join(root, "xbrief");
    const parentName = "2026-01-01-11-umbrella.xbrief.json";
    const childName = "2026-01-01-11-child.xbrief.json";
    mkdirSync(join(vbrief, "proposed"), { recursive: true });
    mkdirSync(join(vbrief, "completed"), { recursive: true });

    const parentProposed = join(vbrief, "proposed", parentName);
    const parentCompleted = join(vbrief, "completed", parentName);
    const childPath = join(vbrief, "proposed", childName);

    writeFileSync(
      parentProposed,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Umbrella",
          status: "completed",
          items: [],
          references: [{ type: "x-xbrief/plan", uri: `proposed/${childName}` }],
        },
      }),
      "utf8",
    );
    writeFileSync(
      childPath,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Child",
          status: "proposed",
          items: [],
          planRef: `proposed/${parentName}`,
          references: [
            { type: "x-xbrief/github-issue", uri: "https://github.com/deftai/directive/issues/11" },
          ],
        },
      }),
      "utf8",
    );

    renameSync(parentProposed, parentCompleted);

    expect(resolveRefPath(`proposed/${parentName}`, vbrief)).toBe(resolve(parentCompleted));

    const { errors } = validateAll(vbrief);
    expect(errors).toEqual([]);

    rmSync(root, { recursive: true, force: true });
  });

  it("resolveRefPath searches lifecycle folders for file:// URIs after a move", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-ref-fileuri-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(join(vbrief, "completed"), { recursive: true });
    const artifact = join(vbrief, "completed", "2026-01-01-parent.xbrief.json");
    writeFileSync(artifact, "{}", "utf8");
    expect(resolveRefPath("file://proposed/2026-01-01-parent.xbrief.json", vbrief)).toBe(
      resolve(artifact),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("returns missing direct path when artifact is absent everywhere", () => {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-ref-missing-"));
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    const missing = resolveLifecycleArtifactRef("proposed/2026-01-01-missing.xbrief.json", vbrief);
    expect(existsSync(missing)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
