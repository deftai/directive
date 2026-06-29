/**
 * Subprocess entry for sync callers (release pipeline, task build).
 * Top-level await keeps the process alive until the archive is written.
 */
import { buildArchive, selectFormat } from "./build-dist.js";

const version = process.argv[2];
const root = process.argv[3];
if (!version || !root) {
  process.stderr.write("usage: build-dist-runner <version> <root>\n");
  process.exit(2);
}
const fmt = selectFormat(process.env.DEFT_BUILD_FORMAT);
try {
  const out = await buildArchive(root, version, fmt);
  process.stdout.write(`${out}\n`);
} catch (err) {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
