import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import { repoRoot } from "./gates-cli/_helpers.js";

describe("migrate/install task surface (#2022 Phase 2)", () => {
  it("routes migrate:preflight and upgrade through native handlers", () => {
    expect(resolveCanonicalVerb("migrate:preflight")).toBe("migrate-preflight");
    expect(resolveCanonicalVerb("upgrade")).toBe("install-upgrade");
  });

  it("migrate.yml uses deft-ts preflight and documents migrate_vbrief holdout", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "migrate.yml"), "utf8");
    expect(text).toContain('bin.js" migrate-preflight');
    expect(text).toContain("#2013 HOLDOUT");
    expect(text).toContain("migrate_vbrief.py");
    expect(text).not.toContain("migrate_preflight.py");
  });

  it("install.yml upgrade avoids scripts/run.py and routes through the consumer-aware engine dispatch (#2054)", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "install.yml"), "utf8");
    // #2054: dispatch goes through :engine:invoke (vendored bin.js in source
    // checkouts, global `deft` on npm consumer deposits) rather than an
    // unconditional `node bin.js` that fails on vendored installs.
    expect(text).toContain(":engine:invoke");
    expect(text).toContain("ENGINE_CMD: 'install-upgrade");
    expect(text).not.toContain('run" upgrade');
    expect(text).not.toContain("scripts/run.py");
  });
});
