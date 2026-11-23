import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";
import {
  DEFT_DIRECTIVE_DISABLE_STATUS,
  resolveAbsoluteGitDir,
} from "../policy/deft-directive-disable.js";
import { KILL_SWITCH_RECORD_REL, writeKillSwitchRecord } from "../policy/kill-switch-record.js";
import { NO_DEFT_DIRECTIVE_FLAG_NAME } from "../policy/no-deft-directive.js";
import { runSessionStart } from "./session-start.js";

const temps: string[] = [];

afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-disable-"));
  temps.push(root);
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

/** #6740: only a valid kill record stands the ritual down; a bare flag does not. */
function writeKillRecord(root: string): void {
  writeKillSwitchRecord(root, {
    gitDir: resolveAbsoluteGitDir(root) ?? "",
    mintedAt: "2026-11-22T00:00:00Z",
    mintedVia: "kill-switch:on",
  });
}

describe("runSessionStart — kill record short-circuit (#3039 / #6740)", () => {
  it("skips the session ritual when a valid kill record is present", () => {
    const root = tempRoot();
    writeKillRecord(root);
    const result = runSessionStart(root, {
      writeHistory: false,
      verifyTools: () => {
        throw new Error("verifyTools must not run when kill-switch is present");
      },
      runTriageWelcome: () => {
        throw new Error("triage welcome must not run when kill-switch is present");
      },
      runGit: () => {
        throw new Error("git must not run when kill-switch is present");
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.disabled).toBe(true);
    expect(result.payload.disabled_via).toBe(KILL_SWITCH_RECORD_REL);
    expect(result.payload.status).toBe(DEFT_DIRECTIVE_DISABLE_STATUS);
    expect(result.payload.ready).toBe(false);
    expect(result.payload.inconsistent).toBe(false);
    expect(String(result.payload.message)).toContain("NEW agent session");
    expect(result.lines.join("\n")).toContain("kill-switch:off --confirm");
    expect(result.lines.join("\n")).toContain("mintedVia=kill-switch:on");
  });

  it("allows deposit to remain without dirty exit", () => {
    const root = tempRoot();
    writeKillRecord(root);
    mkdirSync(join(root, CANONICAL_INSTALL_ROOT), { recursive: true });
    const result = runSessionStart(root, { writeHistory: false });
    expect(result.code).toBe(0);
    expect(result.payload.deposit_present).toBe(true);
    expect(result.payload.inconsistent).toBe(false);
    expect(result.payload.ready).toBe(false);
  });

  it("combines permanent opt-out when the record and the opt-out flag are present", () => {
    const root = tempRoot();
    writeKillRecord(root);
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    const result = runSessionStart(root, { writeHistory: false });
    expect(result.code).toBe(0);
    expect(result.payload.disabled_via).toBe(KILL_SWITCH_RECORD_REL);
    expect(result.payload.permanent_opt_out_also_present).toBe(true);
    expect(result.lines.join("\n")).toContain(".no-deft-directive");
  });
});
