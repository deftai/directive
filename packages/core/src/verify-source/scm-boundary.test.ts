import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateFiles, evaluateScmBoundary, renderScmFinding, scanFile } from "./scm-boundary.js";

const CLEAN_BODY = `import scm
def do_thing() -> None:
    scm.call("github-issue", "issue", ["view", "1"], check=True)
`;

const VIOLATION_BODY = `import subprocess
def do_thing() -> None:
    subprocess.run(["gh", "issue", "view", "1"], check=True)
`;

function writeScripts(root: string, files: Record<string, string>): void {
  const scripts = join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(scripts, name), body, "utf8");
  }
}

describe("evaluateScmBoundary", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 on clean verb-layer tree", () => {
    root = mkdtempSync(join(tmpdir(), "scm-clean-"));
    writeScripts(root, {
      "triage_actions.py": CLEAN_BODY,
      "scope_lifecycle.py": CLEAN_BODY,
    });
    const result = evaluateScmBoundary(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.message).toContain("2 verb-layer file(s)");
  });

  it("exits 1 when subprocess.run gh is present", () => {
    root = mkdtempSync(join(tmpdir(), "scm-viol-"));
    writeScripts(root, { "triage_actions.py": VIOLATION_BODY });
    const result = evaluateScmBoundary(root);
    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.helper).toBe("subprocess.run");
    expect(result.findings[0]?.line).toBe(3);
    expect(result.message).toContain("scm.call");
  });

  it("exits 2 when allow-list path is missing", () => {
    root = mkdtempSync(join(tmpdir(), "scm-cfg-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    const result = evaluateScmBoundary(root, {
      allowListPath: join(root, "missing.txt"),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("not found");
  });

  it("exits 2 when project root is not a directory", () => {
    root = mkdtempSync(join(tmpdir(), "scm-bad-"));
    const bogus = join(root, "not-a-dir");
    const result = evaluateScmBoundary(bogus);
    expect(result.code).toBe(2);
    expect(result.message).toContain("is not a directory");
  });

  it("honours allow-list exemptions", () => {
    root = mkdtempSync(join(tmpdir(), "scm-allow-"));
    writeScripts(root, { "triage_actions.py": VIOLATION_BODY });
    const allow = join(root, "allow.txt");
    writeFileSync(allow, "scripts/triage_actions.py\n", "utf8");
    const result = evaluateScmBoundary(root, { allowListPath: allow });
    expect(result.code).toBe(0);
  });

  it("does not scan release.py out of scope", () => {
    root = mkdtempSync(join(tmpdir(), "scm-scope-"));
    writeScripts(root, { "release.py": VIOLATION_BODY });
    const result = evaluateScmBoundary(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });
});

describe("renderScmFinding", () => {
  it("truncates long context at 120 chars", () => {
    const long = "x".repeat(200);
    const line = renderScmFinding({
      path: "scripts/a.py",
      line: 1,
      col: 1,
      helper: "subprocess.run",
      context: long,
    });
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(long.length);
  });
});

describe("scanFile multiline gh call", () => {
  it("detects multiline subprocess.run list form", () => {
    const body = `import subprocess
def do_thing():
    subprocess.run(
        [
            "gh",
            "issue",
            "close",
            "1",
        ],
        check=True,
    )
`;
    const root = mkdtempSync(join(tmpdir(), "scm-multi-"));
    try {
      writeScripts(root, { "triage_welcome.py": body });
      const files = candidateFiles(root);
      const match = files.find(([rel]) => rel === "scripts/triage_welcome.py");
      expect(match).toBeDefined();
      if (match === undefined) {
        return;
      }
      const findings = scanFile(match[0], match[1]);
      expect(findings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
