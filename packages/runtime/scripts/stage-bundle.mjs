#!/usr/bin/env node
/**
 * Stage a self-contained @deftai/directive-runtime pack directory (AC13.4).
 *
 * Vendors private workspace packages (core / content / types) under
 * node_modules/@deftai/ and rewrites production dependencies to public npm
 * packages only. Pack with: npm pack --pack-destination <dir> from the stage.
 *
 * Usage: node packages/runtime/scripts/stage-bundle.mjs [outDir]
 * Default outDir: packages/runtime/.pack-stage
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimePkg = join(here, "..");
const repoRoot = join(runtimePkg, "..", "..");
const outArg = process.argv[2];
const outDir = outArg
  ? outArg.startsWith("/")
    ? outArg
    : join(process.cwd(), outArg)
  : join(runtimePkg, ".pack-stage");

const PRIVATE = [
  { name: "directive-types", src: join(repoRoot, "packages", "types"), copy: copyTypes },
  { name: "directive-core", src: join(repoRoot, "packages", "core"), copy: copyCore },
  { name: "directive-content", src: join(repoRoot, "packages", "content"), copy: copyContent },
];

function fail(msg) {
  process.stderr.write(`stage-bundle: ${msg}\n`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function copyTypes(src, dest) {
  mkdirSync(dest, { recursive: true });
  const pkg = readJson(join(src, "package.json"));
  delete pkg.private;
  delete pkg.scripts;
  writeJson(join(dest, "package.json"), pkg);
  cpSync(join(src, "dist"), join(dest, "dist"), { recursive: true });
  if (existsSync(join(src, "schemas"))) {
    cpSync(join(src, "schemas"), join(dest, "schemas"), { recursive: true });
  }
}

function copyCore(src, dest) {
  mkdirSync(dest, { recursive: true });
  const pkg = readJson(join(src, "package.json"));
  delete pkg.private;
  delete pkg.scripts;
  delete pkg.devDependencies;
  // Private workspace deps are siblings under the staged node_modules/@deftai.
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies || {}).filter(([k]) => !k.startsWith("@deftai/")),
  );
  writeJson(join(dest, "package.json"), pkg);
  if (!existsSync(join(src, "dist"))) fail("packages/core/dist missing — run pnpm -w run build");
  cpSync(join(src, "dist"), join(dest, "dist"), { recursive: true });
}

function cleanContentPackage(contentPkg) {
  const keep = new Set(["package.json", "stage-pack.mjs"]);
  for (const name of readdirSync(contentPkg)) {
    if (keep.has(name)) continue;
    rmSync(join(contentPkg, name), { recursive: true, force: true });
  }
}

function copyContent(src, dest) {
  const stageScript = join(src, "stage-pack.mjs");
  if (!existsSync(stageScript)) fail("packages/content/stage-pack.mjs missing");
  const staged = spawnSync(process.execPath, [stageScript], {
    cwd: src,
    stdio: "inherit",
  });
  if (staged.status !== 0) fail("content stage-pack failed");
  try {
    mkdirSync(dest, { recursive: true });
    const pkg = readJson(join(src, "package.json"));
    delete pkg.private;
    delete pkg.scripts;
    writeJson(join(dest, "package.json"), pkg);
    for (const name of readdirSync(src)) {
      if (name === "package.json" || name === "stage-pack.mjs" || name === "node_modules") continue;
      cpSync(join(src, name), join(dest, name), { recursive: true });
    }
  } finally {
    cleanContentPackage(src);
  }
}

function publicDepsFromCore() {
  const core = readJson(join(repoRoot, "packages", "core", "package.json"));
  const out = {};
  for (const [k, v] of Object.entries(core.dependencies || {})) {
    if (!k.startsWith("@deftai/")) out[k] = v;
  }
  return out;
}

function main() {
  if (!existsSync(join(runtimePkg, "dist", "bin.js"))) {
    fail("packages/runtime/dist/bin.js missing — run pnpm -w run build");
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  cpSync(join(runtimePkg, "dist"), join(outDir, "dist"), { recursive: true });
  mkdirSync(join(outDir, "scripts"), { recursive: true });
  for (const name of readdirSync(join(runtimePkg, "scripts"))) {
    if (name === "stage-bundle.mjs") continue;
    cpSync(join(runtimePkg, "scripts", name), join(outDir, "scripts", name), {
      recursive: true,
    });
  }

  const nm = join(outDir, "node_modules", "@deftai");
  mkdirSync(nm, { recursive: true });
  for (const entry of PRIVATE) {
    entry.copy(entry.src, join(nm, entry.name));
  }

  const runtime = readJson(join(runtimePkg, "package.json"));
  delete runtime.private;
  const version = runtime.version || "0.0.0";
  // Public third-party deps stay fetchable; private @deftai/* are also listed so
  // npm pack honors bundledDependencies (requires both fields).
  const deps = publicDepsFromCore();
  const bundled = PRIVATE.map((p) => `@deftai/${p.name}`);
  for (const name of bundled) deps[name] = version;
  runtime.dependencies = deps;
  runtime.bundledDependencies = bundled;
  if (runtime.publishConfig?.provenance) {
    delete runtime.publishConfig.provenance;
  }
  writeJson(join(outDir, "package.json"), runtime);

  process.stdout.write(`${outDir}\n`);
}

main();
