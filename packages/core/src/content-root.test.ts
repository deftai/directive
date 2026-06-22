import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_DIRNAME, contentRoot } from "./content-root.js";

describe("contentRoot (#1875 C1 flatten dual-context resolver)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "content-root-"));
    created.push(root);
    return root;
  }

  it("returns the content/ subdir when present (source checkout)", () => {
    const root = freshRoot();
    mkdirSync(join(root, CONTENT_DIRNAME));
    expect(contentRoot(root)).toBe(join(root, CONTENT_DIRNAME));
  });

  it("returns the framework root when content/ is absent (consumer deposit)", () => {
    const root = freshRoot();
    expect(contentRoot(root)).toBe(root);
  });

  it("does not mistake a content file for the content dir", () => {
    const root = freshRoot();
    writeFileSync(join(root, CONTENT_DIRNAME), "not a dir", "utf-8");
    expect(contentRoot(root)).toBe(root);
  });
});
