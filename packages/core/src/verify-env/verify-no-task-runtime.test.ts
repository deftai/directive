import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatScanResult, scan } from "./verify-no-task-runtime.js";

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
  temps.length = 0;
});

describe("scan", () => {
  it("allows non-task subprocesses", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-notask-clean-"));
    temps.push(root);
    const probe = join(root, "probe.py");
    writeFileSync(
      probe,
      'import subprocess\nsubprocess.run(["git", "status"], check=True)\n',
      "utf8",
    );
    expect(scan({ root, pythonFiles: () => [probe] })).toEqual([]);
  });

  it("flags task subprocess and path probe", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-notask-find-"));
    temps.push(root);
    const probe = join(root, "probe.py");
    writeFileSync(
      probe,
      'import shutil\nimport subprocess\nsubprocess.check_output(["task", "check"])\nshutil.which("task")\n',
      "utf8",
    );
    const findings = scan({ root, pythonFiles: () => [probe] });
    expect(findings.map((f) => f.line)).toEqual([3, 4]);
  });

  it("formats clean scan output", () => {
    const formatted = formatScanResult([]);
    expect(formatted.exitCode).toBe(0);
    expect(formatted.stdout).toBe("No runtime go-task subprocess dependencies found\n");
  });

  it("formats finding output on stderr", () => {
    const formatted = formatScanResult([
      { path: "scripts/x.py", line: 2, message: "runtime go-task PATH probe is forbidden" },
    ]);
    expect(formatted.exitCode).toBe(1);
    expect(formatted.stderr).toContain("Runtime go-task dependencies found:");
  });
});

describe("scan import aliases", () => {
  it("flags aliased imports", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-notask-alias-"));
    temps.push(root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    const probe = join(root, "scripts", "probe.py");
    writeFileSync(
      probe,
      [
        "import shutil as sh",
        "import subprocess as sp",
        "from shutil import which as find_tool",
        "from subprocess import run as run_process",
        'sp.run(["task", "check"])',
        'run_process(("task", "check"))',
        'sh.which("task")',
        'find_tool("task")',
      ].join("\n"),
      "utf8",
    );
    const findings = scan({ root, pythonFiles: () => [probe] });
    expect(findings.map((f) => f.line)).toEqual([5, 6, 7, 8]);
  });
});
