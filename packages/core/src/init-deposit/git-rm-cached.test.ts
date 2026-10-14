import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGitRmCached } from "./git-rm-cached.js";

describe("runGitRmCached", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function gitRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
    return root;
  }

  it("removes a tracked path from the index only", () => {
    const root = gitRoot("grc-untrack-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "keep.json"), "{}\n", "utf8");
    execFileSync("git", ["add", "-f", ".deft/keep.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "seed"], {
      cwd: root,
      stdio: "ignore",
    });

    const result = runGitRmCached(root, [".deft/keep.json"]);
    expect(result.ok).toBe(true);
    const tracked = execFileSync("git", ["ls-files", "--", ".deft/keep.json"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");
    expect(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" })).toContain(
      "D  .deft/keep.json",
    );
  });

  it("ignoreUnmatch succeeds when the path is already untracked", () => {
    const root = gitRoot("grc-ignore-");
    writeFileSync(join(root, "README"), "x\n", "utf8");
    execFileSync("git", ["add", "README"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "seed"], {
      cwd: root,
      stdio: "ignore",
    });

    const without = runGitRmCached(root, [".deft/missing.json"]);
    expect(without.ok).toBe(false);

    const withIgnore = runGitRmCached(root, [".deft/missing.json"], { ignoreUnmatch: true });
    expect(withIgnore.ok).toBe(true);
  });
});
