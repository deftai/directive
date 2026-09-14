import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractMarkupFacts, SCRIPT_SENTINEL } from "./extract.js";

const corePkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const repoPkgPath = fileURLToPath(new URL("../../../../package.json", import.meta.url));

describe("packed/installed oracle smoke (#4495)", () => {
  it("publishes parse5 (and not jsdom or typescript) as runtime deps of the owning package", () => {
    const pkg = JSON.parse(readFileSync(corePkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.parse5).toMatch(/\^7\.3/);
    expect(pkg.dependencies?.jsdom).toBeUndefined();
    expect(pkg.dependencies?.typescript).toBeUndefined();
    const req = createRequire(corePkgPath);
    const parse5Entry = req.resolve("parse5");
    expect(parse5Entry).toMatch(/parse5/);
    let dir = dirname(parse5Entry);
    let parse5PkgPath = "";
    for (let i = 0; i < 6; i += 1) {
      const cand = join(dir, "package.json");
      if (existsSync(cand)) {
        const parsed = JSON.parse(readFileSync(cand, "utf8")) as { name?: string };
        if (parsed.name === "parse5") {
          parse5PkgPath = cand;
          break;
        }
      }
      dir = dirname(dir);
    }
    expect(parse5PkgPath.length).toBeGreaterThan(0);
    const parse5Pkg = JSON.parse(readFileSync(parse5PkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(parse5Pkg.dependencies ?? {})).toEqual(["entities"]);
    expect(pkg.devDependencies?.jsdom).toBeUndefined();
    const lock = readFileSync(
      fileURLToPath(new URL("../../../../pnpm-lock.yaml", import.meta.url)),
      "utf8",
    );
    expect(lock).not.toMatch(/jsdom@26/);
    expect(lock).not.toMatch(/^ {2}jsdom@/m);
  });

  it("html extraction needs no TypeScript", () => {
    const html = `<h1>Ok</h1>`;
    expect(extractMarkupFacts(html, "packed.html").map((f) => f.id)).toContain("heading:1:Ok");
  });

  it("never executes a script-tag sentinel during html extract", () => {
    const html = `<script>globalThis.${SCRIPT_SENTINEL}="executed";throw new Error("ran")</script><h1>Ok</h1>`;
    expect((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL]).toBeUndefined();
    const facts = extractMarkupFacts(html, "packed.html");
    expect((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL]).toBeUndefined();
    expect(facts.map((f) => f.id)).toContain("heading:1:Ok");
  });

  let dtsDir: string | undefined;
  afterEach(() => {
    if (dtsDir !== undefined) {
      rmSync(dtsDir, { recursive: true, force: true });
      dtsDir = undefined;
    }
  });

  it("emitted observable-scope declarations reference no typescript, parse5, or entities module", () => {
    dtsDir = mkdtempSync(join(tmpdir(), "obs-dts-"));
    const tsc = createRequire(repoPkgPath).resolve("typescript/bin/tsc");
    execFileSync(
      process.execPath,
      [
        tsc,
        "--declaration",
        "--emitDeclarationOnly",
        "--strict",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--esModuleInterop",
        "--skipLibCheck",
        "--types",
        "node",
        "--outDir",
        dtsDir,
        "html-spec.ts",
        "extract.ts",
        "types.ts",
      ],
      { cwd: fileURLToPath(new URL("./", import.meta.url)), stdio: "pipe" },
    );
    const hits: string[] = [];
    for (const name of ["html-spec.d.ts", "extract.d.ts", "types.d.ts"]) {
      const text = readFileSync(join(dtsDir, name), "utf8");
      if (/from "(typescript|parse5|entities)"/.test(text)) hits.push(name);
    }
    expect(hits).toEqual([]);
  });
});
