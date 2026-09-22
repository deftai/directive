import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePhase2NarrativesMain } from "./phase2-narratives-cli.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("project-write-narratives CLI (#4663)", () => {
  it("prints usage and stores a flat narratives file", () => {
    expect(writePhase2NarrativesMain(["--help"])).toBe(0);
    const root = mkdtempSync(join(tmpdir(), "phase2-cli-"));
    temps.push(root);
    const file = join(root, "narratives.json");
    writeFileSync(
      file,
      JSON.stringify({
        Overview: "O",
        TechStack: "T",
        Strategy: "S",
        Quality: "Q",
        ProjectRules: "R",
        Branching: "B",
      }),
      "utf8",
    );
    expect(writePhase2NarrativesMain(["--project-root", root, "--narratives-file", file])).toBe(0);
    const written = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    ) as { plan: { narratives: { Overview: string }; policy?: unknown } };
    expect(written.plan.narratives.Overview).toBe("O");
    expect(written.plan.policy).toBeUndefined();
  });
});
