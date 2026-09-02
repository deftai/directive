import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsRefreshPlan } from "./agents-md.js";
import { checkInstallPathConsistency } from "./checks.js";
import { includesBlockHasDeftTaskfile } from "./taskfile.js";

function gitIn(dir: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], {
    cwd: dir,
    stdio: "ignore",
    timeout: 10_000,
  });
}

describe("agents-md git integration", () => {
  it("resolves framework sha via git by default", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-sha-"));
    try {
      gitIn(root, ["init", "-q"]);
      gitIn(root, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "init"]);
      const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      }).trim();
      const rendered =
        "<!-- deft:managed-section v3 -->" + "\nbody\n" + "<!-- /deft:managed-section -->";
      const plan = agentsRefreshPlan(root, {
        readTemplate: () => rendered,
        readAgents: () => null,
        nowIso: () => "2026-01-01T00:00:00Z",
        newSession: () => "abcd1234efgh",
        frameworkRoot: root,
      });
      expect(plan.state).toBe("absent");
      expect(plan.sha).toBe(head);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("taskfile re-entry", () => {
  it("finds include after closing prior block", () => {
    const yaml =
      "includes:\n  other:\n    taskfile: ./other.yml\n\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n";
    expect(includesBlockHasDeftTaskfile(yaml)).toBe(true);
  });
});

describe("install path manifest root", () => {
  it("prefers manifest install_root field", () => {
    const result = checkInstallPathConsistency("/tmp", ".deft/core", {
      isDir: (p) => p.endsWith(`custom${sep}core`),
      readText: () => "install_root: custom/core\n",
    });
    expect(result.status).toBe("pass");
    expect(result.data?.effective_install_root_source).toBe("manifest");
  });
});
