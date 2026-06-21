import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "../dispatch.js";
import { run as runProbeSession } from "../probe-session.js";
import { run as runSubagentMonitor } from "../subagent-monitor.js";
import { muteProcessStreams, silentIo } from "./helpers.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

describe("deft-ts probe / subagent-monitor dispatcher (#1838 s4)", () => {
  it("subagent-monitor exits 2 when scratch dir is missing", async () => {
    const missing = join(tmpdir(), `deft-monitor-missing-${Date.now()}`);
    expect(
      await dispatch(
        ["subagent-monitor", "--scratch-dir", missing, "--threshold-minutes", "5"],
        silentIo(),
      ),
    ).toBe(2);
  });

  it("subagent-monitor exits 0 for empty scratch directory", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deft-monitor-empty-"));
    temps.push(scratch);
    expect(
      await dispatch(
        ["subagent-monitor", "--scratch-dir", scratch, "--threshold-minutes", "5"],
        silentIo(),
      ),
    ).toBe(0);
  });

  it("probe-session rejects unknown subcommand with exit 2", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-probe-cli-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    expect(await dispatch(["probe-session", "--project-root", root, "nope"], silentIo())).toBe(2);
  });

  it("probe-session start then guard exits 0 on complete handoff", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-probe-handoff-"));
    temps.push(root);
    mkdirSync(join(root, ".deft"), { recursive: true });
    const common = ["--project-root", root, "--target", "auth-probe", "--branch", "master"];
    expect(muteProcessStreams(() => runProbeSession(["start", ...common]))).toBe(0);
    expect(
      muteProcessStreams(() =>
        runProbeSession([
          "record",
          ...common,
          "--question",
          "Failure mode?",
          "--answer",
          "Return 503",
          "--status",
          "locked",
        ]),
      ),
    ).toBe(0);
    expect(muteProcessStreams(() => runProbeSession(["complete", ...common]))).toBe(0);
    expect(muteProcessStreams(() => runProbeSession(["guard-plan-registration", ...common]))).toBe(
      0,
    );
  });

  it("subagent-monitor wrapper propagates missing-dir exit 2", () => {
    const missing = join(tmpdir(), `deft-monitor-wrap-${Date.now()}`);
    expect(
      muteProcessStreams(() =>
        runSubagentMonitor(["--scratch-dir", missing, "--threshold-minutes", "5"]),
      ),
    ).toBe(2);
  });
});
