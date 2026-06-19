export {
  EXIT_EXTERNAL_ERROR,
  EXIT_OK,
  EXIT_PROTECTED_LINKED,
  GH_TIMEOUT_S,
} from "./constants.js";
export { defaultRunGh, fetchClosingIssuesReferences } from "./gh.js";
export { cmdPrProtectedIssues, parseArgs, run } from "./main.js";
export { parseProtected } from "./parse.js";
export type { RunGhFn, RunGhResult } from "./types.js";
