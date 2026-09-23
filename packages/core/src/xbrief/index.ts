/**
 * On-demand xBRIEF create/verify surface (#3057).
 *
 * create/verify write or check dense SoT artifacts at --out.
 * Scope lifecycle remains scope:promote / activate / complete / etc.
 */

import { runAdoptStoredPlanIdCli } from "./adopt-stored-plan-id.js";
import { runXbriefCreateCli } from "./create.js";
import { runXbriefVerifyCli } from "./verify.js";

export {
  ADOPT_USAGE,
  type AdoptStoredPlanIdOptions,
  adoptStoredPlanId,
  parseAdoptArgv,
  runAdoptStoredPlanIdCli,
} from "./adopt-stored-plan-id.js";
export {
  CREATE_USAGE,
  type CreateOptions,
  createXbrief,
  parseCreateArgv,
  runXbriefCreateCli,
} from "./create.js";
export {
  expandUserPath,
  resolveXbriefOutPaths,
  stripXbriefSuffix,
  XbriefPathError,
} from "./paths.js";
export {
  ADOPT_STORED_PLAN_ID_VERB,
  adoptStoredPlanIdInvocation,
  readStoredPlanIdBinding,
  storedMintIdentityConflict,
} from "./stored-mint-conflict.js";
export {
  type BuildDocumentInput,
  buildStyleDocument,
  MD_REQUIRED_SECTIONS,
  parseMarkdownMeta,
  renderMarkdown,
} from "./styles.js";
export {
  DEFAULT_XBRIEF_SIZE_CAP_BYTES,
  isXbriefFormat,
  isXbriefStyle,
  XBRIEF_FORMATS,
  XBRIEF_STYLES,
  type XbriefCliResult,
  type XbriefDocument,
  type XbriefFormat,
  type XbriefPaths,
  type XbriefStyle,
} from "./types.js";
export {
  parseVerifyArgv,
  runXbriefVerifyCli,
  VERIFY_USAGE,
  type VerifyOptions,
  verifyXbrief,
} from "./verify.js";

/** Dispatch-compatible main for a combined xbrief-cli module (create|verify). */
export function main(argv: string[] = process.argv.slice(2)): number {
  const [verb, ...rest] = argv;
  if (verb === "create") {
    const result = runXbriefCreateCli(rest);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  }
  if (verb === "verify") {
    const result = runXbriefVerifyCli(rest);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  }
  if (verb === "adopt-stored-plan-id") {
    const result = runAdoptStoredPlanIdCli(rest);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  }
  if (verb === "-h" || verb === "--help" || verb === undefined) {
    process.stdout.write(
      "Usage: deft xbrief:create|xbrief:verify|xbrief:adopt-stored-plan-id -- --out <path> [options]\n" +
        "  create/verify dense xBRIEF artifacts (not scope lifecycle).\n" +
        "  adopt-stored-plan-id copies the stored plan-id binding onto plan.id and a paired markdown frontmatter id.\n" +
        "  See: deft xbrief:create --help | deft xbrief:verify --help | deft xbrief:adopt-stored-plan-id --help\n",
    );
    return verb === undefined ? 2 : 0;
  }
  process.stderr.write(`unknown xbrief subcommand: ${verb}\n`);
  return 2;
}
