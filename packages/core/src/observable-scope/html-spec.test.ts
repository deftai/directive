import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildArtifact,
  extractMarkupFacts,
  extractSurface,
  ObservableScopeProviderError,
  parsersFor,
} from "./extract.js";
import { parseHtml } from "./html-spec.js";

const ROOT = process.cwd();
const ids = (src: string, path: string, projectRoot?: string) =>
  extractMarkupFacts(src, path, projectRoot === undefined ? {} : { projectRoot }).map((f) => f.id);

describe("parse5 front end (scripting disabled): classes both critics measured", () => {
  it("noscript children, bogus comments, select insertion mode, NBSP tag separator, C1 numeric refs", () => {
    expect(ids("<noscript><h1>Offline</h1></noscript><h1>Live</h1>", "a.html")).toEqual([
      "heading:1:Offline",
      "heading:1:Live",
    ]);
    expect(ids("<!--><h1>After</h1>", "a.html")).toEqual(["heading:1:After"]);
    expect(ids('<select name="s"><h1>Settings</h1><option>A</option></select>', "a.html")).toEqual([
      "control:select:s",
    ]);
    expect(ids('<button\u00a0aria-label="Save">Text</button>', "a.html")).toEqual([]);
    expect(ids("<h1>Price &#x80;</h1>", "a.html")).toEqual(["heading:1:Price \u20ac"]);
    expect(ids("<h1>Sort &darr; &copy 2026</h1>", "a.html")).toEqual([
      "heading:1:Sort \u2193 \u00a9 2026",
    ]);
  });

  it("never interprets script/style contents; template content stays out of the document walk", () => {
    expect(ids('<script>"<h1>no</h1>"</script><style>h2{}</style><h1>Real</h1>', "a.html")).toEqual(
      ["heading:1:Real"],
    );
    const { document } = parseHtml(
      "<template><button>Hidden</button></template><button>Shown</button>",
    );
    expect(document.querySelectorAll("button").map((b) => b.textContent)).toEqual(["Shown"]);
    expect(
      document
        .querySelectorAll("template")[0]
        ?.content?.querySelectorAll("button")
        .map((b) => b.textContent),
    ).toEqual(["Hidden"]);
  });

  it("truncated tab markup fails closed instead of comparing recovered partial facts", () => {
    const truncated = '<h1>Open <button role="tab" aria-selected="tru';
    const parsed = parseHtml(truncated);
    expect(parsed.anomalies.map((a) => a.kind)).toContain("eof-in-tag");
    expect(() => ids(truncated, "a.html")).toThrow(/observable-scope-markup-unresolved/);
    expect(parseHtml("<h1>Open</h1>").anomalies).toEqual([]);
  });
});

describe("fail-closed parser paths", () => {
  it("refuses a .tsx surface with parse diagnostics", () => {
    expect(() => ids('<Tab>T</Tab><div role="tab">X</di', "ui.tsx", ROOT)).toThrow(
      /observable-scope-markup-unresolved/,
    );
  });
  it("parses ordinary TypeScript-5 tsx", () => {
    const src =
      'import React from "react";\nexport function P({ on }: { on: boolean }) {\n  return (<main><h1>Title</h1><Tab selected>B</Tab><Tab selected={on}>C</Tab></main>);\n}\n';
    expect(ids(src, "ui.tsx", ROOT)).toEqual([
      "landmark:main:main",
      "heading:1:Title",
      "tab:B",
      "tab-selected:B",
      "tab:C",
    ]);
  });
  it("refuses when no projectRoot is supplied for a .jsx/.tsx surface (no cwd default)", () => {
    expect(() => ids("<h1>x</h1>", "ui.tsx")).toThrow(/observable-scope-parser-unresolvable/);
  });
  it("refuses when the project has no typescript", () => {
    const bare = mkdtempSync(join(tmpdir(), "no-ts-"));
    writeFileSync(join(bare, "package.json"), "{}");
    expect(() => ids("<h1>x</h1>", "ui.tsx", bare)).toThrow(ObservableScopeProviderError);
    expect(() => ids("<h1>x</h1>", "ui.tsx", bare)).toThrow(/observable-scope-parser-unresolvable/);
  });
  it("refuses a non-parser module named typescript and a typescript below the 5.x floor", () => {
    const bad = mkdtempSync(join(tmpdir(), "bad-ts-"));
    writeFileSync(join(bad, "package.json"), "{}");
    const badMod = join(bad, "node_modules", "typescript");
    mkdirSync(badMod, { recursive: true });
    writeFileSync(
      join(badMod, "package.json"),
      JSON.stringify({ name: "typescript", version: "5.0.0", main: "index.js" }),
    );
    writeFileSync(join(badMod, "index.js"), "module.exports = { version: '5.0.0' };\n");
    expect(() => ids("<h1>x</h1>", "ui.tsx", bad)).toThrow(/observable-scope-parser-invalid/);

    const old = mkdtempSync(join(tmpdir(), "old-ts-"));
    writeFileSync(join(old, "package.json"), "{}");
    const oldMod = join(old, "node_modules", "typescript");
    mkdirSync(oldMod, { recursive: true });
    writeFileSync(
      join(oldMod, "package.json"),
      JSON.stringify({ name: "typescript", version: "4.9.5", main: "index.js" }),
    );
    writeFileSync(
      join(oldMod, "index.js"),
      "module.exports = { version: '4.9.5', createSourceFile() { return {}; } };\n",
    );
    expect(() => ids("<h1>x</h1>", "ui.tsx", old)).toThrow(/observable-scope-parser-invalid/);
  });
  it("html extraction needs no TypeScript at all", () => {
    const bare = mkdtempSync(join(tmpdir(), "no-ts-"));
    writeFileSync(join(bare, "package.json"), "{}");
    expect(ids("<h1>x</h1>", "ui.html", bare)).toEqual(["heading:1:x"]);
  });
});

describe("provider identity is per artifact, not global state", () => {
  it("an html-only artifact records typescript: null even after a tsx surface was parsed elsewhere", () => {
    ids("<Tab selected>B</Tab>", "ui.tsx", ROOT);
    const htmlOnly = [extractSurface("a.html", "<h1>x</h1>")];
    const a = buildArtifact(htmlOnly, parsersFor(htmlOnly, ROOT));
    expect(a.provider).toBe("parse5+typescript");
    expect(a.parsers).toEqual({ html: "parse5@7", typescript: null });
    const mixed = [
      extractSurface("a.html", "<h1>x</h1>"),
      extractSurface("b.tsx", "<h1>y</h1>", { projectRoot: ROOT }),
    ];
    const b = buildArtifact(mixed, parsersFor(mixed, ROOT));
    expect(b.parsers.typescript).toMatch(/^5\.\d+\.\d+/);
  });
});
