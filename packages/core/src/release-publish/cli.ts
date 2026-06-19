/* v8 ignore file -- thin shebang entry; covered via main.ts tests */
import { fileURLToPath } from "node:url";
import { cmdReleasePublish } from "./main.js";

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(cmdReleasePublish(process.argv.slice(2)));
}
