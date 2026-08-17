import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_GUARD_PIN_CONTENT_PYTHON } from "./core-guard-pin-content.js";
import { isUpgradePinPathContentAllowed } from "./hygiene.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("core-guard pin-content SoT (#3193 / #3427)", () => {
  it("matches the Go embed byte-for-byte", () => {
    const goEmbed = readFileSync(
      resolve(repoRoot, "cmd/deft-install/core_guard_pin_content.embed"),
      "utf8",
    );
    expect(CORE_GUARD_PIN_CONTENT_PYTHON).toBe(goEmbed);
  });

  it("is not a tracked .py file and still implements the pin-path SoT names", () => {
    expect(CORE_GUARD_PIN_CONTENT_PYTHON).not.toContain("core_guard_pin_content.py");
    expect(CORE_GUARD_PIN_CONTENT_PYTHON).toContain("is_dir_key");
    expect(CORE_GUARD_PIN_CONTENT_PYTHON).toContain("pkg_pin_only");
    expect(CORE_GUARD_PIN_CONTENT_PYTHON).toContain("npm_lock_ok");
    expect(CORE_GUARD_PIN_CONTENT_PYTHON).toContain("pnpm_ok");
    expect(CORE_GUARD_PIN_CONTENT_PYTHON).toContain("yarn_ok");
    expect(isUpgradePinPathContentAllowed("README.md", "a", "b")).toBe(false);
  });

  it("leaves no tracked .py files in this repo (#3427)", () => {
    const listed = execFileSync("git", ["ls-files", "*.py"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(listed).toBe("");
  });

  it("ci.yml does not invoke python3 for watchdog scripts", () => {
    const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toMatch(/python3\s+\.github\/scripts\//);
    expect(ci).toContain("node .github/scripts/classify-ci-job-state.mjs");
    expect(ci).toContain("node .github/scripts/cancel-queued-ci-primary.mjs");
    expect(ci).toContain("node .github/scripts/resolve-ci-authoritative-lane.mjs");
  });
});
