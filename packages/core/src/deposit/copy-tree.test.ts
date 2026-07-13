import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Symlinks require elevated privileges on Windows by default; skip symlink tests there.
const itSymlink = it.skipIf(process.platform === "win32");
// chmod mode bits are not reliably preserved by Node on Windows.
const itChmod = it.skipIf(process.platform === "win32");

import { copyTree } from "./copy-tree.js";

describe("copyTree (#1477 mode-preserving recursive copy)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  itChmod("copies nested directories and preserves the executable bit", async () => {
    const workspace = freshRoot("copy-tree-");
    const src = join(workspace, "src");
    const dst = join(workspace, "dst");

    mkdirSync(join(src, "nested", "bin"), { recursive: true });
    writeFileSync(join(src, "nested", "readme.txt"), "hello", "utf-8");
    chmodSync(join(src, "nested", "readme.txt"), 0o644);

    const hook = join(src, "nested", "bin", "hook");
    writeFileSync(hook, "#!/bin/sh\necho hook\n", "utf-8");
    chmodSync(hook, 0o755);

    await copyTree(src, dst);

    expect(readFileSync(join(dst, "nested", "readme.txt"), "utf-8")).toBe("hello");
    expect(statSync(join(dst, "nested", "readme.txt")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(dst, "nested", "bin", "hook"), "utf-8")).toBe(
      "#!/bin/sh\necho hook\n",
    );
    expect(statSync(join(dst, "nested", "bin", "hook")).mode & 0o777).toBe(0o755);
  });

  itSymlink("#2305: skips symlinked entries instead of following them", async () => {
    const workspace = freshRoot("copy-tree-symlink-");
    const src = join(workspace, "src");
    const outside = join(workspace, "outside");
    mkdirSync(src, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(src, "real.txt"), "real", "utf-8");
    writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
    symlinkSync(outside, join(src, "escape"), "dir");

    const dst = join(workspace, "dst");
    await copyTree(src, dst);

    expect(readFileSync(join(dst, "real.txt"), "utf-8")).toBe("real");
    // The symlinked entry is not dereferenced/copied.
    expect(existsSync(join(dst, "escape"))).toBe(false);
  });

  itSymlink("refuses to overwrite a destination file symlink", async () => {
    const workspace = freshRoot("copy-tree-dst-file-symlink-");
    const src = join(workspace, "src");
    const dst = join(workspace, "dst");
    const outside = join(workspace, "outside.txt");
    mkdirSync(join(src, "templates"), { recursive: true });
    mkdirSync(join(dst, "templates"), { recursive: true });
    writeFileSync(join(src, "templates", "agents-entry.md"), "managed", "utf-8");
    writeFileSync(outside, "do not overwrite", "utf-8");
    symlinkSync(outside, join(dst, "templates", "agents-entry.md"));

    await expect(copyTree(src, dst)).rejects.toThrow(/destination symlink/);
    expect(readFileSync(outside, "utf-8")).toBe("do not overwrite");
  });

  itSymlink("refuses to recurse into a destination directory symlink", async () => {
    const workspace = freshRoot("copy-tree-dst-dir-symlink-");
    const src = join(workspace, "src");
    const dst = join(workspace, "dst");
    const outside = join(workspace, "outside");
    mkdirSync(join(src, "templates"), { recursive: true });
    mkdirSync(dst, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(src, "templates", "agents-entry.md"), "managed", "utf-8");
    symlinkSync(outside, join(dst, "templates"), "dir");

    await expect(copyTree(src, dst)).rejects.toThrow(/destination symlink/);
    expect(existsSync(join(outside, "agents-entry.md"))).toBe(false);
  });

  it("rejects a non-directory source", async () => {
    const workspace = freshRoot("copy-tree-file-");
    const file = join(workspace, "not-a-dir");
    writeFileSync(file, "x", "utf-8");

    await expect(copyTree(file, join(workspace, "dst"))).rejects.toThrow(/not a directory/);
  });
});
