#!/usr/bin/env node
/**
 * Stage a self-contained @deftai/directive-runtime pack directory (AC1.3 / PKG-AC13-NEST).
 *
 * Private workspace packages are copied under vendor/directive-{core,content,types}
 * WITHOUT package.json (so consumer find under @deftai sees only the runtime).
 * Staged JS import/resolve strings are rewritten to relative paths into vendor/
 * using each package's exports map. Content surfaces are also hoisted to the
 * runtime root for AC9.6 pointers. Published dependencies contain zero @deftai
 * package keys.
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimePkg = join(here, "..");
const repoRoot = join(runtimePkg, "..", "..");
const outArg = process.argv[2];
const outDir = outArg
  ? isAbsolute(outArg)
    ? outArg
    : resolve(process.cwd(), outArg)
  : join(runtimePkg, ".pack-stage");

const PRIVATE = [
  {
    id: "types",
    scoped: "@deftai/directive-types",
    folder: "directive-types",
    src: join(repoRoot, "packages", "types"),
    copy: copyTypes,
  },
  {
    id: "core",
    scoped: "@deftai/directive-core",
    folder: "directive-core",
    src: join(repoRoot, "packages", "core"),
    copy: copyCore,
  },
  {
    id: "content",
    scoped: "@deftai/directive-content",
    folder: "directive-content",
    src: join(repoRoot, "packages", "content"),
    copy: copyContent,
  },
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

function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  return entry.default || entry.import || entry.require || null;
}

/** Map subpath ("" | "policy" | "dist/foo.js") → package-relative file (./dist/...). */
function buildExportResolver(pkgJson) {
  const exportsMap = pkgJson.exports || {};
  const exact = new Map();
  for (const [key, val] of Object.entries(exportsMap)) {
    const target = exportTarget(val);
    if (!target) continue;
    if (key === ".") exact.set("", target.replace(/^\.\//, ""));
    else if (key.startsWith("./")) exact.set(key.slice(2), target.replace(/^\.\//, ""));
  }
  if (!exact.has("")) {
    const main = pkgJson.module || pkgJson.main || "dist/index.js";
    exact.set("", String(main).replace(/^\.\//, ""));
  }
  return (subpath) => {
    if (exact.has(subpath)) return exact.get(subpath);
    if (subpath.startsWith("dist/")) return subpath;
    if (subpath.endsWith(".js") || subpath.endsWith(".json")) return subpath.startsWith("dist/") ? subpath : `dist/${subpath}`;
    // Try index under dist/<subpath>/
    return `dist/${subpath}/index.js`;
  };
}

function toPosixRelative(fromFile, toFile) {
  let rel = relative(dirname(fromFile), toFile);
  if (sep !== "/") rel = rel.split(sep).join("/");
  if (!rel.startsWith(".") ) rel = `./${rel}`;
  return rel;
}

function copyTypes(src, dest) {
  mkdirSync(dest, { recursive: true });
  if (!existsSync(join(src, "dist"))) fail("packages/types/dist missing — run pnpm -w run build");
  cpSync(join(src, "dist"), join(dest, "dist"), { recursive: true });
  if (existsSync(join(src, "schemas"))) {
    cpSync(join(src, "schemas"), join(dest, "schemas"), { recursive: true });
  }
}

function copyCore(src, dest) {
  mkdirSync(dest, { recursive: true });
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

function listJsFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "node_modules") continue;
        stack.push(full);
      } else if (st.isFile() && /\.(js|mjs|cjs)$/.test(name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function rewriteFile(file, resolvers, vendorRoots) {
  let text = readFileSync(file, "utf8");
  const original = text;

  // Prefer longest scoped names first (already ordered types/content/core uniquely).
  for (const entry of PRIVATE) {
    const resolveSub = resolvers.get(entry.folder);
    const vendorRoot = vendorRoots.get(entry.folder);
    const scoped = entry.scoped;
    // Specifiers: "@deftai/directive-core", ".../sub", with ' or "
    const re = new RegExp(
      `(["'])${scoped.replace(/\//g, "\\/")}(\\/[^"'\\s]*)?\\1`,
      "g",
    );
    text = text.replace(re, (match, quote, sub) => {
      const subpath = sub ? sub.slice(1) : "";
      let targetRel;
      try {
        targetRel = resolveSub(subpath);
      } catch {
        return match;
      }
      if (!targetRel) return match;
      const absTarget = join(vendorRoot, targetRel);
      const rel = toPosixRelative(file, absTarget);
      return `${quote}${rel}${quote}`;
    });

    // require.resolve / bare string forms without forcing quote reuse already handled.
  }

  // Path-join segments for private packages → runtime (content hoisted) or vendor.
  // join(..., "node_modules", "@deftai", "directive-content", ...) → directive-runtime
  text = text.split(`"@deftai", "directive-content"`).join(`"@deftai", "directive-runtime"`);
  text = text.split(`'@deftai', 'directive-content'`).join(`'@deftai', 'directive-runtime'`);
  // directive-core path probes → vendor path under the runtime package (no @deftai scope)
  // join(dir, "node_modules", "@deftai", "directive-core", ...) cannot point at vendor
  // easily; strip to a non-@deftai probe that won't create false package identities.
  text = text.split(`"@deftai", "directive-core"`).join(`"directive-core-absent"`);
  text = text.split(`'@deftai', 'directive-core'`).join(`'directive-core-absent'`);
  text = text.split(`"@deftai", "directive-types"`).join(`"directive-types-absent"`);
  text = text.split(`'@deftai', 'directive-types'`).join(`'directive-types-absent'`);

  // CONTENT_PACKAGE_NAME / similar string constants for content → runtime (hoisted).
  text = text.split('"@deftai/directive-content"').join('"@deftai/directive-runtime"');
  text = text.split("'@deftai/directive-content'").join("'@deftai/directive-runtime'");

  if (text !== original) writeFileSync(file, text);
}

function assertNoNestedDeftaiPackageJson(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (name === "package.json") {
        const posixPath = full.split(sep).join("/");
        if (posixPath.includes("/node_modules/@deftai/") || /\/vendor\/directive-[^/]+\/package\.json$/.test(posixPath)) {
          // Allow only the staged root package.json (handled separately).
          if (full !== join(outDir, "package.json")) {
            fail(`unexpected package.json under stage tree: ${full}`);
          }
        }
      }
    }
  }
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
    if (name === "stage-bundle.mjs" || name === "pack-staged-runtime.mjs") continue;
    cpSync(join(runtimePkg, "scripts", name), join(outDir, "scripts", name), {
      recursive: true,
    });
  }

  const vendorRoot = join(outDir, "vendor");
  mkdirSync(vendorRoot, { recursive: true });

  const resolvers = new Map();
  const vendorRoots = new Map();
  for (const entry of PRIVATE) {
    const pkgJson = readJson(join(entry.src, "package.json"));
    resolvers.set(entry.folder, buildExportResolver(pkgJson));
    const dest = join(vendorRoot, entry.folder);
    entry.copy(entry.src, dest);
    vendorRoots.set(entry.folder, dest);
    // Critical for AC1.3 find-probe: do not ship vendor package.json.
    const nestedPkg = join(dest, "package.json");
    if (existsSync(nestedPkg)) rmSync(nestedPkg, { force: true });
  }

  // Hoist content surfaces to the runtime package root (AC9.6 / AC13.1).
  const contentRoot = join(vendorRoot, "directive-content");
  const HOIST_SKIP = new Set(["package.json", "stage-pack.mjs", "node_modules"]);
  const hoistedNames = [];
  if (existsSync(contentRoot)) {
    for (const name of readdirSync(contentRoot)) {
      if (HOIST_SKIP.has(name)) continue;
      cpSync(join(contentRoot, name), join(outDir, name), { recursive: true });
      hoistedNames.push(name);
    }
  }

  // Rewrite imports in runtime dist + vendored JS to relative vendor paths.
  for (const file of listJsFiles(join(outDir, "dist"))) {
    rewriteFile(file, resolvers, vendorRoots);
  }
  for (const entry of PRIVATE) {
    for (const file of listJsFiles(join(vendorRoot, entry.folder))) {
      rewriteFile(file, resolvers, vendorRoots);
    }
  }

  const runtime = readJson(join(runtimePkg, "package.json"));
  delete runtime.private;
  runtime.dependencies = publicDepsFromCore();
  delete runtime.bundledDependencies;
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
    "vendor/**",
    "scripts/remove-windows-ps1-shims.mjs",
    ...filesEntries,
  ];
  if (runtime.publishConfig?.provenance) {
    delete runtime.publishConfig.provenance;
  }
  writeJson(join(outDir, "package.json"), runtime);

  // Gates
  for (const entry of PRIVATE) {
    if (existsSync(join(outDir, "node_modules", "@deftai", entry.folder, "package.json"))) {
      fail(`scoped vendor present: ${entry.folder}`);
    }
    if (existsSync(join(vendorRoot, entry.folder, "package.json"))) {
      fail(`vendor package.json must be absent: ${entry.folder}`);
    }
    if (!existsSync(join(vendorRoot, entry.folder))) {
      fail(`vendor folder missing: ${entry.folder}`);
    }
  }
  assertNoNestedDeftaiPackageJson(outDir);

  process.stdout.write(`${outDir}\n`);
}

main();
