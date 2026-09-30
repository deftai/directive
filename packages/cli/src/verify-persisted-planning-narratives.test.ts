import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordProductMutationCompletion } from "@deftai/directive-core/check";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-persisted-planning-narratives.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "verify-pd-planning-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  return root;
}

function writeEmptyPd(root: string): void {
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "t", created: "2026-09-30T00:00:00Z" },
      plan: {
        title: "t",
        status: "running",
        narratives: { Overview: "", "tech stack": "" },
        items: [],
      },
    }),
    "utf8",
  );
}

describe("verify:persisted-planning-narratives CLI (#5176)", () => {
  it("parseArgs reads --project-root and --check-conjunct", () => {
    expect(parseArgs(["--project-root", "/tmp/demo"]).projectRoot).toBe("/tmp/demo");
    expect(parseArgs(["--project-root=/tmp/demo"]).projectRoot).toBe("/tmp/demo");
    expect(parseArgs(["--check-conjunct"]).checkConjunct).toBe(true);
    expect(parseArgs([]).checkConjunct).toBe(false);
  });

  it("fails closed on empty Overview+tech stack", () => {
    const root = tempRoot();
    writeEmptyPd(root);
    expect(run(["--project-root", root])).toBe(1);
  });

  it("passes when one tracked field is non-empty", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "t", created: "2026-09-30T00:00:00Z" },
        plan: {
          title: "t",
          status: "running",
          narratives: { Overview: "Ship the demo", "tech stack": "" },
          items: [],
        },
      }),
      "utf8",
    );
    expect(run(["--project-root", root])).toBe(0);
  });

  it("--check-conjunct passes scaffold-empty without marker and missing PD", () => {
    const scaffold = tempRoot();
    writeEmptyPd(scaffold);
    expect(run(["--project-root", scaffold, "--check-conjunct"])).toBe(0);

    const missing = tempRoot();
    expect(run(["--project-root", missing, "--check-conjunct"])).toBe(0);
    // Unconditional setup bar still exits 2 on missing PD.
    expect(run(["--project-root", missing])).toBe(2);
  });

  it("--check-conjunct refuses empty Overview+tech stack when product-mutation marker is present", () => {
    const root = tempRoot();
    writeEmptyPd(root);
    recordProductMutationCompletion(root, new Date("2026-09-30T12:00:00Z"));
    expect(run(["--project-root", root, "--check-conjunct"])).toBe(1);
  });
});
