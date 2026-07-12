import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readRepoFile, resolveRepoPath } from "./helpers.js";

/** #2451: deprecated deft-* redirect stubs removed; successors are deft-directive-* only. */

const REMOVED_REDIRECT_STUBS = [
  "deft-sync",
  "deft-setup",
  "deft-build",
  "deft-review-cycle",
  "deft-roadmap-refresh",
  "deft-swarm",
  "deft-pre-pr",
  "deft-interview",
] as const;

describe("test_deprecated_skill_redirects", () => {
  it.each(REMOVED_REDIRECT_STUBS)("no_redirect_stub_directory_%s", (oldName) => {
    const bareDeft = readdirSync(resolveRepoPath("skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(bareDeft).not.toContain(oldName);
  });

  it("no_bare_deft_skill_directories", () => {
    const bareDeft = readdirSync(resolveRepoPath("skills"), { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() && d.name.startsWith("deft-") && !d.name.startsWith("deft-directive-"),
      )
      .map((d) => d.name);
    expect(bareDeft).toEqual([]);
  });

  it("readme_has_upgrade_banner", () => {
    expect(readRepoFile("README.md")).toContain("UPGRADING.md");
  });

  it("readme_banner_has_agent_rule", () => {
    const content = readRepoFile("README.md");
    expect(content.includes("Read [UPGRADING.md]") || content.includes("Read UPGRADING.md")).toBe(
      true,
    );
  });
});
