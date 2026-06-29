import { describe, expect, it } from "vitest";
import { scanPythonGhCalls } from "./python-call-scan.js";

describe("scanPythonGhCalls", () => {
  it("finds subprocess.run gh violations", () => {
    const source = `import subprocess
def do_thing():
    subprocess.run(["gh", "issue", "view", "1"])
`;
    const sites = scanPythonGhCalls(source);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.helper).toBe("subprocess.run");
    expect(sites[0]?.line).toBe(3);
  });

  it("finds os.system gh shell strings", () => {
    const source = `import os
def do_thing():
    os.system("gh issue close 1")
`;
    const sites = scanPythonGhCalls(source);
    expect(sites[0]?.helper).toBe("os.system");
  });

  it("ignores scm.call usage", () => {
    const source = `import scm
scm.call("github-issue", "issue", ["view"])
`;
    expect(scanPythonGhCalls(source)).toHaveLength(0);
  });

  it("ignores subprocess.run when argv is empty", () => {
    const source = `import subprocess
subprocess.run([])
`;
    expect(scanPythonGhCalls(source)).toHaveLength(0);
  });

  it("ignores os.system when the shell command is not gh", () => {
    const source = `import os
os.system("git status")
`;
    expect(scanPythonGhCalls(source)).toHaveLength(0);
  });

  it("finds gh when subprocess.run uses a parenthesized argv tuple", () => {
    const source = `import subprocess
subprocess.run(("gh", "api", "rate_limit"))
`;
    const sites = scanPythonGhCalls(source);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.helper).toBe("subprocess.run");
  });
});
