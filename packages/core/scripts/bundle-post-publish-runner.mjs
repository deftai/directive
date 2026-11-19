#!/usr/bin/env node
/**
 * Bundle the post-publish two-pass runner into one self-contained file (#5603).
 *
 * The npm-publish `post-publish` job must not check out source or run `pnpm install`
 * (CodeQL cache-poisoning), so it runs only what `prepare` uploads. Shipping
 * packages/core/dist alone failed: its imports need `@deftai/directive-types` and other
 * workspace / npm packages that are not on disk there. One esbuild bundle carries them all.
 *
 * Usage (after `pnpm -w run build`):
 *   node packages/core/scripts/bundle-post-publish-runner.mjs [--out <file>]
 * Default output: <os tmpdir>/deft-post-publish-runner/npm-ops.mjs (outside the
 * repo, so it can never end up in a packed runtime). Prints the output path.
 */
import * as esbuild from "esbuild";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const entry = join(pkgRoot, "dist", "release-e2e", "npm-ops.js");

function parseOut(argv) {
  const at = argv.indexOf("--out");
  if (at === -1) return join(tmpdir(), "deft-post-publish-runner", "npm-ops.mjs");
  const value = argv[at + 1];
  if (!value) throw new Error("--out needs a file path");
  return resolve(value);
}

async function main() {
  if (!existsSync(entry)) {
    throw new Error(`${entry} not found; run \`pnpm -w run build\` first`);
  }
  const outfile = parseOut(process.argv.slice(2));
  await esbuild.build({
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    entryPoints: [entry],
    outfile,
    // CommonJS dependencies bundled into ESM still call require() for Node builtins.
    banner: {
      js: 'import { createRequire as __deftCreateRequire } from "node:module"; const require = __deftCreateRequire(import.meta.url);',
    },
  });
  process.stdout.write(`${outfile}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
