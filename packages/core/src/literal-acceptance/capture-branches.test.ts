import { describe, expect, it } from "vitest";
import {
  captureLiteralAcceptanceCommands,
  captureLiteralAcceptanceCommandsDetailed,
  formatRejectedLedger,
} from "./capture.js";

/**
 * Capture-path branch matrix for fence / label / normalize edges (#3287 / #3267).
 */
describe("captureLiteralAcceptanceCommands branch matrix (#3287)", () => {
  it("strips surrounding backticks and preserves path tokens", () => {
    const cmds = captureLiteralAcceptanceCommands("verify: `task check`");
    expect(cmds.map((c) => c.command)).toContain("task check");
  });

  it("rejects oversized and multi-line command blobs", () => {
    const long = `verify: task check ${"x".repeat(520)}`;
    expect(captureLiteralAcceptanceCommands(long)).toEqual([]);
    const multi = "verify: task check\nstill going";
    // labeled line alone still captures the first line; ensure no invented multi-line blob
    const detailed = captureLiteralAcceptanceCommandsDetailed(multi);
    for (const c of detailed.commands) {
      expect(c.command.includes("\n")).toBe(false);
    }
  });

  it("extracts shell-looking commands under acceptance headings with fences", () => {
    const text = [
      "## Overview",
      "```bash",
      "task check",
      "```",
      "## Acceptance",
      "```sh",
      "$ task doctor",
      "> pnpm test",
      "# comment only",
      "",
      "```",
      "```python",
      "print(1)",
      "```",
      "```text",
      "pnpm run test",
      "```",
    ].join("\n");
    const detailed = captureLiteralAcceptanceCommandsDetailed(text);
    const cmds = detailed.commands.map((c) => c.command);
    // Fence under non-acceptance heading with requireRegion still may capture
    // globally via labeled/fenced passes — assert acceptance-region captures exist.
    expect(cmds.some((c) => c.includes("task doctor") || c.includes("pnpm"))).toBe(true);
  });

  it("handles ~~~ fences and fence langs with spaces as non-fences", () => {
    const text = ["~~~bash", "task check", "~~~", "```bash with args", "task doctor", "```"].join(
      "\n",
    );
    const cmds = captureLiteralAcceptanceCommands(text);
    expect(cmds.some((c) => c.command === "task check")).toBe(true);
  });

  it("parses numbered and bullet labeled lines plus mid-line verify:", () => {
    const text = [
      "1. verify: task check",
      "2) command: task doctor",
      "- run: pnpm test",
      "* check: task help",
      "Also run: verify: task --version",
      "$ task verify:branch",
      "> pnpm --version",
    ].join("\n");
    const cmds = captureLiteralAcceptanceCommands(text).map((c) => c.command);
    expect(cmds).toEqual(
      expect.arrayContaining([
        "task check",
        "task doctor",
        "pnpm test",
        "task help",
        "task --version",
        "task verify:branch",
        "pnpm --version",
      ]),
    );
  });

  it("extracts inline backtick spans next to verify/run language", () => {
    const text = "Please run `task check` before done and verify `pnpm test`.";
    const cmds = captureLiteralAcceptanceCommands(text).map((c) => c.command);
    expect(cmds).toEqual(expect.arrayContaining(["task check", "pnpm test"]));
  });

  it("dedupes identical command+cwd+exit and records rejected ledger lines", () => {
    const text = [
      "verify: task check",
      "verify: task check",
      "verify: task scope:promote -- x",
      "verify: task scope:promote -- x",
    ].join("\n");
    const detailed = captureLiteralAcceptanceCommandsDetailed(text);
    expect(detailed.commands.filter((c) => c.command === "task check")).toHaveLength(1);
    expect(detailed.rejected.filter((r) => r.command.includes("scope:promote")).length).toBe(1);
    const ledger = formatRejectedLedger(detailed.rejected);
    expect(ledger).toMatch(/rejected|scope:promote|literal/i);
  });

  it("recognizes done-gate / verification region headings for fence capture", () => {
    const text = [
      "## Done gate",
      "```console",
      "task check",
      "```",
      "## Run verbatim",
      "```pwsh",
      "task doctor",
      "```",
      "## Check",
      "```cmd",
      "true",
      "```",
    ].join("\n");
    const cmds = captureLiteralAcceptanceCommands(text).map((c) => c.command);
    expect(cmds.length).toBeGreaterThan(0);
  });

  it("looksLikeShellCommand accepts flag and multi-word CLI shapes", () => {
    const text = "verify: vitest run --coverage\nverify: Not A Sentence About Testing";
    const cmds = captureLiteralAcceptanceCommands(text).map((c) => c.command);
    expect(cmds).toContain("vitest run --coverage");
  });
});
