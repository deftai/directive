import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateConfidenceCorpus, run } from "./confidence.js";

function writeBrief(
  root: string,
  rel: string,
  status: string,
  confidence: string,
  extraNarratives: Record<string, unknown> = {},
): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: rel,
          status,
          narratives: { Confidence: confidence, ...extraNarratives },
          items: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("migrate:confidence (#5385)", () => {
  it("dry-run maps unambiguous leading-token prose and declines ambiguous", () => {
    const root = mkdtempSync(join(tmpdir(), "migrate-confidence-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
    writeBrief(
      root,
      "xbrief/active/high-prose.xbrief.json",
      "running",
      "High. The defect was reproduced.",
    );
    writeBrief(root, "xbrief/active/ambiguous.xbrief.json", "running", "Highly uncertain");
    writeBrief(root, "xbrief/active/exact.xbrief.json", "running", "medium");
    writeBrief(
      root,
      "xbrief/completed/historical.xbrief.json",
      "completed",
      "Low. parked note",
    );

    const dry = migrateConfidenceCorpus(root);
    expect(dry.dryRun).toBe(true);
    expect(dry.mapped.map((h) => h.path)).toEqual(["xbrief/active/high-prose.xbrief.json"]);
    expect(dry.mapped[0]?.to).toBe("high");
    expect(dry.mapped[0]?.residual).toBe("The defect was reproduced.");
    expect(dry.declined.some((h) => h.path.includes("ambiguous"))).toBe(true);
    expect(dry.changed).toEqual([]);
    // Historical excluded by default
    expect(dry.mapped.some((h) => h.path.includes("completed"))).toBe(false);

    const applied = migrateConfidenceCorpus(root, { apply: true });
    expect(applied.changed).toEqual(["xbrief/active/high-prose.xbrief.json"]);
    const rewritten = JSON.parse(
      readFileSync(join(root, "xbrief/active/high-prose.xbrief.json"), "utf8"),
    ) as { plan: { narratives: Record<string, string> } };
    expect(rewritten.plan.narratives.Confidence).toBe("high");
    expect(rewritten.plan.narratives.ConfidenceNote).toBe("The defect was reproduced.");

    const again = migrateConfidenceCorpus(root, { apply: true });
    expect(again.mapped).toEqual([]);
    expect(again.changed).toEqual([]);
  });

  it("help exits 0", () => {
    expect(run(["--help"])).toBe(0);
  });
});
