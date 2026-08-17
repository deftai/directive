/**
 * Product-state hash for AC bank reuse (#3387).
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashProductState } from "./product-state-hash.js";

describe("hashProductState (#3387)", () => {
  it("is complete for explicit product files and changes when they change", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.txt"), "a\n", "utf8");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const first = hashProductState({
      projectRoot: root,
      plan,
      productPaths: ["src/app.txt"],
    });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("src/app.txt");
    writeFileSync(join(root, "src", "app.txt"), "b\n", "utf8");
    const second = hashProductState({
      projectRoot: root,
      plan,
      productPaths: ["src/app.txt"],
    });
    expect(second.digest).not.toBe(first.digest);
  });

  it("expands glob file_scope and fails closed when the glob matches nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-glob-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["src/*.ts"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("src/a.ts");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);

    const empty = hashProductState({
      projectRoot: root,
      plan: {
        acceptance: { commands: [{ command: "true" }] },
        metadata: { swarm: { file_scope: ["missing/*.ts"] } },
      },
    });
    expect(empty.complete).toBe(false);
    expect(empty.files).toEqual([]);
  });

  it("expands character-class globs and fails closed when brace globs match nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-extglob-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n", "utf8");
    const classPlan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["src/[ab].ts"] } },
    };
    const first = hashProductState({ projectRoot: root, plan: classPlan });
    expect(first.complete).toBe(true);
    expect(first.files).toEqual(["src/a.ts", "src/b.ts"]);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan: classPlan });
    expect(second.digest).not.toBe(first.digest);

    const brace = hashProductState({
      projectRoot: root,
      plan: {
        acceptance: { commands: [{ command: "true" }] },
        metadata: { swarm: { file_scope: ["src/{missing,also-missing}.ts"] } },
      },
    });
    expect(brace.complete).toBe(false);
    expect(brace.files).toEqual([]);
  });

  it("includes a character-class-selected dotfile and invalidates the digest when it changes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-classdot-"));
    mkdirSync(join(root, "frontend"), { recursive: true });
    writeFileSync(join(root, "frontend", "app.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(join(root, "frontend", ".app.ts"), "export const hidden = 1;\n", "utf8");
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/[ab]*"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/app.ts");
    expect(first.files).toContain("frontend/.app.ts");
    writeFileSync(join(root, "frontend", ".app.ts"), "export const hidden = 2;\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("includes a wildcard-selected dotfile and invalidates the digest when it changes", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-dot-"));
    mkdirSync(join(root, "frontend"), { recursive: true });
    writeFileSync(join(root, "frontend", "app.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(join(root, "frontend", ".env"), "SECRET=1\n", "utf8");
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/*"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/app.ts");
    expect(first.files).toContain("frontend/.env");
    writeFileSync(join(root, "frontend", ".env"), "SECRET=2\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("includes a hidden file under an ordinary mixed-wildcard segment", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-mixdot-"));
    mkdirSync(join(root, "frontend", "app"), { recursive: true });
    writeFileSync(join(root, "frontend", "app", "main.ts"), "export const main = 1;\n", "utf8");
    writeFileSync(
      join(root, "frontend", "app", ".config.ts"),
      "export const secret = 1;\n",
      "utf8",
    );
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/*/*.ts"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/app/main.ts");
    expect(first.files).toContain("frontend/app/.config.ts");
    writeFileSync(
      join(root, "frontend", "app", ".config.ts"),
      "export const secret = 2;\n",
      "utf8",
    );
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("includes a negated-class match under a hidden directory", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-negclass-"));
    mkdirSync(join(root, "frontend", ".generated"), { recursive: true });
    writeFileSync(join(root, "frontend", "app.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(join(root, "frontend", ".generated", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "frontend", ".generated", "b.ts"), "export const b = 1;\n", "utf8");
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/**/[!a]*.ts"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/.generated/b.ts");
    expect(first.files).not.toContain("frontend/.generated/a.ts");
    expect(first.files).not.toContain("frontend/app.ts");
    writeFileSync(join(root, "frontend", ".generated", "b.ts"), "export const b = 2;\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("includes brace-alternative files under a hidden directory", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-brace-"));
    mkdirSync(join(root, "frontend", ".generated"), { recursive: true });
    writeFileSync(join(root, "frontend", "app.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(
      join(root, "frontend", ".generated", "config.ts"),
      "export const generated = 1;\n",
      "utf8",
    );
    writeFileSync(
      join(root, "frontend", ".generated", "config.js"),
      "export const generatedJs = 1;\n",
      "utf8",
    );
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/**/*.{ts,js}"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/app.ts");
    expect(first.files).toContain("frontend/.generated/config.ts");
    expect(first.files).toContain("frontend/.generated/config.js");
    writeFileSync(
      join(root, "frontend", ".generated", "config.js"),
      "export const generatedJs = 2;\n",
      "utf8",
    );
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("includes a file under a hidden directory in a recursive ** file glob", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-hiddendir-"));
    mkdirSync(join(root, "frontend", ".generated"), { recursive: true });
    writeFileSync(join(root, "frontend", "app.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(
      join(root, "frontend", ".generated", "config.ts"),
      "export const generated = 1;\n",
      "utf8",
    );
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/**/*.ts"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/app.ts");
    expect(first.files).toContain("frontend/.generated/config.ts");
    writeFileSync(
      join(root, "frontend", ".generated", "config.ts"),
      "export const generated = 2;\n",
      "utf8",
    );
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("includes a nested leading-dot file under a recursive ** scope", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-recdot-"));
    mkdirSync(join(root, "frontend", "a"), { recursive: true });
    writeFileSync(join(root, "frontend", "a", "app.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(join(root, "frontend", "a", ".env"), "SECRET=1\n", "utf8");
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/**"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/a/app.ts");
    expect(first.files).toContain("frontend/a/.env");
    writeFileSync(join(root, "frontend", "a", ".env"), "SECRET=2\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("terminates when a directory symlink cycle is present", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-cycle-"));
    mkdirSync(join(root, "frontend"), { recursive: true });
    writeFileSync(join(root, "frontend", "app.ts"), "export const app = 1;\n", "utf8");
    const loop = join(root, "frontend", "loop");
    const target = join(root, "frontend");
    try {
      symlinkSync(target, loop, process.platform === "win32" ? "junction" : "dir");
    } catch {
      expect.fail("could not create a directory symlink cycle");
    }
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend"] } },
    };
    const hashed = hashProductState({ projectRoot: root, plan });
    expect(hashed.complete).toBe(true);
    expect(hashed.files).toContain("frontend/app.ts");
  }, 3_000);

  it("walks directories matched by a glob so nested edits change the digest", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-globdir-"));
    mkdirSync(join(root, "frontend", "lib"), { recursive: true });
    writeFileSync(join(root, "frontend", "app.ts"), "export const app = 1;\n", "utf8");
    writeFileSync(join(root, "frontend", "lib", "util.ts"), "export const util = 1;\n", "utf8");
    const plan = {
      acceptance: { commands: [{ command: "true" }] },
      metadata: { swarm: { file_scope: ["frontend/*"] } },
    };
    const first = hashProductState({ projectRoot: root, plan });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("frontend/app.ts");
    expect(first.files).toContain("frontend/lib/util.ts");
    writeFileSync(join(root, "frontend", "lib", "util.ts"), "export const util = 2;\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan });
    expect(second.digest).not.toBe(first.digest);
  });

  it("uses file_scope when productPaths are omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-scope-"));
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "pkg", "a.ts"), "1\n", "utf8");
    const hashed = hashProductState({
      projectRoot: root,
      plan: {
        acceptance: { commands: [] },
        metadata: { swarm: { file_scope: ["pkg"] } },
      },
    });
    expect(hashed.complete).toBe(true);
    expect(hashed.files.some((f) => f.startsWith("pkg/"))).toBe(true);
  });

  it("hashes the rename destination from NUL porcelain, not the old source", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-rename-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "dest.ts"), "v1\n", "utf8");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const runGit = (_cwd: string, args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "abc123", stderr: "" };
      }
      if (args.includes("-z")) {
        return { code: 0, stdout: "R  dest.ts\0src.ts\0", stderr: "" };
      }
      return { code: 0, stdout: "R  src.ts -> dest.ts", stderr: "" };
    };
    const first = hashProductState({ projectRoot: root, plan, runGit });
    expect(first.files).toContain("dest.ts");
    expect(first.files).not.toContain("src.ts");
    writeFileSync(join(root, "dest.ts"), "v2\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan, runGit });
    expect(second.digest).not.toBe(first.digest);
  });

  it("keeps invalid UTF-8 bytes from successful NUL porcelain so later edits change the digest", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-z-badutf8-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const name = Buffer.from([0x66, 0x66, 0xff, 0x2e, 0x74, 0x73]).toString("latin1");
    writeFileSync(join(root, name), "v1\n");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const zed = Buffer.concat([
      Buffer.from("?? ", "utf8"),
      Buffer.from([0x66, 0x66, 0xff, 0x2e, 0x74, 0x73]),
      Buffer.from("\0"),
    ]).toString("latin1");
    const runGit = (_cwd: string, args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "abc123", stderr: "" };
      }
      if (args.includes("-z")) {
        return { code: 0, stdout: zed, stderr: "" };
      }
      return { code: 0, stdout: '?? "ff\\377.ts"', stderr: "" };
    };
    const first = hashProductState({ projectRoot: root, plan, runGit });
    expect(first.complete).toBe(true);
    expect(first.files).toContain(name);
    expect(first.files).not.toContain("ff\uFFFD.ts");
    writeFileSync(join(root, name), "v2\n");
    const second = hashProductState({ projectRoot: root, plan, runGit });
    expect(second.digest).not.toBe(first.digest);
  });

  it("keeps invalid UTF-8 octal porcelain bytes so later edits change the digest", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-badutf8-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const name = Buffer.from([0x66, 0x66, 0xff, 0x2e, 0x74, 0x73]).toString("latin1");
    writeFileSync(join(root, name), "v1\n");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const runGit = (_cwd: string, args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "abc123", stderr: "" };
      }
      if (args.includes("-z")) {
        return { code: 1, stdout: "", stderr: "nul unavailable" };
      }
      return { code: 0, stdout: '?? "ff\\377.ts"', stderr: "" };
    };
    const first = hashProductState({ projectRoot: root, plan, runGit });
    expect(first.complete).toBe(true);
    expect(first.files).toContain(name);
    expect(first.files).not.toContain("ff\uFFFD.ts");
    writeFileSync(join(root, name), "v2\n");
    const second = hashProductState({ projectRoot: root, plan, runGit });
    expect(second.digest).not.toBe(first.digest);
  });

  it("decodes UTF-8 octal C-quoted porcelain so later edits change the digest", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-octal-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    const name = "caf\u00e9.ts";
    writeFileSync(join(root, name), "v1\n", "utf8");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const runGit = (_cwd: string, args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "abc123", stderr: "" };
      }
      if (args.includes("-z")) {
        return { code: 1, stdout: "", stderr: "nul unavailable" };
      }
      return { code: 0, stdout: '?? "caf\\303\\251.ts"', stderr: "" };
    };
    const first = hashProductState({ projectRoot: root, plan, runGit });
    expect(first.complete).toBe(true);
    expect(first.files).toContain(name);
    expect(first.files).not.toContain("caf\u00c3\u00a9.ts");
    writeFileSync(join(root, name), "v2\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan, runGit });
    expect(second.digest).not.toBe(first.digest);
  });

  it("parses C-quoted rename destinations from non-NUL porcelain", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-qrename-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "new name.ts"), "v1\n", "utf8");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const runGit = (_cwd: string, args: readonly string[]) => {
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "abc123", stderr: "" };
      }
      if (args.includes("-z")) {
        return { code: 1, stdout: "", stderr: "nul unavailable" };
      }
      return { code: 0, stdout: 'R  "old name.ts" -> "new name.ts"', stderr: "" };
    };
    const first = hashProductState({ projectRoot: root, plan, runGit });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("new name.ts");
    expect(first.files).not.toContain('"new name.ts');
    expect(first.files).not.toContain("old name.ts");
    writeFileSync(join(root, "new name.ts"), "v2\n", "utf8");
    const second = hashProductState({ projectRoot: root, plan, runGit });
    expect(second.digest).not.toBe(first.digest);
  });

  it("unquotes C-quoted porcelain dirty paths so later edits change the digest", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-quote-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "weird name.ts"), "v1\n", "utf8");
    const plan = { acceptance: { commands: [{ command: "true" }] } };
    const first = hashProductState({
      projectRoot: root,
      plan,
      runGit: (_cwd, args) => {
        if (args.includes("rev-parse")) {
          return { code: 0, stdout: "abc123", stderr: "" };
        }
        if (args.includes("-z")) {
          return { code: 0, stdout: "?? weird name.ts\0", stderr: "" };
        }
        return { code: 0, stdout: '?? "weird name.ts"', stderr: "" };
      },
    });
    expect(first.complete).toBe(true);
    expect(first.files).toContain("weird name.ts");
    writeFileSync(join(root, "weird name.ts"), "v2\n", "utf8");
    const second = hashProductState({
      projectRoot: root,
      plan,
      runGit: (_cwd, args) => {
        if (args.includes("rev-parse")) {
          return { code: 0, stdout: "abc123", stderr: "" };
        }
        if (args.includes("-z")) {
          return { code: 0, stdout: "?? weird name.ts\0", stderr: "" };
        }
        return { code: 0, stdout: '?? "weird name.ts"', stderr: "" };
      },
    });
    expect(second.digest).not.toBe(first.digest);
  });

  it("ignores xbrief lifecycle files when walking a non-git tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-3387-psh-walk-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "s.xbrief.json"), "{}\n", "utf8");
    writeFileSync(join(root, "app.txt"), "p\n", "utf8");
    const hashed = hashProductState({
      projectRoot: root,
      plan: { acceptance: { commands: [{ command: "true" }] } },
    });
    expect(hashed.files).toContain("app.txt");
    expect(hashed.files.some((f) => f.startsWith("xbrief/"))).toBe(false);
  });
});
