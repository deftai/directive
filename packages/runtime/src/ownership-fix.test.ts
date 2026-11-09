import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./ownership-fix.js";
import {
  contentsEqualIgnoringEol,
  ensureGitHooks,
  ensureManagedPathGitattributes,
  ensureSlashCommands,
  GITATTRIBUTES_STAGING_SKIPPED_DIRTY,
  isShellHookEntrypoint,
  normalizeEol,
  pathHasUnstagedChanges,
} from "./setup-wiring.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

function tempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ownership-fix-hooks-"));
  TEMPS.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function writeHook(root: string, rel: string, body: string): void {
  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
}

describe("ownership:fix CLI (#1617)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseArgs accepts project-root, owner, and json", () => {
    expect(parseArgs(["--project-root", "/tmp/p", "--owner", "1000:1000", "--json"])).toEqual({
      projectRoot: "/tmp/p",
      owner: "1000:1000",
      json: true,
    });
  });

  it("parseArgs swallows -- so documented task/cli forms work (#1617)", () => {
    expect(parseArgs(["--", "--project-root", ".", "--owner", "1000:1000"])).toEqual({
      projectRoot: ".",
      owner: "1000:1000",
      json: false,
    });
  });

  it("parseArgs rejects missing values and unknown flags", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--owner"]).error).toMatch(/expected uid:gid/);
    expect(parseArgs(["--nope"]).error).toMatch(/unrecognized argument/);
  });

  it("run --help documents no blanket HOME chown", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(run(["--help"])).toBe(0);
    expect(chunks.join("")).toContain("No blanket HOME chown");
    expect(chunks.join("")).toContain("DEFT_PROJECT_OWNER");
  });

  it("run rejects bad argv with exit 2", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    expect(run(["--wat"])).toBe(2);
    expect(err.join("")).toMatch(/unrecognized argument/);
  });
});

describe("EOL-normalized ownership/wrapper compare (#5995)", () => {
  it("normalizeEol collapses CRLF and CR to LF", () => {
    expect(normalizeEol("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("contentsEqualIgnoringEol treats CRLF-only diffs as equal", () => {
    const lf = "---\ndescription: x\n---\nRead and follow `path`\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(contentsEqualIgnoringEol(lf, crlf)).toBe(true);
    expect(contentsEqualIgnoringEol(lf, lf.replace("path", "other"))).toBe(false);
  });

  it("isShellHookEntrypoint covers .githooks shell scripts and bare hook names", () => {
    expect(isShellHookEntrypoint(".githooks/pre-commit")).toBe(true);
    expect(isShellHookEntrypoint(".githooks/pre-push")).toBe(true);
    expect(isShellHookEntrypoint(".githooks/_directive-run.sh")).toBe(true);
    expect(isShellHookEntrypoint(".githooks/_deft-run.sh")).toBe(true);
    expect(isShellHookEntrypoint(".agents/skills/deft/SKILL.md")).toBe(false);
    expect(isShellHookEntrypoint(".claude/commands/foo.md")).toBe(false);
  });
});

describe("ensureManagedPathGitattributes staging report (#5995 / #6151 P1)", () => {
  function initGitRepo(root: string): void {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "attrs@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Attrs"], { cwd: root });
  }

  it("reports created when .gitattributes is newly written", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-created-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    const out = ensureManagedPathGitattributes(root);
    expect(out.wrote).toBe(true);
    expect(out.created).toBe(true);
    expect(out.modified).toBe(false);
    expect(out.stagingSkippedNotice).toBeUndefined();
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toContain(
      ".githooks/** text=auto eol=lf",
    );
  });

  it("reports modified when extending an existing .gitattributes", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-modified-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    writeFileSync(join(root, ".gitattributes"), "*.md text\n");
    const out = ensureManagedPathGitattributes(root);
    expect(out.wrote).toBe(true);
    expect(out.created).toBe(false);
    expect(out.modified).toBe(true);
    expect(out.stagingSkippedNotice).toBeUndefined();
  });

  it("reports neither when attributes already complete", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-skip-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    expect(ensureManagedPathGitattributes(root).wrote).toBe(true);
    const second = ensureManagedPathGitattributes(root);
    expect(second.wrote).toBe(false);
    expect(second.created).toBe(false);
    expect(second.modified).toBe(false);
  });

  it("ensureSlashCommands surfaces .gitattributes on created/modified lists", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-slash-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const first = ensureSlashCommands(root);
    expect(first.created).toContain(".gitattributes");
    expect(first.modified).not.toContain(".gitattributes");
    expect(first.notices).toEqual([]);
    const second = ensureSlashCommands(root);
    expect(second.created).not.toContain(".gitattributes");
    expect(second.modified).not.toContain(".gitattributes");
    expect(second.notices).toEqual([]);
  });

  it("reports modified for a clean tracked .gitattributes missing LF pins", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-clean-tracked-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    writeFileSync(join(root, ".gitattributes"), "*.md text\n");
    initGitRepo(root);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "seed attrs"], { cwd: root });
    expect(pathHasUnstagedChanges(root, ".gitattributes")).toBe(false);

    const out = ensureManagedPathGitattributes(root);
    expect(out.wrote).toBe(true);
    expect(out.created).toBe(false);
    expect(out.modified).toBe(true);
    expect(out.stagingSkippedNotice).toBeUndefined();
    expect(readFileSync(join(root, ".gitattributes"), "utf8")).toContain(
      ".githooks/** text=auto eol=lf",
    );
  });

  it("writes LF pins but skips modified when .gitattributes already has unstaged edits", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-dirty-tracked-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    writeFileSync(join(root, ".gitattributes"), "*.md text\n");
    initGitRepo(root);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "seed attrs"], { cwd: root });
    // Unfinished user WIP on the tracked file, still missing LF pins.
    writeFileSync(join(root, ".gitattributes"), "*.md text\n*.json text\n");
    expect(pathHasUnstagedChanges(root, ".gitattributes")).toBe(true);

    const out = ensureManagedPathGitattributes(root);
    expect(out.wrote).toBe(true);
    expect(out.created).toBe(false);
    expect(out.modified).toBe(false);
    expect(out.stagingSkippedNotice).toBe(GITATTRIBUTES_STAGING_SKIPPED_DIRTY);
    const body = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(body).toContain("*.json text");
    expect(body).toContain(".githooks/** text=auto eol=lf");
  });

  it("ensureSlashCommands omits dirty .gitattributes from modified and surfaces notice", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-dirty-slash-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    writeFileSync(join(root, ".gitattributes"), "*.md text\n");
    initGitRepo(root);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "seed attrs"], { cwd: root });
    writeFileSync(join(root, ".gitattributes"), "*.md text\n*.json text\n");
    mkdirSync(join(root, "xbrief"), { recursive: true });

    const slash = ensureSlashCommands(root);
    expect(slash.created).not.toContain(".gitattributes");
    expect(slash.modified).not.toContain(".gitattributes");
    expect(slash.notices).toContain(GITATTRIBUTES_STAGING_SKIPPED_DIRTY);
    const body = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(body).toContain("*.json text");
    expect(body).toContain(".githooks/** text=auto eol=lf");
  });
});

describe("ensureGitHooks CRLF shell entrypoint repair (#5995 / #6151 P1)", () => {
  const customPrePush = `#!/usr/bin/env sh
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
. "$REPO_ROOT/.githooks/_directive-run.sh"
run_directive preflight-gh --pre-push-stdin --project-root "$REPO_ROOT" || exit $?
`;

  it("rewrites CRLF-only managed hooks to LF even when EOL-normalized equal", () => {
    const root = tempGitRepo();
    // Seed desired OVPR bodies first, then convert on-disk bytes to CRLF (autocrlf checkout).
    ensureGitHooks(root);
    for (const rel of [
      ".githooks/_directive-run.sh",
      ".githooks/pre-commit",
      ".githooks/pre-push",
    ] as const) {
      const lf = readFileSync(join(root, rel), "utf8");
      expect(lf.includes("\r")).toBe(false);
      writeHook(root, rel, lf.replace(/\n/g, "\r\n"));
      expect(readFileSync(join(root, rel), "utf8").includes("\r\n")).toBe(true);
    }

    const out = ensureGitHooks(root);
    expect(out.conflicts).toEqual([]);
    expect(out.preserved).toEqual([]);
    for (const rel of [
      ".githooks/_directive-run.sh",
      ".githooks/pre-commit",
      ".githooks/pre-push",
    ] as const) {
      const body = readFileSync(join(root, rel), "utf8");
      expect(body.includes("\r"), `${rel} must be LF after repair`).toBe(false);
      expect(out.modified).toContain(rel);
    }
  });

  it("still preserves tracked content-divergent hooks (not CRLF-only)", () => {
    const root = tempGitRepo();
    writeHook(root, ".githooks/pre-push", customPrePush.replace(/\n/g, "\r\n"));
    execFileSync("git", ["add", "--", ".githooks/pre-push"], { cwd: root });
    const out = ensureGitHooks(root);
    expect(out.preserved.join("\n")).toContain(".githooks/pre-push");
    expect(out.modified).not.toContain(".githooks/pre-push");
    expect(readFileSync(join(root, ".githooks/pre-push"), "utf8")).toContain("\r\n");
  });
});
