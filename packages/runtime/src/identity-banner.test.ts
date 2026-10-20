import { engineInfo } from "@deftai/directive-core";
import { describe, expect, it } from "vitest";
import { readCliPackageVersion } from "./cli-package-version.js";
import { CLI_PACKAGE, formatIdentityBanner, identityBanner } from "./identity-banner.js";
import { banner } from "./index.js";

/** Same first-semver extract as packages/core/src/session/active-cli.ts. */
const ACTIVE_CLI_FIRST_SEMVER = /\b(\d{1,6}\.\d{1,6}\.\d{1,6})\b/;
/** Same first-semver extract as packages/core/src/resolution/classify.ts. */
const CLASSIFY_FIRST_SEMVER = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

describe("formatIdentityBanner (#4766)", () => {
  it("names CLI package and engine, with the first semver the engine", () => {
    const line = formatIdentityBanner({
      cliVersion: "0.119.0",
      engineName: "@deftai/directive-core",
      engineVersion: "0.119.2",
    });
    expect(line).toBe(
      "@deftai/directive (engine: @deftai/directive-core@0.119.2; package: @deftai/directive@0.119.0)",
    );
    expect(ACTIVE_CLI_FIRST_SEMVER.exec(line)?.[1]).toBe("0.119.2");
    expect(CLASSIFY_FIRST_SEMVER.exec(line)?.[1]).toBe("0.119.2");
    expect(line).toContain(`${CLI_PACKAGE}@0.119.0`);
    expect(line).not.toMatch(/v0\.119\.0/);
  });

  it("still prints the CLI package version when it matches the engine", () => {
    const line = formatIdentityBanner({
      cliVersion: "0.119.0",
      engineName: "@deftai/directive-core",
      engineVersion: "0.119.0",
    });
    expect(line).toContain(`${CLI_PACKAGE}@0.119.0`);
    expect(line).toContain("@deftai/directive-core@0.119.0");
    expect(ACTIVE_CLI_FIRST_SEMVER.exec(line)?.[1]).toBe("0.119.0");
  });
});

describe("identityBanner (#4766)", () => {
  it("reads the installed CLI package.json the way core reads engine version", () => {
    const info = engineInfo();
    const cliVersion = readCliPackageVersion();
    expect(identityBanner()).toBe(
      formatIdentityBanner({
        cliVersion,
        engineName: info.name,
        engineVersion: info.version,
      }),
    );
    expect(banner()).toBe(identityBanner());
  });
});
