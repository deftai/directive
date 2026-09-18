import { describe, expect, it } from "vitest";
import {
  extractGateCause,
  formatDegradedSkipReport,
  formatNamedCauseFailure,
  remedyForGate,
} from "./named-cause.js";

describe("named-cause gate failures (#3282)", () => {
  it("includes gate name, cause, and remedy without env values", () => {
    const msg = formatNamedCauseFailure({
      gateId: "verify:branch",
      exitCode: 1,
      stderr: "❌ deft branch-protection: refusing default branch\n",
      stdout: "",
    });
    expect(msg.lines[0]).toContain("verify:branch");
    expect(msg.lines[0]).toContain("exit 1");
    expect(msg.cause).toMatch(/branch-protection|refusing/i);
    expect(msg.remedy).toMatch(/feature branch|git switch/i);
    expect(msg.lines.join("\n")).not.toMatch(/DEFT_[A-Z0-9_]+=/);
  });

  it("names a missing global CLI without telling the agent to install go-task (#3335)", () => {
    const msg = formatNamedCauseFailure({
      gateId: "verify:ac",
      exitCode: 1,
      spawnError: "spawn deft ENOENT",
    });
    expect(msg.cause).toMatch(/deft\/directive CLI not found/i);
    expect(msg.remedy).toMatch(/@deftai\/directive/);
    expect(msg.remedy).not.toMatch(/go-task|taskfile\.dev/i);
  });

  it("does not tell a CLI-native consumer gate to install go-task", () => {
    const msg = formatNamedCauseFailure({
      gateId: "toolchain:check-consumer",
      exitCode: 1,
      spawnError: "spawn task ENOENT",
    });
    expect(msg.cause).toMatch(/task binary not found/i);
    expect(msg.remedy).toMatch(/@deftai\/directive/i);
    expect(msg.remedy).not.toMatch(/taskfile\.dev|go-task/i);
  });

  it("provides npm-specific remediation for an npm consumer failure", () => {
    const msg = formatNamedCauseFailure({
      gateId: "toolchain:check-consumer",
      exitCode: 1,
      stderr: "  npm: NOT FOUND\nMissing tools: npm\n",
    });
    expect(msg.cause).toMatch(/npm: NOT FOUND/i);
    expect(msg.remedy).toMatch(/npm|Node/i);
    expect(msg.remedy).not.toMatch(/pnpm|corepack|go-task/i);
  });

  it("does not mistake a pnpm failure for npm", () => {
    const msg = formatNamedCauseFailure({
      gateId: "toolchain:check-consumer",
      exitCode: 1,
      stderr: "  pnpm: NOT FOUND\nMissing tools: pnpm\n",
    });
    expect(msg.cause).toMatch(/^pnpm: NOT FOUND$/i);
    expect(msg.remedy).toMatch(/pnpm|corepack/i);
    expect(msg.remedy).not.toMatch(/npm is bundled/i);
  });

  it("repairs the winning environment override when package-manager selection fails", () => {
    const msg = formatNamedCauseFailure({
      gateId: "toolchain:check-consumer",
      exitCode: 1,
      stderr:
        "  package manager: ERROR - Unsupported DEFT_PACKAGE_MANAGER value; supported managers are npm and pnpm.\n",
    });
    expect(msg.cause).toMatch(/Unsupported DEFT_PACKAGE_MANAGER value/i);
    expect(msg.remedy).toMatch(/Set DEFT_PACKAGE_MANAGER.*npm.*pnpm/i);
    expect(msg.remedy).toMatch(/unset.*package\.json/i);
    expect(msg.remedy).not.toMatch(/Install the missing consumer tool/i);
  });

  it("does not treat bare exit as empty cause", () => {
    const cause = extractGateCause("", "", 1);
    expect(cause).toMatch(/without a diagnostic/);
  });

  it("strips env-like lines from cause extraction", () => {
    const cause = extractGateCause("", "DEFT_FOO=secret\nreal failure: cache stale\n", 1);
    expect(cause).toBe("real failure: cache stale");
    expect(cause).not.toContain("DEFT_FOO");
  });

  it("prefers Tests N failed over a vitest FAIL file line (#4230 / #4506)", () => {
    const cause = extractGateCause(
      "vitest banner\nFAIL packages/core/src/foo.test.ts\nTests  1 failed\n",
      "check: starting suite gate ts:check-lane\n",
      1,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toMatch(/Tests\s+1\s+failed/);
  });

  it("prefers Tests N failed over an extra-coverage FAIL: path print (#4506)", () => {
    const cause = extractGateCause(
      "FAIL  packages/core/src/hooks/scope.test.ts > inspect\nTests  3 failed | 8 passed (11)\n",
      "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      1,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toMatch(/Tests\s+3\s+failed/);
    expect(cause).not.toContain("deliberately-bad");
  });

  it("prefers FAIL plus whitespace test file over a colon FAIL: path print (#4506)", () => {
    const cause = extractGateCause(
      "FAIL  packages/core/src/hooks/scope.test.ts > inspect\n",
      "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      1,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toMatch(/FAIL\s+packages\/core\/src\/hooks\/scope\.test\.ts/);
    expect(cause).not.toContain("deliberately-bad");
  });

  it("does not treat a colon FAIL: path print as vitest-shaped (#4506)", () => {
    const cause = extractGateCause(
      "vitest banner\n",
      "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      1,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toContain("FAIL:");
    expect(cause).toContain("deliberately-bad");
  });

  it("names hang detector timeout instead of the D7 FAIL: fixture on exit 124 (#4744)", () => {
    const cause = extractGateCause(
      "check: starting suite gate ts:check-lane\n",
      "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      124,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toMatch(/hang detector timeout/i);
    expect(cause).toMatch(/exit 124/);
    expect(cause).not.toContain("deliberately-bad");
    expect(cause).not.toContain("FAIL:");
  });

  it("includes last completed test file on exit 124 when a last-file tick is present (#4744)", () => {
    const cause = extractGateCause(
      "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      "ts:check-lane last-file packages/core/src/hooks/scope.test.ts (412/2060 files)\n",
      124,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toMatch(/hang detector timeout/i);
    expect(cause).toContain("packages/core/src/hooks/scope.test.ts");
    expect(cause).not.toContain("deliberately-bad");
  });

  it("remedies exit 124 without raising RELEASE_CHECK_TIMEOUT_MS (#4744)", () => {
    const msg = formatNamedCauseFailure({
      gateId: "ts:check-lane",
      exitCode: 124,
      stdout: "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      stderr: "",
    });
    expect(msg.cause).toMatch(/hang detector timeout/i);
    expect(msg.remedy).toMatch(/do not raise RELEASE_CHECK_TIMEOUT_MS/);
    expect(msg.cause).not.toContain("deliberately-bad");
  });

  it("prefers ANSI-colored Tests N failed over a colon FAIL: path print (#4506)", () => {
    const red = "\u001b[31m";
    const reset = "\u001b[0m";
    const cause = extractGateCause(
      `${red}FAIL  packages/core/src/hooks/scope.test.ts > inspect${reset}\n${red}Tests  3 failed | 8 passed (11)${reset}\n`,
      "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      1,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toMatch(/Tests\s+3\s+failed/);
    expect(cause).not.toContain("deliberately-bad");
    expect(cause).not.toContain("\u001b");
  });

  it("prefers ANSI-colored FAIL plus whitespace test file over a colon FAIL: path print (#4506)", () => {
    const red = "\u001b[31m";
    const reset = "\u001b[0m";
    const cause = extractGateCause(
      `${red}FAIL  packages/core/src/hooks/scope.test.ts > inspect${reset}\n`,
      "FAIL: xbrief/completed/2026-09-07-deliberately-bad-1.2.3.xbrief.json\n",
      1,
      undefined,
      "ts:check-lane",
    );
    expect(cause).toMatch(/FAIL\s+packages\/core\/src\/hooks\/scope\.test\.ts/);
    expect(cause).not.toContain("deliberately-bad");
    expect(cause).not.toContain("\u001b");
  });

  it("formats degraded skip report with causes", () => {
    const lines = formatDegradedSkipReport({
      reason: "task missing",
      skipped: [
        {
          id: "toolchain:check-consumer",
          cause: "go-task binary not found on PATH",
          remedy: "Install go-task",
        },
      ],
    });
    expect(lines.join("\n")).toContain("degraded mode");
    expect(lines.join("\n")).toContain("toolchain:check-consumer");
    expect(lines.join("\n")).toContain("exit 2 (degraded/config)");
  });

  it("returns a generic remedy for unknown gates", () => {
    expect(remedyForGate("unknown:gate", "something broke")).toMatch(/Re-run the gate/);
  });

  it("attributes verify:ac instead of quoting engine:_ts-build (#3449)", () => {
    const msg = formatNamedCauseFailure({
      gateId: "verify:ac",
      exitCode: 201,
      stdout:
        "task: [engine:_ts-build] set -eu\n" +
        "set -eu\n" +
        "# #3324: consumer-deposit marker\n" +
        "if node tasks/engine-invoke.cjs is-buildable-source /repo; then\n" +
        "verify:ac passed (#3284) [rung=stated]\n" +
        "Literal acceptance-command gate: no stated commands (nothing to run) (#3284/#3267)\n",
      stderr: "",
    });
    expect(msg.cause).toMatch(/verify:ac/);
    expect(msg.cause).not.toMatch(/engine:_ts-build/);
    expect(msg.cause).not.toMatch(/set -eu/);
  });
});
