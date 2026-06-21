import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "../dispatch.js";
import { runDispatch } from "./helpers.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "deft-test",
      GIT_AUTHOR_EMAIL: "test@test.local",
      GIT_COMMITTER_NAME: "deft-test",
      GIT_COMMITTER_EMAIL: "test@test.local",
    },
  });
}

function buildRepo(branch = "master"): { root: string; vbriefPath: string } {
  const root = mkdtempSync(join(tmpdir(), "deft-lc-pf-"));
  temps.push(root);
  const dir = join(root, "vbrief", "active");
  mkdirSync(dir, { recursive: true });
  const vbriefPath = join(dir, "story.vbrief.json");
  writeFileSync(
    vbriefPath,
    JSON.stringify({
      plan: { status: "running", title: "T", items: [] },
      vBRIEFInfo: { version: "0.6" },
    }),
    "utf8",
  );
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "PROJECT-DEFINITION", status: "running", items: [] },
    }),
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["branch", "-M", branch], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  gitCommit(root, "init");
  return { root, vbriefPath };
}

describe("deft-ts preflight / verify gates (#1838 s3)", () => {
  it("resolves verify and preflight task aliases", () => {
    expect(resolveCanonicalVerb("verify:story-ready")).toBe("verify-story-ready");
    expect(resolveCanonicalVerb("verify:branch")).toBe("verify-branch");
    expect(resolveCanonicalVerb("vbrief:preflight")).toBe("vbrief-preflight");
  });

  it("verify-story-ready requires --vbrief-path", async () => {
    const result = await runDispatch(["verify-story-ready"]);
    expect(result.exitCode).toBe(2);
  });

  it("verify:story-ready alias matches canonical on clean repo", async () => {
    const { root, vbriefPath } = buildRepo();
    const canonical = await runDispatch([
      "verify-story-ready",
      "--vbrief-path",
      vbriefPath,
      "--project-root",
      root,
    ]);
    const alias = await runDispatch([
      "verify:story-ready",
      "--vbrief-path",
      vbriefPath,
      "--project-root",
      root,
    ]);
    expect(alias.exitCode).toBe(canonical.exitCode);
    expect(canonical.exitCode).toBe(0);
  });

  it("verify-branch blocks default-branch commits by default", async () => {
    const { root } = buildRepo("master");
    const result = await runDispatch(["verify-branch", "--project-root", root]);
    expect(result.exitCode).toBe(1);
  });

  it("verify:branch alias matches verify-branch exit code", async () => {
    const { root } = buildRepo("master");
    const canonical = await runDispatch(["verify-branch", "--project-root", root]);
    const alias = await runDispatch(["verify:branch", "--project-root", root]);
    expect(alias.exitCode).toBe(canonical.exitCode);
  });

  it("verify-story-ready returns 2 for unknown flags", async () => {
    const { root, vbriefPath } = buildRepo();
    const result = await runDispatch([
      "verify-story-ready",
      "--vbrief-path",
      vbriefPath,
      "--project-root",
      root,
      "--not-real",
    ]);
    expect(result.exitCode).toBe(2);
  });
});
