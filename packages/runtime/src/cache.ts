#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main } from "@deftai/directive-core/dist/cache/main.js";

/* v8 ignore start -- entry guard; behaviour covered via main() unit tests */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}

/* v8 ignore stop */

export { main };
