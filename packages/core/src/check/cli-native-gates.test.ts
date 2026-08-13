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
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toContain("deft");
    expect(plan.args[3]).toContain("verify:ac");
  });
});
