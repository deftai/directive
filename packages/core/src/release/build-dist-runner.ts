/**
 * Subprocess entry for sync callers (release pipeline, task build).
 * Top-level await keeps the process alive until the archive is written.
 * Progress ticks go to stderr so pipeline callers can still capture the
 * archive path on stdout (#2953).
 */
import { buildArchive, emitBuildProgress, selectFormat } from "./build-dist.js";

const version = process.argv[2];
const root = process.argv[3];
if (!version || !root) {
  process.stderr.write("usage: build-dist-runner <version> <root>\n");
  process.exit(2);
}
const fmt = selectFormat(process.env.DEFT_BUILD_FORMAT);
try {
  process.stderr.write(`build-dist-runner: start version=${version} format=${fmt}\n`);
  const out = await buildArchive(root, version, fmt, { onProgress: emitBuildProgress });
  process.stdout.write(`${out}\n`);
} catch (err) {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
