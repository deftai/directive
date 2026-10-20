import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliCapture } from "../../core/src/triage/scope/cli.js";
import { addLabelToScope } from "../../core/src/triage/scope/mutations.js";

function writePd(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "T", status: "running", items: [], policy } }, null, 2)}\n`,
    "utf8",
  );
}

describe("triage-scope CLI", () => {
  it("lists default scope and ignores", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-scope-"));
    writePd(root);
    const result = runCliCapture(["--project-root", root, "--list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("effective rules");
    expect(result.stdout).toContain("(none)");
  });

  it("add-label persists via mutation helper", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-scope-"));
    writePd(root);
    const [changed] = addLabelToScope(root, "priority:p0");
    expect(changed).toBe(true);
    const result = runCliCapture(["--project-root", root, "--list"]);
    expect(result.stdout).toContain("priority:p0");
  });

  it("set-preset small persists the preset via the shared writer", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-scope-"));
    writePd(root);
    const result = runCliCapture(["--project-root", root, "--set-preset", "small"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("set-preset");
    const listed = runCliCapture(["--project-root", root, "--list"]);
    expect(listed.stdout).toContain("all-open");
  });

  it("set-preset=mega form persists the mega scaffold to the namespaced key", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-scope-"));
    writePd(root);
    // mega ships an explicit-watch scaffold with empty issues; the preset write
    // is trusted and must report success (not fail the hand-edit validator).
    const result = runCliCapture(["--project-root", root, "--set-preset=mega"]);
    expect(result.code).toBe(0);
    const written: unknown = JSON.parse(
      readFileSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"), "utf8"),
    );
    if (written === null || typeof written !== "object") {
      throw new Error("expected PROJECT-DEFINITION to parse to an object");
    }
    const plan = (written as { plan: Record<string, Record<string, unknown>> }).plan;
    const scope = (plan["x-directive/policy"].triageScope as Array<Record<string, unknown>>) ?? [];
    expect(scope.map((r) => r.rule)).toContain("explicit-watch");
    expect(scope.map((r) => r.rule)).toContain("referenced-by-vbrief");
  });

  it("set-preset rejects an unknown preset key with the valid list", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-scope-"));
    writePd(root);
    const result = runCliCapture(["--project-root", root, "--set-preset", "huge"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown preset");
    expect(result.stderr).toContain("small");
  });

  it("set-preset is mutually exclusive with --add-label", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-scope-"));
    writePd(root);
    const result = runCliCapture([
      "--project-root",
      root,
      "--set-preset",
      "small",
      "--add-label",
      "x",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("mutually exclusive");
  });
});

describe("triage-scope parity helpers", () => {
  it("normalizes volatile paths", async () => {
    const { normalizeOutput } = await import("./triage-scope-fixtures.js");
    expect(normalizeOutput("path=/tmp/foo/.deft-cache/github-issue/o/r/coverage.json")).toContain(
      "path=<ROOT>/coverage.json",
    );
  });
});
