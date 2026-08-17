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
