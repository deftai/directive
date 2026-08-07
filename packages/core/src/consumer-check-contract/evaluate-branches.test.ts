/**
 * Branch coverage for consumer-check-contract pure helpers (#3185 coverage-debt).
 */
import { describe, expect, it } from "vitest";
import {
  extractWorkflowRunCommands,
  isNonExecutingCommandLine,
  isPureAssignmentLine,
  lineHasBackgroundJob,
  lineHasCommandPositionRunner,
  lineMasksCheckFailure,
  lineMasksShellStatus,
  runCommandInvokesGate,
  runCommandIsFullCheck,
  stripQuotedSegments,
  textReferencesGate,
} from "./evaluate.js";

describe("consumer-check-contract pure helper branches (#3185)", () => {
  it("textReferencesGate accepts dashed and CLI forms", () => {
    expect(textReferencesGate("verify-test-boundary", "verify:test-boundary")).toBe(true);
    expect(textReferencesGate("directive verify:test-boundary", "verify:test-boundary")).toBe(true);
    expect(textReferencesGate("other", "verify:test-boundary")).toBe(false);
  });

  it("isPureAssignmentLine covers export, quotes, chains, leftovers", () => {
    expect(isPureAssignmentLine("")).toBe(false);
    expect(isPureAssignmentLine("FOO=1 && task check")).toBe(false);
    expect(isPureAssignmentLine("FOO=1 task check")).toBe(false);
    expect(isPureAssignmentLine("FOO=bar")).toBe(true);
    expect(isPureAssignmentLine('export CHECK_CMD="task check"')).toBe(true);
    expect(isPureAssignmentLine("export A=1 B=2")).toBe(true);
    expect(isPureAssignmentLine("FOO='unclosed")).toBe(false);
    expect(isPureAssignmentLine('FOO="ok" BAR=2')).toBe(true);
  });

  it("isNonExecutingCommandLine recognizes echo, comments, pure assigns", () => {
    expect(isNonExecutingCommandLine("")).toBe(true);
    expect(isNonExecutingCommandLine("# comment")).toBe(true);
    expect(isNonExecutingCommandLine('- echo "task check"')).toBe(true);
    expect(isNonExecutingCommandLine('CHECK_CMD="task check"')).toBe(true);
    expect(isNonExecutingCommandLine("task check")).toBe(false);
  });

  it("extractWorkflowRunCommands handles block scalars and quoted scalars", () => {
    const text = `
jobs:
  a:
    steps:
      - run: task check
      - run: |
          echo hello
          task verify:branch
      - run: >
          multi
      - run: "task verify:test-boundary"
      - run: 'task verify:scope-provenance'
      - run:
      # comment
      - script: deft check
`;
    const cmds = extractWorkflowRunCommands(text);
    expect(cmds.some((c) => c.includes("task check"))).toBe(true);
    expect(cmds.some((c) => c.includes("verify:branch"))).toBe(true);
    expect(cmds).toContain("task verify:test-boundary");
    expect(cmds).toContain("task verify:scope-provenance");
    expect(cmds).toContain("deft check");
  });

  it("stripQuotedSegments removes quoted spans", () => {
    expect(stripQuotedSegments(`echo "task check" && true`)).toBe("echo   && true");
    expect(stripQuotedSegments(`printf 'x'`)).toBe("printf  ");
  });

  it("lineMasksShellStatus / lineHasBackgroundJob detect status masking", () => {
    expect(lineMasksShellStatus("task check || true")).toBe(true);
    expect(lineMasksShellStatus("task check | cat")).toBe(true);
    expect(lineMasksShellStatus("task check; echo done")).toBe(true);
    expect(lineMasksShellStatus("task check 2>&1")).toBe(false);
    expect(lineHasBackgroundJob("task check &")).toBe(true);
    expect(lineHasBackgroundJob("task check & echo")).toBe(true);
    expect(lineHasBackgroundJob("task check 2>&1")).toBe(false);
    expect(lineHasBackgroundJob("task check &>out")).toBe(false);
  });

  it("lineMasksCheckFailure only when check-like with maskers", () => {
    expect(lineMasksCheckFailure("echo hello || true")).toBe(false);
    expect(lineMasksCheckFailure("deft check || true")).toBe(true);
    expect(lineMasksCheckFailure("task check | tee log")).toBe(true);
    expect(lineMasksCheckFailure("directive check; echo x")).toBe(true);
    expect(lineMasksCheckFailure("task check:consumer || :")).toBe(true);
    expect(lineMasksCheckFailure("task check &")).toBe(true);
    expect(lineMasksCheckFailure("task check")).toBe(false);
  });

  it("lineHasCommandPositionRunner rejects arg-only and masked forms", () => {
    const re = /^(?:task\s+)?check\b/;
    expect(lineHasCommandPositionRunner("task check", re)).toBe(true);
    expect(lineHasCommandPositionRunner("printf 'task check'", re)).toBe(false);
    expect(lineHasCommandPositionRunner("echo task check", re)).toBe(false);
    expect(lineHasCommandPositionRunner("task check || true", re)).toBe(false);
    expect(lineHasCommandPositionRunner("FOO=1 task check", re)).toBe(true);
    // Lines starting with the shell builtin `true` are treated as non-runners.
    expect(lineHasCommandPositionRunner("true && task check", re)).toBe(false);
    expect(lineHasCommandPositionRunner("task check &", re)).toBe(false);
    expect(lineHasCommandPositionRunner("ok && task check", re)).toBe(true);
  });

  it("runCommandIsFullCheck and runCommandInvokesGate scan executable lines only", () => {
    expect(runCommandIsFullCheck("echo task check\ntask check")).toBe(true);
    expect(runCommandIsFullCheck("echo 'task check'")).toBe(false);
    expect(runCommandIsFullCheck("sudo deft check")).toBe(true);
    expect(runCommandIsFullCheck("task check:framework-source")).toBe(true);
    expect(runCommandIsFullCheck("task check:consumer")).toBe(true);

    expect(runCommandInvokesGate("task verify:test-boundary", "verify:test-boundary")).toBe(true);
    expect(runCommandInvokesGate("deft verify-test-boundary", "verify:test-boundary")).toBe(true);
    expect(runCommandInvokesGate("npm run verify:test-boundary", "verify:test-boundary")).toBe(
      true,
    );
    expect(runCommandInvokesGate("echo verify:test-boundary", "verify:test-boundary")).toBe(false);
    // Mask predicate is check-specific; verify:* chains still invoke the gate.
    expect(runCommandInvokesGate("task verify:test-boundary || true", "verify:test-boundary")).toBe(
      true,
    );
    expect(runCommandInvokesGate("task verify:test-boundary &", "verify:test-boundary")).toBe(
      false,
    );
  });
});
