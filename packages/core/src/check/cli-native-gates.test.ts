import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allGatesCliDispatchable,
  checkGateCliArgv,
  cliSpawnPlan,
  GLOBAL_CLI_REMEDY,
  isCliNativeGate,
  quoteWin32Arg,
  resolveGateDispatch,
  resolveGlobalCliBin,
} from "./cli-native-gates.js";
import {
  CONSUMER_CHECK_GATES,
  FRAMEWORK_CHECK_GATES,
  PRODUCT_FIRST_AC_GATE,
} from "./gate-lists.js";

/** Top-level cmd.exe tokens. `""` inside quotes is one escaped quote. */
function splitCmdTokens(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuote = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      started = true;
      continue;
    }
    if (c === " ") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    started = true;
    cur += c;
  }
  if (started) tokens.push(cur);
  return tokens;
}

describe("cli-native gates (#3335)", () => {
  it("classifies every consumer check gate as CLI-dispatchable", () => {
    expect(allGatesCliDispatchable(CONSUMER_CHECK_GATES)).toBe(true);
    for (const spec of CONSUMER_CHECK_GATES) {
      const id = typeof spec === "string" ? spec : spec.task;
      expect(isCliNativeGate(id), id).toBe(true);
    }
  });

  it("does not claim the framework composition is fully CLI-dispatchable", () => {
    expect(allGatesCliDispatchable(FRAMEWORK_CHECK_GATES)).toBe(false);
  });

  it("builds CLI argv without --taskfile or go-task --", () => {
    expect(checkGateCliArgv("verify:branch")).toEqual(["verify:branch"]);
    expect(checkGateCliArgv(PRODUCT_FIRST_AC_GATE)).toEqual(["verify:ac", "--soft-missing-xbrief"]);
    expect(checkGateCliArgv("toolchain:check-consumer")).toEqual(["toolchain-check", "--consumer"]);
    expect(checkGateCliArgv("ts:check-lane")).toEqual(["ts-check-lane"]);
  });

  it("prefers deft then directive for the global CLI", () => {
    expect(resolveGlobalCliBin((name) => (name === "deft" ? "/bin/deft" : null))).toBe("/bin/deft");
    expect(resolveGlobalCliBin((name) => (name === "directive" ? "/bin/directive" : null))).toBe(
      "/bin/directive",
    );
    expect(resolveGlobalCliBin(() => null)).toBeNull();
  });

  it("dispatches CLI-native gates via global CLI when task is absent", () => {
    expect(
      resolveGateDispatch({ gateId: "verify:ac", taskPresent: false, cliBin: "deft" }),
    ).toEqual({ mode: "cli", bin: "deft" });
    expect(resolveGateDispatch({ gateId: "verify:ac", taskPresent: true, cliBin: "deft" })).toEqual(
      { mode: "task", bin: "task" },
    );
  });

  it("does not recommend installing go-task when a CLI-native gate has no CLI either", () => {
    const resolved = resolveGateDispatch({
      gateId: "verify:branch",
      taskPresent: false,
      cliBin: null,
    });
    expect(resolved).toMatchObject({ skip: true, remedy: GLOBAL_CLI_REMEDY });
    expect("remedy" in resolved && resolved.remedy).not.toMatch(/go-task|taskfile\.dev/i);
  });

  it("quotes win32 CLI argv and uses cmd.exe", () => {
    expect(quoteWin32Arg("deft")).toBe("deft");
    expect(quoteWin32Arg("a b")).toBe('"a b"');
    const plan = cliSpawnPlan("deft", ["verify:ac", "--soft-missing-xbrief"], "win32");
    expect(plan.command).toBe("cmd.exe");
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]?.startsWith('"')).toBe(true);
    expect(plan.args[3]?.endsWith('"')).toBe(true);
    expect(plan.args[3]).toContain("deft");
    expect(plan.args[3]).toContain("verify:ac");
  });

  // Sibling sites each spawn, but they share this plan. One cmd.exe round-trip is the coverage.
  it.skipIf(process.platform !== "win32")(
    "live-spawns cliSpawnPlan through cmd.exe with a spaced project dir, spaced deft.cmd, and a&b",
    () => {
      const root = mkdtempSync(join(tmpdir(), "deft-4772-cli-"));
      const projectDir = join(root, "directive uat");
      const shimDir = join(root, "shim dir");
      try {
        mkdirSync(projectDir, { recursive: true });
        mkdirSync(shimDir, { recursive: true });
        const shim = join(shimDir, "deft.cmd");
        const capture = join(shimDir, "capture.ps1");
        const outPath = join(projectDir, "argv.txt");
        const projectSlash = projectDir.replace(/\\/g, "/");
        writeFileSync(
          capture,
          [
            '$me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"',
            '$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)"',
            "Set-Content -LiteralPath $env:DEFT_ARGV_OUT -Value $parent.CommandLine -Encoding utf8",
            "",
          ].join("\r\n"),
          "utf8",
        );
        writeFileSync(
          shim,
          `@echo off\r\npowershell.exe -NoProfile -File "${capture}"\r\n`,
          "utf8",
        );
        const argv = ["verify:branch", "--project-root", projectSlash, "a&b"] as const;
        const plan = cliSpawnPlan(shim, argv, "win32");
        const result = spawnSync(plan.command, plan.args, {
          cwd: projectDir,
          encoding: "utf8",
          env: { ...process.env, DEFT_ARGV_OUT: outPath },
          shell: false,
          ...(plan.windowsVerbatimArguments === true
            ? { windowsVerbatimArguments: true as const }
            : {}),
        });
        expect(result.status, `${result.stderr ?? ""}\n${result.stdout ?? ""}`).toBe(0);
        const captured = readFileSync(outPath, "utf8");
        const shimAt = captured.toLowerCase().indexOf(shim.toLowerCase());
        expect(shimAt, captured).toBeGreaterThanOrEqual(0);
        let rest = captured.slice(shimAt + shim.length).trim();
        if (rest.startsWith('"')) rest = rest.slice(1).trim();
        if (rest.endsWith('"') && (rest.match(/"/g) ?? []).length % 2 === 1) {
          rest = rest.slice(0, -1);
        }
        expect(splitCmdTokens(rest), captured).toEqual([
          "verify:branch",
          "--project-root",
          projectSlash,
          "a&b",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
