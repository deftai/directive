/**
 * Wave 3g — F-009 / F-011 / F-014 owner-boundary presenter tests.
 * Plain shop-English plan/completion + TTY wrap + uninstall summary.
 */
import { describe, expect, it } from "vitest";
import {
  HUMAN_GIT_HOOKS_INACTIVE_LINE,
  HUMAN_INSTALL_SCRIPT_LINE,
  presentFirstInstallPlan,
  presentInstallSuccess,
  presentUninstallPlan,
  presentUninstallSuccess,
  resolveWrapWidth,
  summarizeUninstallRemovals,
  wrapWords,
  type PresentIo,
  type UninstallRemovalSummary,
} from "./plan-present.js";

function capture(): { io: PresentIo; out: () => string } {
  const buf: string[] = [];
  return {
    io: {
      writeOut: (t: string) => {
        buf.push(t);
      },
      writeErr: () => {},
    },
    out: () => buf.join(""),
  };
}

describe("F-011 TTY word-wrap", () => {
  it("returns null width (no wrap) when not a TTY", () => {
    expect(resolveWrapWidth({ isTTY: false, columns: 100 })).toBeNull();
  });

  it("respects columns with floor/ceiling on TTY", () => {
    expect(resolveWrapWidth({ isTTY: true, columns: 20 })).toBeGreaterThanOrEqual(40);
    expect(resolveWrapWidth({ isTTY: true, columns: 200 })).toBeLessThanOrEqual(100);
    expect(resolveWrapWidth({ isTTY: true, columns: 90 })).toBe(90);
  });

  it("wraps on word boundaries; does not split tokens", () => {
    const line =
      "Installation skips package lifecycle scripts for the Directive pin add other settings still apply.";
    const wrapped = wrapWords(line, 40);
    for (const part of wrapped.split("\n")) {
      expect(part.length).toBeLessThanOrEqual(40);
      expect(part.startsWith(" ")).toBe(false);
    }
    expect(wrapped.replace(/\n/g, " ")).toBe(line);
    expect(wrapped).toContain("\n");
  });
});

describe("F-009 first-install plain English", () => {
  const base = {
    projectRoot: "/tmp/shop",
    pm: "npm" as const,
    pmEvidence: "package-lock.json",
    version: "1.2.3",
    pmCommand: "npm install --save-dev --save-exact --ignore-scripts @deftai/directive-runtime@1.2.3",
    willCreatePkg: true,
    gitHooksInactive: true,
    nodeWarning: null,
    verbosity: 0 as const,
  };

  it("default plan: Directive-will bullets only; no PM argv hero (wave 4g)", () => {
    const c = capture();
    presentFirstInstallPlan(c.io, base);
    const text = c.out();
    expect(text).toMatch(/Set up Deft Directive/);
    expect(text).toMatch(/If you approve, Directive will:/i);
    expect(text).toMatch(/create a minimal package\.json/i);
    expect(text).toMatch(/add Directive/i);
    expect(text).toMatch(/create Directive's project files for this folder/i);
    expect(text).not.toMatch(/Install command:/i);
    expect(text).not.toMatch(/Package manager will run:/i);
    expect(text).not.toContain(base.pmCommand);
    expect(text).not.toMatch(/Directive pin add/i);
    expect(text).not.toMatch(/eligible runtime command/i);
    expect(text).not.toMatch(/install-script policy:/i);
    expect(text).toMatch(/not a git repository/i);
    expect(text).toMatch(/git hooks will not be installed/i);
    expect(text).toMatch(/git init/i);
    expect(text).toMatch(/directive install --repair/i);
    expect(text).toContain(HUMAN_GIT_HOOKS_INACTIVE_LINE.split(".")[0]!);
  });

  it("-v shows Package manager will run + keyed script policy detail", () => {
    const c = capture();
    presentFirstInstallPlan(c.io, { ...base, verbosity: 1 });
    const text = c.out();
    expect(text).toMatch(/Package manager will run:/i);
    expect(text).toContain(base.pmCommand);
    expect(text).toMatch(/Directive skips lifecycle scripts on that add/i);
    expect(text).toMatch(/install-script policy:/i);
    expect(text).toMatch(/Plan \(verbose\)/);
  });

  it("success echo restates plain steps; no Install command", () => {
    const c = capture();
    presentInstallSuccess(c.io, {
      version: "1.2.3",
      projectRoot: "/tmp/shop",
      pm: "npm",
      summary: {
        created: ["AGENTS.md", ".deft/GENERATION.json"],
        modified: [],
        removed: [],
        message: "Git hooks inactive until git init",
      },
      verbosity: 0,
    });
    const text = c.out();
    expect(text).toMatch(/✓ Installed Directive 1\.2\.3/);
    expect(text).toMatch(/Incomplete install/i);
    expect(text).toMatch(/not a git repository|git hooks (will )?not|were not installed/i);
    expect(text).toMatch(/directive install --repair/i);
    expect(text).toMatch(/Next:\s*\n\s*git init/i);
    expect(text).not.toMatch(/Install command:/i);
    expect(text).not.toMatch(/eligible runtime/i);
  });

  it("F-010 plan line names incomplete install + git init repair", () => {
    expect(HUMAN_GIT_HOOKS_INACTIVE_LINE).toMatch(/Incomplete install/i);
    expect(HUMAN_GIT_HOOKS_INACTIVE_LINE).toMatch(/git init/i);
    expect(HUMAN_GIT_HOOKS_INACTIVE_LINE).toMatch(/directive install --repair/);
  });

  it("legacy HUMAN_INSTALL_SCRIPT_LINE is not default-path copy", () => {
    expect(HUMAN_INSTALL_SCRIPT_LINE).toMatch(/lifecycle scripts/);
    const c = capture();
    presentFirstInstallPlan(c.io, { ...base, gitHooksInactive: false });
    expect(c.out()).not.toContain(HUMAN_INSTALL_SCRIPT_LINE);
  });
});

describe("F-014 uninstall plan/report summary", () => {
  const inventory = [
    ".agents/skills/deft/SKILL.md",
    ".claude/skills/deft/SKILL.md",
    ".claude/settings.json",
    ".cursor/hooks.json",
    ".githooks/pre-commit",
    ".githooks/pre-push",
    ".deft/GENERATION.json",
    ".deft/directive/wiring-ready.1.2.3.json",
    "AGENTS.md (marked section)",
    "Taskfile.yml (includes.deft)",
  ];

  it("summarizeUninstallRemovals counts categories", () => {
    const summary = summarizeUninstallRemovals(inventory, {
      willRemovePin: true,
      legacyCore: false,
      preserveLabels: ["xbrief/", ".deft/settings.json"],
    });
    expect(summary.skillPointers).toBe(2);
    expect(summary.hostHooks).toBe(2);
    expect(summary.gitHooks).toBe(2);
    expect(summary.projectWiring).toBeGreaterThanOrEqual(3);
    expect(summary.willRemovePin).toBe(true);
    expect(summary.pathInventory).toEqual(inventory);
  });

  it("default uninstall plan: category bullets; no Remove command; no path wall", () => {
    const summary = summarizeUninstallRemovals(inventory, {
      willRemovePin: true,
      legacyCore: false,
      preserveLabels: ["xbrief/", "user content", "global launcher"],
    });
    const c = capture();
    presentUninstallPlan(c.io, {
      projectRoot: "/tmp/shop",
      pm: "npm",
      pmEvidence: "package-lock.json",
      pinVersion: "1.2.3",
      pmCommand: "npm uninstall --save-dev @deftai/directive-runtime",
      verbosity: 0,
      removal: summary,
    });
    const text = c.out();
    expect(text).toMatch(/Uninstall Directive/);
    expect(text).toMatch(/If you approve, Directive will:/i);
    expect(text).toMatch(/skill pointer/i);
    expect(text).toMatch(/host hook/i);
    expect(text).toMatch(/runtime pin|package manager/i);
    expect(text).toMatch(/xbrief/i);
    expect(text).not.toMatch(/Remove command:/i);
    expect(text).not.toContain("npm uninstall --save-dev");
    // path wall: comma-joined inventory must not appear on default
    expect(text).not.toContain(inventory.join(", "));
    expect(text).not.toMatch(/Ownership record:/);
  });

  it("-v uninstall plan includes path inventory + PM command", () => {
    const summary = summarizeUninstallRemovals(inventory, {
      willRemovePin: true,
      legacyCore: true,
      preserveLabels: ["xbrief/"],
    });
    const c = capture();
    presentUninstallPlan(c.io, {
      projectRoot: "/tmp/shop",
      pm: "npm",
      pmEvidence: "lockfile",
      pinVersion: "1.2.3",
      pmCommand: "npm uninstall --save-dev @deftai/directive-runtime",
      verbosity: 1,
      removal: summary,
    });
    const text = c.out();
    expect(text).toContain("npm uninstall --save-dev @deftai/directive-runtime");
    expect(text).toContain(".agents/skills/deft/SKILL.md");
    expect(text).toMatch(/Plan \(verbose\)|Remove paths:/i);
  });

  it("uninstall success summarizes; path dump only at -v", () => {
    const summary: UninstallRemovalSummary = summarizeUninstallRemovals(inventory, {
      willRemovePin: true,
      legacyCore: false,
      preserveLabels: ["xbrief/", ".deft/settings.json"],
    });
    const c = capture();
    presentUninstallSuccess(c.io, {
      projectRoot: "/tmp/shop",
      complete: true,
      removal: summary,
      removedPaths: inventory.slice(0, 3),
      preserved: ["xbrief", ".deft/settings.json"],
      verbosity: 0,
    });
    const text = c.out();
    expect(text).toMatch(/✓|Uninstalled|Removed/i);
    expect(text).toMatch(/xbrief/i);
    expect(text).not.toMatch(/launcher cleanup: removed=/);
    expect(text).not.toContain(inventory.slice(0, 3).join(", "));

    const cV = capture();
    presentUninstallSuccess(cV.io, {
      projectRoot: "/tmp/shop",
      complete: true,
      removal: summary,
      removedPaths: inventory.slice(0, 3),
      preserved: ["xbrief"],
      verbosity: 1,
    });
    expect(cV.out()).toContain(".agents/skills/deft/SKILL.md");
  });
});
