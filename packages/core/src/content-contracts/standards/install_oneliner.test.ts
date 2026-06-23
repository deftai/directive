import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_install_oneliner.py", () => {
  describe("TestFetchAndRunOneLiner", () => {
    it("test_references_releases_latest_download[README.md]", () => {
      expect(readText("README.md")).toContain("releases/latest/download");
    });
    it("test_runs_headless_flags[README.md]", () => {
      // npm is now the canonical headless install; Go installer one-liners are legacy
      expect(readText("README.md")).toContain("npm i -g @deftai/directive");
    });
    it("test_covers_each_platform_asset[README.md]", () => {
      const content = readText("README.md");
      expect(content).toContain("releases/latest/download/install-macos-universal");
      expect(content).toContain("releases/latest/download/install-linux-amd64");
      expect(content).toContain("releases/latest/download/install-windows-amd64.exe");
    });
    it("test_no_source_build_in_oneliner[README.md]", () => {
      const content = readText("README.md");
      const commandLines = content
        .split("\n")
        .filter((line) => line.includes("releases/latest/download/install-"));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) expect(line).not.toContain("go build");
    });
    it("test_references_releases_latest_download[QUICK-START.md]", () => {
      expect(readText("QUICK-START.md")).toContain("releases/latest/download");
    });
    it("test_runs_headless_flags[QUICK-START.md]", () => {
      expect(readText("QUICK-START.md")).toContain("--yes --repo-root . --json");
    });
    it("test_covers_each_platform_asset[QUICK-START.md]", () => {
      const content = readText("QUICK-START.md");
      expect(content).toContain("releases/latest/download/install-macos-universal");
      expect(content).toContain("releases/latest/download/install-linux-amd64");
      expect(content).toContain("releases/latest/download/install-windows-amd64.exe");
    });
    it("test_no_source_build_in_oneliner[QUICK-START.md]", () => {
      const content = readText("QUICK-START.md");
      const commandLines = content
        .split("\n")
        .filter((line) => line.includes("releases/latest/download/install-"));
      expect(commandLines.length).toBeGreaterThan(0);
      for (const line of commandLines) expect(line).not.toContain("go build");
    });
  });
});
