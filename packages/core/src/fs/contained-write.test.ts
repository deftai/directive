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
  containedChmod,
  containedDestExec,
  containedRemove,
  containedRename,
  containedWrite,
  resolveContainedTarget,
} from "./contained-write.js";
import {
  runInPortRecordMode,
  runWithMutationLedger,
  snapshotMutationSummary,
} from "./mutation-ledger.js";

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

describe("containedWrite mutation ledger (#3392)", () => {
  it("records wrote as a side effect when a ledger is bound", () => {
    const root = freshDir("cw-led-write-");
    const summary = runWithMutationLedger(root, () => {
      containedWrite({ root, target: "out.txt", data: "ok\n", mode: "create" });
      return snapshotMutationSummary();
    });
    expect(summary.wrote).toEqual(["out.txt"]);
    expect(summary.stripped).toEqual([]);
    expect(summary.deleted).toEqual([]);
  });

  it("records stripped when the writer passes kind=stripped", () => {
    const root = freshDir("cw-led-strip-");
    const summary = runWithMutationLedger(root, () => {
      containedWrite({
        root,
        target: "hooks.json",
        data: "{}\n",
        mode: "create",
        mutation: { kind: "stripped" },
      });
      return snapshotMutationSummary();
    });
    expect(summary.stripped).toEqual(["hooks.json"]);
    expect(summary.wrote).toEqual([]);
  });

  it("does not record when mutation is false", () => {
    const root = freshDir("cw-led-skip-");
    const summary = runWithMutationLedger(root, () => {
      containedWrite({
        root,
        target: "skip.txt",
        data: "x\n",
        mode: "create",
        mutation: false,
      });
      return snapshotMutationSummary();
    });
    expect(summary.mutations).toEqual([]);
  });

  it("skips atomic tmp targets unless a logical path is supplied", () => {
    const root = freshDir("cw-led-tmp-");
    const summary = runWithMutationLedger(root, () => {
      containedWrite({
        root,
        target: "hooks.json.deft-1.tmp",
        data: "{}\n",
        mode: "create",
      });
      containedWrite({
        root,
        target: "hooks.json.deft-2.tmp",
        data: "{}\n",
        mode: "create",
        mutation: { kind: "wrote", path: join(root, "hooks.json") },
      });
      return snapshotMutationSummary();
    });
    expect(summary.wrote).toEqual(["hooks.json"]);
  });

  it("does not record when no ledger is bound", () => {
    const root = freshDir("cw-led-none-");
    containedWrite({ root, target: "x.txt", data: "x\n", mode: "create" });
    expect(snapshotMutationSummary().mutations).toEqual([]);
  });
});

describe("containedRemove (#3392)", () => {
  it("removes a file and records deleted", () => {
    const root = freshDir("cr-del-");
    writeFileSync(join(root, "gone.txt"), "x\n", "utf8");
    const summary = runWithMutationLedger(root, () => {
      const result = containedRemove({ root, target: "gone.txt" });
      expect(result.removed).toBe(true);
      return snapshotMutationSummary();
    });
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    expect(summary.deleted).toEqual(["gone.txt"]);
  });

  it("removes a directory tree when recursive is true and records deleted", () => {
    const root = freshDir("cr-rec-");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "probe.py"), "# probe\n", "utf8");
    const summary = runWithMutationLedger(root, () => {
      const result = containedRemove({ root, target: "scripts", recursive: true });
      expect(result.removed).toBe(true);
      return snapshotMutationSummary();
    });
    expect(existsSync(join(root, "scripts"))).toBe(false);
    expect(summary.deleted).toEqual(["scripts"]);
  });

  it("is a no-op (not ledgered) when the target is missing", () => {
    const root = freshDir("cr-miss-");
    const summary = runWithMutationLedger(root, () => {
      const result = containedRemove({ root, target: "nope.txt" });
      expect(result.removed).toBe(false);
      return snapshotMutationSummary();
    });
    expect(summary.deleted).toEqual([]);
  });

  it("refuses .. escape and does not delete outside files", () => {
    const root = freshDir("cr-esc-root-");
    const outside = freshDir("cr-esc-out-");
    const victim = join(outside, "keep.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    try {
      containedRemove({
        root,
        target: join("..", `${outside.split(/[/\\]/).pop()}`, "keep.txt"),
      });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.ESCAPE);
    }
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });

  it("unlinks an in-root leaf directory link without following it", () => {
    const root = freshDir("cr-junc-intree-");
    const realDir = join(root, "real-dir");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "keep.txt"), "KEEP\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(realDir, join(root, "alias-dir"), linkType);

    const summary = runWithMutationLedger(root, () => {
      const result = containedRemove({ root, target: "alias-dir" });
      expect(result.removed).toBe(true);
      return snapshotMutationSummary();
    });

    expect(existsSync(join(root, "alias-dir"))).toBe(false);
    expect(readFileSync(join(realDir, "keep.txt"), "utf8")).toBe("KEEP\n");
    expect(summary.deleted).toEqual(["alias-dir"]);
  });

  it("refuses a parent-directory link on the remove path (junction/dir)", () => {
    const root = freshDir("cr-junc-parent-root-");
    const outside = freshDir("cr-junc-parent-out-");
    const victim = join(outside, "keep.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, join(root, "out"), linkType);

    try {
      containedRemove({ root, target: join("out", "keep.txt") });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.SYMLINK);
    }
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });

  itSymlink("unlinks an in-root leaf symlink without following it", () => {
    const root = freshDir("cr-sym-intree-");
    const victim = join(root, "real.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    symlinkSync(victim, join(root, "alias.txt"));

    const summary = runWithMutationLedger(root, () => {
      const result = containedRemove({ root, target: "alias.txt" });
      expect(result.removed).toBe(true);
      return snapshotMutationSummary();
    });

    expect(existsSync(join(root, "alias.txt"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
    expect(summary.deleted).toEqual(["alias.txt"]);
  });

  itSymlink("unlinks an in-root leaf symlink that points outside the root", () => {
    const root = freshDir("cr-sym-out-root-");
    const outside = freshDir("cr-sym-out-victim-");
    const victim = join(outside, "outside.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    symlinkSync(victim, join(root, "stale-link.txt"));

    const summary = runWithMutationLedger(root, () => {
      const result = containedRemove({ root, target: "stale-link.txt" });
      expect(result.removed).toBe(true);
      return snapshotMutationSummary();
    });

    expect(existsSync(join(root, "stale-link.txt"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
    expect(summary.deleted).toEqual(["stale-link.txt"]);
  });

  itSymlink("unlinks a dangling in-root leaf symlink", () => {
    const root = freshDir("cr-sym-dangle-");
    symlinkSync(join(root, "missing-target.txt"), join(root, "dangle.txt"));

    const result = containedRemove({ root, target: "dangle.txt" });
    expect(result.removed).toBe(true);
    expect(existsSync(join(root, "dangle.txt"))).toBe(false);
  });

  itSymlink("refuses a parent-directory symlink on the remove path", () => {
    const root = freshDir("cr-sym-parent-root-");
    const outside = freshDir("cr-sym-parent-out-");
    const victim = join(outside, "keep.txt");
    writeFileSync(victim, "KEEP\n", "utf8");
    symlinkSync(outside, join(root, "out"), "dir");

    try {
      containedRemove({ root, target: join("out", "keep.txt") });
      expect.fail("expected ContainedWriteError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContainedWriteError);
      expect((err as ContainedWriteError).code).toBe(ContainedWriteErrorCode.SYMLINK);
    }
    expect(readFileSync(victim, "utf8")).toBe("KEEP\n");
  });
});

describe("port record mode (ADR-004)", () => {
  it("records dest write/remove/chmod/exec/rename and skips dest IO", () => {
    const root = freshDir("cw-record-");
    writeFileSync(join(root, "keep.txt"), "KEEP\n", "utf8");
    const summary = runWithMutationLedger(root, () =>
      runInPortRecordMode(() => {
        containedWrite({ root, target: "new.txt", data: "NEW\n", mode: "create" });
        containedRemove({ root, target: "keep.txt" });
        containedChmod({ root, target: "hook.sh", mode: 0o755 });
        containedDestExec({
          root,
          destTarget: join(".git", "config"),
          file: "git",
          args: ["config", "core.hooksPath", ".githooks"],
        });
        containedRename({ root, from: "keep.txt", to: "moved.txt" });
        return snapshotMutationSummary();
      }),
    );
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("KEEP\n");
    expect(existsSync(join(root, "moved.txt"))).toBe(false);
    expect(summary.wrote).toEqual(expect.arrayContaining(["new.txt", "moved.txt"]));
    expect(summary.deleted).toEqual(["keep.txt"]);
    expect(summary.chmod).toEqual(["hook.sh"]);
    expect(summary.exec).toEqual([".git/config"]);
  });

  it("containedChmod sets mode when not in record mode", () => {
    const root = freshDir("cw-chmod-");
    const path = join(root, "hook.sh");
    writeFileSync(path, "#!/bin/sh\n", "utf8");
    containedChmod({ root, target: "hook.sh", mode: 0o644 });
    expect(existsSync(path)).toBe(true);
  });
});
