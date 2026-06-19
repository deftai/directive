import { describe, expect, it, vi } from "vitest";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { EXIT_CLEAN, EXIT_CONFIG_ERROR } from "./constants.js";
import { cmdPrMonitor, parseMonitorArgs, runMonitor } from "./main.js";
import { monitor } from "./monitor.js";
import { callReadiness } from "./readiness.js";

const HEAD = "abc1234567890def1234567890abcdef12345678";

function fakeRunGh(responses?: { headOk?: boolean; commentsOk?: boolean }): RunGhFn {
  const headOk = responses?.headOk ?? true;
  const commentsOk = responses?.commentsOk ?? true;
  return (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("headRefOid")) {
      return headOk
        ? { returncode: 0, stdout: `${HEAD}\n`, stderr: "" }
        : { returncode: 1, stdout: "", stderr: "all-down" };
    }
    if (joined.includes("/comments")) {
      return commentsOk
        ? {
            returncode: 0,
            stdout:
              "## Greptile Summary\n\n**Confidence Score: 5/5**\n\n" +
              `Last reviewed commit: [x](https://github.com/deftai/directive/commit/${HEAD})\n`,
            stderr: "",
          }
        : { returncode: 1, stdout: "", stderr: "boom" };
    }
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };
}

describe("parseMonitorArgs", () => {
  it("parses pr repo cap and json", () => {
    expect(
      parseMonitorArgs(["1363", "--repo", "deftai/directive", "--cap-minutes", "30", "--json"]),
    ).toEqual({
      prNumber: 1363,
      repo: "deftai/directive",
      capMinutes: 30,
      emitJson: true,
    });
  });

  it("errors on missing repo in parse only", () => {
    expect(parseMonitorArgs(["1363"]).repo).toBeNull();
  });

  it("errors on invalid cap minutes", () => {
    expect(parseMonitorArgs(["1", "--cap-minutes", "nope"]).error).toContain("invalid");
  });

  it("errors on unknown flag", () => {
    expect(parseMonitorArgs(["1", "--nope"]).error).toContain("unrecognized");
  });
});

describe("callReadiness", () => {
  it("returns structured error payload when gh fails", () => {
    const result = callReadiness(1, "deftai/directive", { runGh: fakeRunGh({ headOk: false }) });
    expect(result.payload.via).toBe("error");
    expect(result.payload.merge_ready).toBe(false);
  });

  it("returns primary clean payload", () => {
    const result = callReadiness(1, "deftai/directive", { runGh: fakeRunGh() });
    expect(result.payload.via).toBe("primary");
    expect(result.payload.merge_ready).toBe(true);
    expect(result.rawStdout).toContain('"merge_ready": true');
  });
});

describe("runMonitor CLI", () => {
  it("returns config error when repo missing", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prev = process.env.GH_REPO;
    delete process.env.GH_REPO;
    expect(runMonitor(["1363"])).toBe(EXIT_CONFIG_ERROR);
    if (prev !== undefined) {
      process.env.GH_REPO = prev;
    }
    stderr.mockRestore();
  });

  it("emits json envelope on CLEAN", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = runMonitor(["1363", "--repo", "deftai/directive", "--json"], {
      monitorFn: () => ({
        exitCode: EXIT_CLEAN,
        payload: { via: "primary", merge_ready: true, failures: [] },
        pollCount: 1,
      }),
    });
    expect(code).toBe(EXIT_CLEAN);
    const out = String(stdout.mock.calls.map((c) => c[0]).join(""));
    expect(out).toContain('"monitor_result": "CLEAN"');
    expect(out).toContain('"via": "primary"');
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("cmdPrMonitor delegates", () => {
    expect(
      cmdPrMonitor(["1363", "--repo", "deftai/directive", "--cap-minutes", "0", "--json"], {
        runGh: fakeRunGh({ headOk: false }),
      }),
    ).toBe(1);
  });

  it("prints human summary", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    runMonitor(["1363", "--repo", "deftai/directive"], {
      monitorFn: () => ({
        exitCode: 1,
        payload: { via: "error", merge_ready: false, failures: ["blocked"], error: "gh down" },
        pollCount: 1,
      }),
    });
    const out = String(stdout.mock.calls.map((c) => c[0]).join(""));
    expect(out).toContain("monitor result: CAP-REACHED");
    expect(out).toContain("error: gh down");
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe("integration monitor with runGh", () => {
  it("runs end-to-end clean path", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = monitor(1363, "deftai/directive", {
      capMinutes: 10,
      sleepFn: () => undefined,
      clockFn: { now: () => 0 },
      runGh: fakeRunGh(),
    });
    expect(result.exitCode).toBe(EXIT_CLEAN);
    stderr.mockRestore();
  });
});
