import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import { softAgentsRebindForbiddenHits } from "../session/compact-ritual.js";
import {
  clearDeftDirectiveDisableTrackedProbeCache,
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE,
  DEFT_DIRECTIVE_DISABLE_ONE_LINE,
  DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE,
  DEFT_DIRECTIVE_DISABLE_STATUS,
  DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING,
  deftDirectiveDisableFlagPath,
  detectDeftDirectiveDisable,
  formatDeftDirectiveDisableMessage,
  isDeftDirectiveDisableActive,
} from "./deft-directive-disable.js";
import { KILL_SWITCH_BARE_FLAG_WARNING } from "./kill-switch-record.js";

const temps: string[] = [];

afterEach(() => {
  clearDeftDirectiveDisableTrackedProbeCache();
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-directive-disable-"));
  temps.push(root);
  return root;
}

describe("detectDeftDirectiveDisable (#3039)", () => {
  it("reports absent when the flag file is missing", () => {
    const root = tempRoot();
    const state = detectDeftDirectiveDisable(root);
    expect(state.present).toBe(false);
    expect(state.active).toBe(false);
    expect(state.eligibility).toBe("ineligible");
    expect(state.depositPresent).toBe(false);
    expect(state.trackedByGit).toBe(false);
    expect(state.flagPath).toBe(deftDirectiveDisableFlagPath(root));
    expect(isDeftDirectiveDisableActive(root)).toBe(false);
  });

  it("does not activate on an empty untracked root flag file (#6740)", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    const state = detectDeftDirectiveDisable(root, {
      isGitTracked: () => false,
    });
    expect(state.present).toBe(true);
    expect(state.active).toBe(false);
    expect(state.eligibility).toBe("ineligible");
    expect(state.warning).toBe(KILL_SWITCH_BARE_FLAG_WARNING);
    expect(isDeftDirectiveDisableActive(root, { isGitTracked: () => false })).toBe(false);
  });

  it("detects a short-comment flag file as present", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "# A/B arm\n", "utf8");
    expect(detectDeftDirectiveDisable(root, { isGitTracked: () => false }).present).toBe(true);
  });

  it("does not treat a same-named directory as the flag", () => {
    const root = tempRoot();
    mkdirSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME));
    expect(detectDeftDirectiveDisable(root).present).toBe(false);
    expect(detectDeftDirectiveDisable(root).eligibility).toBe("ineligible");
  });

  it("does not activate on a symlink plant of the kill-switch (#3213)", () => {
    const root = tempRoot();
    const target = join(root, "real-hosts-like.txt");
    writeFileSync(target, "x", "utf8");
    const flag = join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
    try {
      symlinkSync(target, flag);
    } catch {
      // Windows may require elevated privileges for file symlinks; skip if unsupported.
      return;
    }
    const state = detectDeftDirectiveDisable(root, { isGitTracked: () => false });
    expect(state.present).toBe(false);
    expect(state.active).toBe(false);
    expect(state.eligibility).toBe("ineligible");
    expect(isDeftDirectiveDisableActive(root, { isGitTracked: () => false })).toBe(false);
  });

  it("reports deposit present without treating it as inconsistent", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "", "utf8");
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const state = detectDeftDirectiveDisable(root, { isGitTracked: () => false });
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    expect(state.active).toBe(false);
    expect(state.eligibility).toBe("ineligible");
  });

  it("does not activate when the flag is tracked by git (misconfig)", () => {
    const root = "/virtual/project";
    const files = new Set([resolve(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)]);
    const state = detectDeftDirectiveDisable(root, {
      isFile: (p) => files.has(p),
      isDir: () => false,
      isGitTracked: () => true,
    });
    expect(state.present).toBe(true);
    expect(state.trackedByGit).toBe(true);
    expect(state.active).toBe(false);
    expect(state.eligibility).toBe("ineligible");
    expect(
      isDeftDirectiveDisableActive(root, {
        isFile: (p) => files.has(p),
        isGitTracked: () => true,
      }),
    ).toBe(false);
  });

  it("honors injectable seams without touching the filesystem", () => {
    const root = "/virtual/project";
    const files = new Set([resolve(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)]);
    const dirs = new Set([join(root, CANONICAL_INSTALL_ROOT)]);
    const state = detectDeftDirectiveDisable(root, {
      isFile: (p) => files.has(p),
      isDir: (p) => dirs.has(p),
      isGitTracked: () => false,
    });
    expect(state.present).toBe(true);
    expect(state.depositPresent).toBe(true);
    // #6740: an untracked flag no longer selects the stand-down; only a record does.
    expect(state.active).toBe(false);
    expect(state.eligibility).toBe("ineligible");
  });

  it("documents recovery wording and gitignore constant", () => {
    expect(DEFT_DIRECTIVE_DISABLE_FLAG_NAME).toBe(".deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE).toBe(".deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_STATUS).toBe("disabled-test-kill-switch");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).toContain("deft kill-switch:off --confirm");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).not.toContain("rm .deft-directive-disable");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).toContain("NEW agent session");
    expect(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE).toContain(
      "The record is valid: stop Directive process load (AGENTS.md Temporary test kill-switch #3039).",
    );
    expect(softAgentsRebindForbiddenHits(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE)).toEqual([]);
    expect(DEFT_DIRECTIVE_DISABLE_ONE_LINE).toContain("test/local kill-switch");
    expect(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING).toContain("never disables");
    expect(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING).toContain("kill-switch:on");
  });
});

// #6740: the flag probe still reports trackedByGit, but no flag row is eligible
// or active any more; only a valid kill record selects the stand-down.
describe("operator-disable eligibility matrix (#6122 / #6740)", () => {
  const cases = [
    {
      name: "valid local regular-file untracked",
      present: true,
      probe: "untracked",
      eligibility: "ineligible",
      active: false,
      trackedByGit: false,
    },
    {
      name: "tracked misconfig",
      present: true,
      probe: "tracked",
      eligibility: "ineligible",
      active: false,
      trackedByGit: true,
    },
    {
      name: "absent",
      present: false,
      probe: "untracked",
      eligibility: "ineligible",
      active: false,
      trackedByGit: false,
    },
    {
      name: "indeterminate probe",
      present: true,
      probe: "indeterminate",
      eligibility: "ineligible",
      active: false,
      trackedByGit: false,
    },
  ] as const;

  it.each(cases)("$name via probeGitTrackListing", (row) => {
    const root = "/virtual/eligibility";
    const state = detectDeftDirectiveDisable(root, {
      isFile: () => row.present,
      isDir: () => false,
      probeGitTrackListing: () => row.probe,
    });
    expect(state.present).toBe(row.present);
    expect(state.eligibility).toBe(row.eligibility);
    expect(state.active).toBe(row.active);
    expect(state.trackedByGit).toBe(row.trackedByGit);
  });

  it("does not treat probe failure as active on cached default path", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "1\n", "utf8");
    clearDeftDirectiveDisableTrackedProbeCache();
    const state = detectDeftDirectiveDisable(root, {
      probeGitTrackListing: () => "indeterminate",
    });
    expect(state.eligibility).toBe("ineligible");
    expect(state.active).toBe(false);
  });

  it("does not treat probe failure as active on skipTrackedCache path", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "1\n", "utf8");
    const state = detectDeftDirectiveDisable(root, {
      skipTrackedCache: true,
      probeGitTrackListing: () => "indeterminate",
    });
    expect(state.eligibility).toBe("ineligible");
    expect(state.active).toBe(false);
  });

  it("does not cache indeterminate as untracked; later tracked probe stays inactive", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "1\n", "utf8");
    clearDeftDirectiveDisableTrackedProbeCache();
    let calls = 0;
    const sequence = ["indeterminate", "tracked"] as const;
    const probe = () => {
      const next = sequence[Math.min(calls, sequence.length - 1)] ?? "tracked";
      calls += 1;
      return next;
    };
    const first = detectDeftDirectiveDisable(root, { probeGitTrackListing: probe });
    expect(first.eligibility).toBe("ineligible");
    expect(first.active).toBe(false);
    const second = detectDeftDirectiveDisable(root, { probeGitTrackListing: probe });
    expect(second.eligibility).toBe("ineligible");
    expect(second.trackedByGit).toBe(true);
    expect(second.active).toBe(false);
    expect(calls).toBe(2);
  });

  it("skipTrackedCache re-probes and can flip from untracked to tracked", () => {
    const root = "/virtual/skip-cache";
    const files = new Set([resolve(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)]);
    let tracked = false;
    const first = detectDeftDirectiveDisable(root, {
      isFile: (p) => files.has(p),
      isDir: () => false,
      skipTrackedCache: true,
      probeGitTrackListing: () => (tracked ? "tracked" : "untracked"),
    });
    expect(first.active).toBe(false);
    expect(first.trackedByGit).toBe(false);
    tracked = true;
    const second = detectDeftDirectiveDisable(root, {
      isFile: (p) => files.has(p),
      isDir: () => false,
      skipTrackedCache: true,
      probeGitTrackListing: () => (tracked ? "tracked" : "untracked"),
    });
    expect(second.active).toBe(false);
    expect(second.trackedByGit).toBe(true);
  });

  it("default cache stores only successful listings (indeterminate then tracked)", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "1\n", "utf8");
    clearDeftDirectiveDisableTrackedProbeCache();
    let calls = 0;
    const capture = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("git launch failed");
      }
      return `${DEFT_DIRECTIVE_DISABLE_FLAG_NAME}\n`;
    };
    const first = detectDeftDirectiveDisable(root, { gitLsFilesCapture: capture });
    expect(first.eligibility).toBe("ineligible");
    expect(first.active).toBe(false);
    expect(calls).toBe(1);
    const second = detectDeftDirectiveDisable(root, { gitLsFilesCapture: capture });
    expect(second.eligibility).toBe("ineligible");
    expect(second.trackedByGit).toBe(true);
    expect(second.active).toBe(false);
    expect(calls).toBe(2);
    const third = detectDeftDirectiveDisable(root, { gitLsFilesCapture: capture });
    expect(third.trackedByGit).toBe(true);
    expect(third.active).toBe(false);
    // Successful tracked result was cached; capture not invoked again.
    expect(calls).toBe(2);
  });

  it("skipTrackedCache path uses capture adapter without reading cache", () => {
    const root = tempRoot();
    writeFileSync(join(root, DEFT_DIRECTIVE_DISABLE_FLAG_NAME), "1\n", "utf8");
    clearDeftDirectiveDisableTrackedProbeCache();
    let calls = 0;
    const capture = () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return "";
    };
    const first = detectDeftDirectiveDisable(root, {
      skipTrackedCache: true,
      gitLsFilesCapture: capture,
    });
    expect(first.eligibility).toBe("ineligible");
    const second = detectDeftDirectiveDisable(root, {
      skipTrackedCache: true,
      gitLsFilesCapture: capture,
    });
    expect(second.eligibility).toBe("ineligible");
    expect(second.active).toBe(false);
    expect(second.trackedByGit).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("formatDeftDirectiveDisableMessage (#3039)", () => {
  it("includes recovery steps by default", () => {
    const msg = formatDeftDirectiveDisableMessage();
    expect(msg).toContain("Remove the record");
    expect(msg).toContain("kill-switch:off --confirm");
    expect(msg).toContain("NEW agent session");
  });

  it("combines permanent opt-out when both flags present", () => {
    const msg = formatDeftDirectiveDisableMessage({ permanentOptOutAlsoPresent: true });
    expect(msg).toContain(".no-deft-directive");
    expect(msg).toContain("permanent opt-out");
  });

  it("appends tracked-by-git warning", () => {
    const msg = formatDeftDirectiveDisableMessage({ trackedByGit: true });
    expect(msg).toContain(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING);
  });

  it("supports one-line mode", () => {
    const msg = formatDeftDirectiveDisableMessage({ oneLine: true });
    expect(msg).toBe(DEFT_DIRECTIVE_DISABLE_ONE_LINE);
  });
});
