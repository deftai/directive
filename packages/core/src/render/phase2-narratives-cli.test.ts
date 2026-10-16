import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("project-write-narratives CLI (#4663 / #4961)", () => {
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

  it("merge-existing keeps absent fields and refuses stale expected-revision", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-merge-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const artifact = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const initial = {
      xBRIEFInfo: { version: "0.8", description: "seed" },
      plan: {
        title: "Keep",
        status: "running",
        narratives: {
          Overview: "Old O",
          TechStack: "Old T",
          Strategy: "Old S",
          Quality: "Old Q",
          ProjectRules: "Old R",
          Branching: "Old B",
        },
        items: [],
      },
    };
    writeFileSync(artifact, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    const revision = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    const partial = join(root, "partial.json");
    writeFileSync(partial, JSON.stringify({ Overview: "New O" }), "utf8");

    expect(
      writePhase2NarrativesMain([
        "--project-root",
        root,
        "--narratives-file",
        partial,
        "--merge-existing",
        "--expected-revision",
        revision,
      ]),
    ).toBe(0);
    const after = JSON.parse(readFileSync(artifact, "utf8")) as {
      plan: { narratives: Record<string, string> };
    };
    expect(after.plan.narratives.Overview).toBe("New O");
    expect(after.plan.narratives.Strategy).toBe("Old S");
    expect(after.plan.narratives.TechStack).toBe("Old T");

    expect(
      writePhase2NarrativesMain([
        "--project-root",
        root,
        "--narratives-file",
        partial,
        "--merge-existing",
        "--expected-revision",
        "deadbeef",
      ]),
    ).toBe(1);
  });

  it("refuses when an intervening writer changes the artifact before locked merge", () => {
    const root = mkdtempSync(join(tmpdir(), "phase2-race-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const artifact = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    const initial = {
      xBRIEFInfo: { version: "0.8", description: "seed" },
      plan: {
        title: "Keep",
        status: "running",
        narratives: {
          Overview: "Old O",
          TechStack: "Old T",
          Strategy: "Old S",
          Quality: "Old Q",
          ProjectRules: "Old R",
          Branching: "Old B",
        },
        items: [],
      },
    };
    writeFileSync(artifact, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    const approvedRevision = createHash("sha256").update(readFileSync(artifact)).digest("hex");

    // Intervening writer updates Strategy after the operator approved the prior revision.
    const raced = structuredClone(initial);
    raced.plan.narratives.Strategy = "Raced S";
    writeFileSync(artifact, `${JSON.stringify(raced, null, 2)}\n`, "utf8");

    const partial = join(root, "partial.json");
    writeFileSync(partial, JSON.stringify({ Overview: "New O" }), "utf8");
    expect(
      writePhase2NarrativesMain([
        "--project-root",
        root,
        "--narratives-file",
        partial,
        "--merge-existing",
        "--expected-revision",
        approvedRevision,
      ]),
    ).toBe(1);
    const after = JSON.parse(readFileSync(artifact, "utf8")) as {
      plan: { narratives: Record<string, string> };
    };
    expect(after.plan.narratives.Overview).toBe("Old O");
    expect(after.plan.narratives.Strategy).toBe("Raced S");
  });
});
