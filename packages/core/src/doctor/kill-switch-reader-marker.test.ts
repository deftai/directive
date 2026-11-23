/**
 * Doctor reports old kill-switch readers (#6740): a host-hook call without the
 * reader flag and an unmarked checkout-local git-hook helper, each naming the
 * redeposit. Compatibility information only.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostHookOuterCommand,
  hostHookOuterRelPath,
  hostHookOuterSource,
} from "../init-deposit/host-hook-outer.js";
import {
  checkKillSwitchReaderMarkers,
  KILL_SWITCH_READER_REDEPOSIT,
} from "../install-health/wiring.js";
import { resolveAbsoluteGitDir } from "../policy/deft-directive-disable.js";
import { KILL_SWITCH_GITHOOK_MARKER, writeKillSwitchRecord } from "../policy/kill-switch-record.js";
import { cmdDoctor } from "./main.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5 });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "w6740c1-doctor-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

const OLD_OUTER = "spawnSync(process.execPath, [pin, ...argv], { cwd: root });\n";

function registerClaudeOuter(root: string, sha8: string, outerText: string): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, hostHookOuterRelPath("claude", sha8)), outerText);
  const command = `${hostHookOuterCommand("claude", sha8)} --host claude --event tool.before`;
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }),
  );
}

function writeHelper(root: string, text: string): void {
  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(join(root, ".githooks", "_directive-run.sh"), text);
}

describe("checkKillSwitchReaderMarkers (#6740)", () => {
  it("reports a registered outer that calls the runtime without the reader flag", () => {
    const root = project();
    registerClaudeOuter(root, "0badc0de", OLD_OUTER);
    const findings = checkKillSwitchReaderMarkers(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rel).toBe(".claude/deft-hook-0badc0de.mjs");
    expect(findings[0]?.message).toContain("--kill-switch-reader v1");
    expect(findings[0]?.message).toContain(KILL_SWITCH_READER_REDEPOSIT);
    expect(KILL_SWITCH_READER_REDEPOSIT).toContain("directive upgrade");
    expect(KILL_SWITCH_READER_REDEPOSIT).toContain("install --repair");
  });

  it("accepts the current outer, which passes the reader flag", () => {
    const root = project();
    registerClaudeOuter(root, "c0ffee00", hostHookOuterSource());
    expect(checkKillSwitchReaderMarkers(root)).toEqual([]);
  });

  it("reports a registration that calls the runtime hook binary directly", () => {
    const root = project();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      JSON.stringify({
        hooks: {
          preToolUse: [
            {
              command: "node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host cursor",
            },
          ],
        },
      }),
    );
    const findings = checkKillSwitchReaderMarkers(root);
    expect(findings.map((f) => f.rel)).toEqual([".cursor/hooks.json"]);
  });

  it("reports an unmarked checkout-local git-hook helper and accepts a marked one", () => {
    const root = project();
    writeHelper(root, "#!/usr/bin/env sh\nrun_directive() { :; }\n");
    const unmarked = checkKillSwitchReaderMarkers(root);
    expect(unmarked.map((f) => f.rel)).toEqual([".githooks/_directive-run.sh"]);
    expect(unmarked[0]?.message).toContain(KILL_SWITCH_GITHOOK_MARKER);
    writeHelper(root, `#!/usr/bin/env sh\n${KILL_SWITCH_GITHOOK_MARKER}\nrun_directive() { :; }\n`);
    expect(checkKillSwitchReaderMarkers(root)).toEqual([]);
  });

  it("judges the helper at git rev-parse --show-toplevel", () => {
    const root = project();
    writeHelper(root, "#!/usr/bin/env sh\n");
    const sub = join(root, "pkg");
    mkdirSync(sub);
    expect(checkKillSwitchReaderMarkers(sub).map((f) => f.rel)).toEqual([
      ".githooks/_directive-run.sh",
    ]);
  });
});

describe("doctor kill-switch reader findings (#6740)", () => {
  it("shows the findings with the redeposit command", () => {
    const root = project();
    registerClaudeOuter(root, "0badc0de", OLD_OUTER);
    writeHelper(root, "#!/usr/bin/env sh\n");
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    cmdDoctor(["--project-root", root, "--json"]);
    const payload = JSON.parse(out.join("")) as {
      findings: { check?: string; message: string; path?: string }[];
    };
    const readers = payload.findings.filter((f) => f.check === "kill-switch-reader");
    expect(readers.map((f) => f.path).sort()).toEqual([
      ".claude/deft-hook-0badc0de.mjs",
      ".githooks/_directive-run.sh",
    ]);
    for (const f of readers) expect(f.message).toContain(KILL_SWITCH_READER_REDEPOSIT);
  });

  it("still names old readers when a valid record has Directive off", () => {
    const root = project();
    writeHelper(root, "#!/usr/bin/env sh\n");
    writeKillSwitchRecord(root, {
      gitDir: resolveAbsoluteGitDir(root) ?? "",
      mintedAt: "2026-11-22T00:00:00Z",
      mintedVia: "kill-switch:on",
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    expect(cmdDoctor(["--project-root", root, "--json"])).toBe(0);
    const payload = JSON.parse(out.join("")) as {
      disabled: boolean;
      old_kill_switch_readers: string[];
      message: string;
    };
    expect(payload.disabled).toBe(true);
    expect(payload.old_kill_switch_readers).toHaveLength(1);
    expect(payload.old_kill_switch_readers[0]).toContain(KILL_SWITCH_READER_REDEPOSIT);
    expect(payload.message).toContain(KILL_SWITCH_READER_REDEPOSIT);
  });
});
