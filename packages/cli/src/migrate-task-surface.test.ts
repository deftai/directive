import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import { repoRoot } from "./gates-cli/_helpers.js";

describe("migrate/install task surface (#2022 Phase 2 / #2068 cutoff)", () => {
  it("routes migrate:preflight, migrate:xbrief, and upgrade through native handlers", () => {
    expect(resolveCanonicalVerb("migrate:preflight")).toBe("migrate-preflight");
    expect(resolveCanonicalVerb("migrate:xbrief")).toBe("migrate-xbrief");
    expect(resolveCanonicalVerb("upgrade")).toBe("install-upgrade");
  });

  it("migrate.yml uses deft-ts preflight and xbrief migration handlers", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "migrate.yml"), "utf8");
    expect(text).toContain('bin.js" migrate-preflight');
    expect(text).toContain('bin.js" migrate-xbrief');
    expect(text).not.toContain("migrate_vbrief.py");
    expect(text).not.toContain("\n  vbrief:");
    expect(text).not.toContain("migrate_preflight.py");
  });

  it("install.yml upgrade avoids scripts/run.py and routes through the consumer-aware engine dispatch (#2054)", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "install.yml"), "utf8");
    expect(text).toContain(":engine:invoke");
    expect(text).toContain("ENGINE_CMD: 'install-upgrade");
    expect(text).not.toContain('run" upgrade');
    expect(text).not.toContain("scripts/run.py");
  });
});
