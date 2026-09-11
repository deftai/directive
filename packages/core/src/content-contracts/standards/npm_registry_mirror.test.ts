import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("corporate npm registry recovery guidance (#2808)", () => {
  it("documents diagnosis, one-shot recovery, and durable scoped routing", () => {
    const upgrading = readText("UPGRADING.md");

    expect(upgrading).toContain("### Corporate or mirrored npm registry");
    for (const token of [
      "npm config get @deftai:registry",
      "npm config get registry",
      "E404",
      "ETARGET",
      "--registry` does not beat `@deftai:registry",
      "--userconfig",
      "$HOME",
      "@deftai:registry=https://registry.npmjs.org/",
      "@deftai/directive",
      "@deftai/directive-core",
      "@deftai/directive-content",
      "@deftai/directive-types",
    ]) {
      expect(upgrading, `UPGRADING missing ${token}`).toContain(token);
    }
    expect(upgrading.toLowerCase()).toContain("silently");
    expect(upgrading.toLowerCase()).toMatch(/corporate policy|organization policy/);
    expect(upgrading).toMatch(/IT|registry administrator/);
  });

  it("keeps the cold-start README pointer thin and anchored", () => {
    const readme = readText("README.md");

    expect(readme).toContain("content/UPGRADING.md#corporate-or-mirrored-npm-registry");
    expect(readme).toContain("E404");
    expect(readme).toContain("ETARGET");
  });

  it("distinguishes offline npm config reads from explicit public-registry probes", () => {
    const contract = readText("tools/package-manager-network.md");

    expect(contract).toContain("npm config get @deftai:registry");
    expect(contract).toContain("offline");
    expect(contract).toContain("--userconfig");
    expect(contract).toContain("--ignore-scripts");
    expect(contract).toContain("`@scope:registry`");
    expect(contract).not.toContain(
      "The payload-staleness check is the only doctor path that shells out to npm",
    );
    expect(contract).not.toMatch(
      /pins `--registry=https:\/\/registry\.npmjs\.org\/` and `--ignore-scripts`, so a configured mirror cannot/,
    );
  });
});
