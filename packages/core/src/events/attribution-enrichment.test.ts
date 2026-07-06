import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ATTRIBUTION_SCHEMA_VERSION,
  buildAttributionEnrichment,
  INSTALL_ID_REL,
  resolveInstallId,
} from "./attribution-enrichment.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeTemp(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-attrib-enrich-"));
  temps.push(root);
  return root;
}

describe("resolveInstallId", () => {
  it("creates a stable id persisted in .deft-cache/install-id", () => {
    const root = makeTemp();
    const first = resolveInstallId(root);
    expect(first).not.toBeNull();
    expect(existsSync(join(root, INSTALL_ID_REL))).toBe(true);
    const second = resolveInstallId(root);
    expect(second).toBe(first);
  });

  it("returns null without throwing when the cache dir is unwritable", () => {
    const root = makeTemp();
    writeFileSync(join(root, ".deft-cache"), "not-a-directory", "utf8");
    expect(() => resolveInstallId(root)).not.toThrow();
    expect(resolveInstallId(root)).toBeNull();
  });
});

describe("buildAttributionEnrichment", () => {
  it("stamps repo, directive_version, install_id, and schema_version", () => {
    const root = makeTemp();
    const enrichment = buildAttributionEnrichment(root, {
      repoResolver: () => "deftai/directive",
    });
    expect(enrichment.repo).toBe("deftai/directive");
    expect(typeof enrichment.directive_version).toBe("string");
    expect(enrichment.directive_version.length).toBeGreaterThan(0);
    expect(enrichment.install_id).not.toBeNull();
    expect(enrichment.schema_version).toBe(ATTRIBUTION_SCHEMA_VERSION);
  });

  it("degrades repo to null when the resolver throws", () => {
    const root = makeTemp();
    const enrichment = buildAttributionEnrichment(root, {
      repoResolver: () => {
        throw new Error("git unavailable");
      },
    });
    expect(enrichment.repo).toBeNull();
    expect(enrichment.schema_version).toBe(ATTRIBUTION_SCHEMA_VERSION);
  });

  it("carries a null repo when no origin remote resolves", () => {
    const root = makeTemp();
    const enrichment = buildAttributionEnrichment(root, { repoResolver: () => null });
    expect(enrichment.repo).toBeNull();
  });

  it("memoizes per projectRoot with the default resolver to stay off the hot path (#2377)", () => {
    const root = makeTemp();
    const first = buildAttributionEnrichment(root);
    const second = buildAttributionEnrichment(root);
    expect(second).toBe(first);
  });

  it("a custom resolver bypasses the cache for deterministic tests (#2377)", () => {
    const root = makeTemp();
    const a = buildAttributionEnrichment(root, { repoResolver: () => "deftai/a" });
    const b = buildAttributionEnrichment(root, { repoResolver: () => "deftai/b" });
    expect(a.repo).toBe("deftai/a");
    expect(b.repo).toBe("deftai/b");
  });
});
