import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodebaseMapCli } from "./map.js";
import { checkCodebaseMapFresh, runCodebaseMapFreshCli } from "./map-fresh.js";

function writeProject(root: string): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Fixture",
        status: "running",
        items: [],
        architecture: {
          codeStructure: {
            version: "0.1",
            modules: [
              {
                id: "app",
                name: "App",
                purpose: "Application entry points.",
                pathGlobs: ["app/**/*.py"],
              },
            ],
            pathOwnership: [],
            allowedPatterns: [],
            projectionManifest: [
              {
                path: ".planning/codebase/MAP.md",
                kind: "codebase-map",
                source: "plan.architecture.codeStructure",
                generated: true,
              },
            ],
          },
        },
      },
    }),
    { encoding: "utf8" },
  );
}

function writeCode(root: string, body = "print('hello')\n"): void {
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "main.py"), body, { encoding: "utf8" });
}

describe("codebase MAP freshness", () => {
  it("passes after generation", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-map-fresh-"));
    writeProject(root);
    writeCode(root);
    expect(runCodebaseMapCli(["--project-root", root]).exitCode).toBe(0);

    expect(runCodebaseMapFreshCli(["--project-root", root]).exitCode).toBe(0);
  });

  it("fails when projection is tampered", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-map-fresh-"));
    writeProject(root);
    writeCode(root);
    expect(runCodebaseMapCli(["--project-root", root]).exitCode).toBe(0);
    const output = join(root, ".planning", "codebase", "MAP.md");
    writeFileSync(output, `${readFileSync(output, { encoding: "utf8" })}\nmanual drift\n`, {
      encoding: "utf8",
    });

    const errors = checkCodebaseMapFresh(root, { outputPath: ".planning/codebase/MAP.md" });

    expect(errors).toEqual([
      `generated codebase MAP is stale; run \`task codebase:map\` to refresh ${output}`,
    ]);
  });

  it("fails when source digest changes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-map-fresh-"));
    writeProject(root);
    writeCode(root);
    expect(runCodebaseMapCli(["--project-root", root]).exitCode).toBe(0);
    writeCode(root, "print('changed')\n");

    expect(runCodebaseMapFreshCli(["--project-root", root]).exitCode).toBe(1);
  });

  it("treats a missing projection as fresh (on-demand artifact, #1932)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-map-fresh-"));
    writeProject(root);
    writeCode(root);

    const errors = checkCodebaseMapFresh(root, { outputPath: ".planning/codebase/MAP.md" });

    expect(errors).toEqual([]);
  });
});
