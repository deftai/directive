#!/usr/bin/env node
/* v8 ignore file -- thin shebang entry; covered via main.ts tests */
import { fileURLToPath } from "node:url";
import { main } from "./main.js";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
