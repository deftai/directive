import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectInvariants, parseProjectInvariantsField } from "./project-invariants-io.js";

describe("loadProjectInvariants", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it("returns default when PROJECT-DEFINITION is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pinv-miss-"));
    roots.push(root);
    const loaded = loadProjectInvariants(root);
    expect(loaded.resolved.source).toBe("default");
    expect(loaded.resolved.invariants).toEqual([]);
    expect(loaded.resolved.error).toMatch(/PROJECT-DEFINITION not found/);
  });

  it("parses invariants and module path globs from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pinv-ok-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          policy: {
            projectInvariants: [
              {
                id: "host-load",
                statement: "Do not break host load.",
                moduleIds: ["host"],
              },
            ],
          },
          architecture: {
            codeStructure: {
              modules: [{ id: "host", pathGlobs: ["src/host/**"] }],
            },
          },
        },
      }),
      "utf8",
    );
    const loaded = loadProjectInvariants(root);
    expect(loaded.resolved.source).toBe("typed");
    expect(loaded.resolved.invariants[0]?.id).toBe("host-load");
    expect(loaded.modulePathGlobs.host).toEqual(["src/host/**"]);
  });

  it("returns default-on-error for invalid JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-pinv-bad-"));
    roots.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "{", "utf8");
    const loaded = loadProjectInvariants(root);
    expect(loaded.resolved.source).toBe("default-on-error");
    expect(loaded.resolved.invariants).toEqual([]);
  });

  it("re-exports parseProjectInvariantsField", () => {
    const parsed = parseProjectInvariantsField([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.invariants).toEqual([]);
  });
});
