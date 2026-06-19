import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCliCapture } from "../../core/src/triage/scope/cli.js";
import { addLabelToScope } from "../../core/src/triage/scope/mutations.js";

function writePd(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { title: "T", status: "running", items: [], policy } }, null, 2)}\n`,
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
});

describe("triage-scope parity helpers", () => {
  it("normalizes volatile paths", async () => {
    const { normalizeOutput } = await import("./triage-scope-parity.js");
    expect(normalizeOutput("path=/tmp/foo/.deft-cache/github-issue/o/r/coverage.json")).toContain(
      "path=<ROOT>/coverage.json",
    );
  });
});
