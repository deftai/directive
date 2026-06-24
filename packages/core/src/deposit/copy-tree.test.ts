import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("copies nested directories and preserves the executable bit", async () => {
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

  it("rejects a non-directory source", async () => {
    const workspace = freshRoot("copy-tree-file-");
    const file = join(workspace, "not-a-dir");
    writeFileSync(file, "x", "utf-8");

    await expect(copyTree(file, join(workspace, "dst"))).rejects.toThrow(/not a directory/);
  });
});
