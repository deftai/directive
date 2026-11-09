import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./ownership-fix.js";
import {
  contentsEqualIgnoringEol,
  ensureManagedPathGitattributes,
  ensureSlashCommands,
  isShellHookEntrypoint,
  normalizeEol,
} from "./setup-wiring.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

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
  it("reports created when .gitattributes is newly written", () => {
    const root = mkdtempSync(join(tmpdir(), "attrs-created-"));
    TEMPS.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t" })}\n`);
    const out = ensureManagedPathGitattributes(root);
    expect(out.wrote).toBe(true);
    expect(out.created).toBe(true);
    expect(out.modified).toBe(false);
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
    const second = ensureSlashCommands(root);
    expect(second.created).not.toContain(".gitattributes");
    expect(second.modified).not.toContain(".gitattributes");
  });
});
