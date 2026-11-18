import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch, resolveCanonicalVerb } from "./dispatch.js";
import { repoRoot } from "./gates-cli/_helpers.js";

describe("migrate/install task surface (#2022 Phase 2 / #2068 cutoff)", () => {
  it("routes migrate:preflight, migrate:xbrief, and upgrade through native handlers", () => {
    expect(resolveCanonicalVerb("migrate:preflight")).toBe("migrate-preflight");
    expect(resolveCanonicalVerb("migrate:xbrief")).toBe("migrate-xbrief");
    expect(resolveCanonicalVerb("upgrade")).toBe("install-upgrade");
  });

  it("migrate.yml uses deft-ts preflight and xbrief migration handlers", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "migrate.yml"), "utf8");
    // #2126: migrate.yml dispatches through the guarded :engine:invoke pattern
    // (global-deft fallback on consumer deposits), not a direct dist/bin.js call.
    expect(text).toContain("ENGINE_CMD: 'migrate-preflight");
    expect(text).toContain("ENGINE_CMD: 'migrate-xbrief");
    expect(text).not.toContain("migrate_vbrief.py");
    expect(text).not.toContain("\n  vbrief:");
    expect(text).not.toContain("migrate_preflight.py");
  });

  it("install.yml upgrade is retired and names directive upgrade (#6022)", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "install.yml"), "utf8");
    expect(text).toContain("error: task upgrade is retired. Run: directive upgrade");
    expect(text).toContain("If the directive command is missing: npm i -g @deftai/directive");
    expect(text).not.toContain('run" upgrade');
    expect(text).not.toContain("scripts/run.py");
  });

  it("no tasks/*.yml file dispatches the retired install-upgrade / install-uninstall verbs (#6022)", () => {
    const dir = join(repoRoot(), "tasks");
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toContain("install-upgrade");
      expect(text, name).not.toContain("install-uninstall");
    }
  });
});

describe("runtime reply to upgrade (#6022)", () => {
  async function run(argv: string[]): Promise<{ code: number; err: string }> {
    let err = "";
    const code = await dispatch(argv, {
      writeOut: () => {},
      writeErr: (text) => {
        err += text;
      },
    });
    return { code, err };
  }

  it("names directive upgrade as the launcher command, without 'Did you mean'", async () => {
    const { code, err } = await run(["upgrade"]);
    expect(code).toBe(2);
    expect(err).toBe("'upgrade' is a launcher command. Run: directive upgrade\n");
    expect(err).not.toContain("Did you mean");
  });

  it.each([
    ["install-upgrade", " Did you mean: upgrade?"],
    ["install-uninstall", " Did you mean: uninstall?"],
  ])("keeps the retired %s refusal unchanged (AC13.6)", async (verb, suggestion) => {
    const { code, err } = await run([verb]);
    expect(code).toBe(2);
    expect(err).toBe(
      `Unknown command '${verb}'. Known installation commands: install, upgrade, uninstall, doctor.${suggestion}\n`,
    );
  });
});
