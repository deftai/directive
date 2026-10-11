#!/usr/bin/env node
/**
 * Stage a self-contained @deftai/directive-runtime pack directory (AC13.4 / AC1.3).
 *
 * Vendors private workspace packages (core / content / types) under
 * node_modules/@deftai/ and rewrites production dependencies to public npm
 * packages only — published dependencies contain zero @deftai/* keys.
 * Pack via pack-staged-runtime.mjs (npm pack alone drops nested node_modules).
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
  statSync,
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

  // Hoist content surfaces to the runtime package root so AC9.6 pointers
  // (`node_modules/@deftai/directive-runtime/main.md`, `skills/…`) resolve
  // without walking into nested @deftai/directive-content (Wave 2c / AC13.1).
  // Hoist every top-level content entry so main.md relative links (coding/,
  // languages/, tools/, …) resolve in the published runtime (Greptile P1).
  const contentRoot = join(nm, "directive-content");
  const HOIST_SKIP = new Set(["package.json", "stage-pack.mjs", "node_modules"]);
  const hoistedNames = [];
  if (existsSync(contentRoot)) {
    for (const name of readdirSync(contentRoot)) {
      if (HOIST_SKIP.has(name)) continue;
      const from = join(contentRoot, name);
      cpSync(from, join(outDir, name), { recursive: true });
      hoistedNames.push(name);
    }
  }

  const runtime = readJson(join(runtimePkg, "package.json"));
  delete runtime.private;
  // AC1.3: published dependencies must contain zero @deftai/* keys. Private
  // workspace packages are vendored under node_modules/@deftai/ for resolution;
  // pack-staged-runtime.mjs temporarily re-lists them for npm pack then strips
  // them from the tarball package.json (npm only bundles when both fields set).
  const deps = publicDepsFromCore();
  runtime.dependencies = deps;
  delete runtime.bundledDependencies;
  // Include hoisted content + dist in the packed tarball.
  const filesEntries = hoistedNames.map((name) => {
    try {
      return statSync(join(outDir, name)).isDirectory() ? `${name}/**` : name;
    } catch {
      return name;
    }
  });
  runtime.files = [
    "dist/**/*.js",
    "dist/**/*.d.ts",
    "scripts/remove-windows-ps1-shims.mjs",
    ...filesEntries,
  ];
  if (runtime.publishConfig?.provenance) {
    delete runtime.publishConfig.provenance;
  }
  writeJson(join(outDir, "package.json"), runtime);

  process.stdout.write(`${outDir}\n`);
}

main();
