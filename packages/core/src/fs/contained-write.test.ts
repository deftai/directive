/**
 * Unit tests for containedWrite (#2951 Phase 1).
 * Escape + symlink-outside-root must fail closed; happy paths write under root.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
  resolveContainedTarget,
} from "./contained-write.js";

// Symlinks require elevated privileges on Windows (SeCreateSymbolicLink); skip there.
const itSymlink = it.skipIf(process.platform === "win32");

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("resolveContainedTarget (#2951)", () => {
  it("resolves a relative target under root", () => {
    const root = freshDir("cw-rel-");
    const abs = resolveContainedTarget(root, "a/b.txt");
    expect(abs).toBe(join(root, "a", "b.txt"));
  });

  it("accepts an absolute target nested under root", () => {
    const root = freshDir("cw-abs-ok-");
    const target = join(root, "nested", "f.txt");
    expect(resolveContainedTarget(root, target)).toBe(target);
  });

  it("refuses .. escape with CONTAINED_WRITE_ESCAPE", () => {
    const root = freshDir("cw-escape-");
    try {
      resolveContainedTarget(root, join("..", "outside.txt"));
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.ESCAPE);
    }
  });

  it("refuses absolute path outside root", () => {
    const root = freshDir("cw-abs-out-");
    const outside = freshDir("cw-abs-out-side-");
    try {
      resolveContainedTarget(root, join(outside, "evil.txt"));
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.ESCAPE);
    }
  });

  it("refuses empty target", () => {
    const root = freshDir("cw-empty-");
    expect(() => resolveContainedTarget(root, "")).toThrow(ContainedWriteError);
  });
});

describe("containedWrite modes (#2951)", () => {
  it("create writes a new file under root", () => {
    const root = freshDir("cw-create-");
    const result = containedWrite({
      root,
      target: "out/hello.txt",
      data: "hello\n",
      mode: "create",
    });
    expect(result.mode).toBe("create");
    expect(result.path).toBe(join(root, "out", "hello.txt"));
    expect(readFileSync(result.path, "utf8")).toBe("hello\n");
    expect(result.bytesWritten).toBe(Buffer.byteLength("hello\n", "utf8"));
  });

  it("create refuses when the file already exists", () => {
    const root = freshDir("cw-create-exists-");
    writeFileSync(join(root, "x.txt"), "old\n", "utf8");
    try {
      containedWrite({ root, target: "x.txt", data: "new\n", mode: "create" });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.EXISTS);
    }
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("old\n");
  });

  it("replace overwrites existing content", () => {
    const root = freshDir("cw-replace-");
    writeFileSync(join(root, "x.txt"), "old\n", "utf8");
    const result = containedWrite({
      root,
      target: "x.txt",
      data: "new\n",
      mode: "replace",
    });
    expect(result.mode).toBe("replace");
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("new\n");
  });

  it("append concatenates", () => {
    const root = freshDir("cw-append-");
    writeFileSync(join(root, "log.txt"), "a\n", "utf8");
    containedWrite({ root, target: "log.txt", data: "b\n", mode: "append" });
    expect(readFileSync(join(root, "log.txt"), "utf8")).toBe("a\nb\n");
  });

  it("accepts Buffer data", () => {
    const root = freshDir("cw-buf-");
    const result = containedWrite({
      root,
      target: "bin.dat",
      data: Buffer.from([0x00, 0xff]),
      mode: "create",
    });
    expect(result.bytesWritten).toBe(2);
    expect(readFileSync(result.path)).toEqual(Buffer.from([0x00, 0xff]));
  });

  it("refuses missing root with ROOT_MISSING", () => {
    const missing = join(tmpdir(), `cw-missing-root-${Date.now()}-nope`);
    try {
      containedWrite({
        root: missing,
        target: "f.txt",
        data: "x",
        mode: "create",
      });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.ROOT_MISSING);
    }
  });
});

describe("containedWrite path escape (#2951)", () => {
  it("refuses .. traversal and does not create outside files", () => {
    const root = freshDir("cw-dotdot-root-");
    const outsideDir = freshDir("cw-dotdot-out-");
    const victim = join(outsideDir, "keep.txt");
    writeFileSync(victim, "KEEP\n", "utf8");

    try {
      containedWrite({
        root,
        target: join("..", `${outsideDir.split(/[/\\]/).pop()}`, "evil.txt"),
        data: "PWN\n",
        mode: "create",
      });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.ESCAPE);
    }
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
    expect(existsSync(join(outsideDir, "evil.txt"))).toBe(false);
  });

  it("refuses absolute target outside root", () => {
    const root = freshDir("cw-abs-esc-root-");
    const outside = freshDir("cw-abs-esc-out-");
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "KEEP\n", "utf8");

    try {
      containedWrite({
        root,
        target: victim,
        data: "PWN\n",
        mode: "replace",
      });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.ESCAPE);
    }
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });
});

describe("containedWrite symlink-outside-root (#2951)", () => {
  itSymlink("refuses leaf symlink that escapes the root", () => {
    const root = freshDir("cw-sym-leaf-root-");
    const outside = freshDir("cw-sym-leaf-out-");
    const victim = join(outside, "outside.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    symlinkSync(victim, join(root, "link.txt"));

    try {
      containedWrite({
        root,
        target: "link.txt",
        data: "PWN\n",
        mode: "replace",
      });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.SYMLINK);
    }
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });

  itSymlink("refuses parent-directory symlink that escapes the root", () => {
    const root = freshDir("cw-sym-parent-root-");
    const outside = freshDir("cw-sym-parent-out-");
    writeFileSync(join(outside, "poisoned.txt"), "KEEP\n", "utf8");
    symlinkSync(outside, join(root, "out"), "dir");

    try {
      containedWrite({
        root,
        target: join("out", "new.txt"),
        data: "PWN\n",
        mode: "create",
      });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      // Parent escape may surface as SYMLINK or ESCAPE depending on walk stage.
      expect([ContainedWriteErrorCode.SYMLINK, ContainedWriteErrorCode.ESCAPE]).toContain(
        (err as ContainedWriteError).code,
      );
    }
    expect(readFileSync(join(outside, "poisoned.txt"), "utf8")).toBe("KEEP\n");
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });

  itSymlink("refuses in-tree leaf symlink (assertWriteTargetSafe parity)", () => {
    const root = freshDir("cw-sym-intree-");
    const victim = join(root, "real.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    symlinkSync(victim, join(root, "alias.txt"));

    try {
      containedWrite({
        root,
        target: "alias.txt",
        data: "PWN\n",
        mode: "replace",
      });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.SYMLINK);
    }
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });
});

describe("containedWrite nested create under root (#2951)", () => {
  it("creates intermediate directories under root", () => {
    const root = freshDir("cw-mkdir-");
    const result = containedWrite({
      root,
      target: join("deep", "nested", "file.txt"),
      data: "ok\n",
      mode: "create",
    });
    expect(existsSync(join(root, "deep", "nested"))).toBe(true);
    expect(readFileSync(result.path, "utf8")).toBe("ok\n");
  });

  it("works when parent already exists", () => {
    const root = freshDir("cw-parent-exists-");
    mkdirSync(join(root, "sub"), { recursive: true });
    containedWrite({
      root,
      target: join("sub", "f.txt"),
      data: "x\n",
      mode: "create",
    });
    expect(readFileSync(join(root, "sub", "f.txt"), "utf8")).toBe("x\n");
  });
});
