import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlainSink } from "./output.js";
import { runLocalSignpostChecks } from "./signpost-checks.js";
import type { Finding } from "./types.js";

describe("runLocalSignpostChecks (#1997)", () => {
  it("warns on canonical-vendored deposit without npm-managed sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sp-"));
    try {
      const core = join(root, ".deft", "core");
      mkdirSync(core, { recursive: true });
      writeFileSync(join(core, "VERSION"), "tag: v0.56.0\nsha: abc\n", "utf8");
      writeFileSync(join(root, "AGENTS.md"), "Deft is installed in .deft/core/.\n", "utf8");
      const findings: Finding[] = [];
      runLocalSignpostChecks(root, createPlainSink(), (f) => findings.push(f));
      expect(findings.some((f) => f.check === "canonical-vendored-npm-signpost")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns on orphan .deft/VERSION legacy layout", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-sp-"));
    try {
      mkdirSync(join(root, ".deft"), { recursive: true });
      writeFileSync(join(root, ".deft", "VERSION"), "tag: v0.26.0\n", "utf8");
      const findings: Finding[] = [];
      runLocalSignpostChecks(root, createPlainSink(), (f) => findings.push(f));
      expect(findings.some((f) => f.check === "legacy-layout")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
