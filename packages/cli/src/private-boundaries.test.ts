/**
 * AC13.5: private folders keep their boundaries —
 * content/ has no executable product TypeScript; types/ is types + schemas only.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listFiles(dir: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, pred));
    else if (pred(entry)) out.push(full);
  }
  return out;
}

describe("private package boundaries (AC13.5)", () => {
  it("packages/content contains no TypeScript sources", () => {
    const contentRoot = join(PACKAGES, "content");
    const ts = listFiles(contentRoot, (n) => n.endsWith(".ts") || n.endsWith(".tsx"));
    expect(ts, `unexpected TS in content:\n${ts.map((f) => relative(contentRoot, f)).join("\n")}`).toEqual(
      [],
    );
  });

  it("packages/types contains only .ts/.d.ts sources and JSON schemas (no .js product code in src)", () => {
    const typesRoot = join(PACKAGES, "types");
    const jsInSrc = listFiles(join(typesRoot, "src"), (n) => n.endsWith(".js") || n.endsWith(".mjs"));
    expect(jsInSrc).toEqual([]);
    const schemas = listFiles(join(typesRoot, "schemas"), (n) => n.endsWith(".json"));
    expect(schemas.length).toBeGreaterThan(0);
  });
});
