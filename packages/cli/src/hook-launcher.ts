/**
 * Global `deft-hook` PATH shim (AC3.5), invoked from the single launcher entry
 * when basename(argv[1]) is deft-hook (or DEFT_LAUNCHER_MODE=hook).
 * Host configs should use `node node_modules/@deftai/directive-runtime/dist/hook-bin.js`.
 *
 * Only pre-OVPR repos still register bare `deft-hook` (AC9.1). Entry order
 * (RC-07): no runtime pin + pre-OVPR layout → old-repo message; else runtime
 * missing → project install message; else run the pin's hook-bin. Failures
 * use the host's blocking response (RC-02, `hook-block.ts`). Old Directive
 * code is never run (§A9).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT_CODES,
  HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
  PRE_OVPR_LAYOUT_MESSAGE,
  RECOVERY_GUIDANCE,
  RUNTIME_PACKAGE_NAME,
} from "./constants.js";
import { discoverProject } from "./discover.js";
import { type HookBlock, isToolBefore, parseHookTarget, renderHookBlock } from "./hook-block.js";
import { recognisePreOvprLayout } from "./legacy-shapes/pre-ovpr.js";
import { checkNodeVersion } from "./node-check.js";
import { readInstalledRuntime } from "./pin.js";

function emit(block: HookBlock): number {
  if (block.stdout.length > 0) process.stdout.write(block.stdout);
  if (block.stderr.length > 0) process.stderr.write(block.stderr);
  return block.exitCode;
}

/**
 * @param projectRoot a root the caller already resolved (`deft hook:dispatch
 *   --root <path>`); when null, discover it from the working directory.
 */
export function runHookLauncher(argv: string[], projectRoot: string | null = null): number {
  const node = checkNodeVersion();
  if (!node.ok) {
    process.stderr.write(`${node.message}\n`);
    return node.exitCode;
  }

  const discovered =
    projectRoot !== null
      ? { ok: true as const, root: projectRoot }
      : discoverProject({ cwd: process.cwd() });
  if (!discovered.ok) {
    process.stderr.write(
      `deft-hook: no project root. Host hooks should call ` +
        `node node_modules/${RUNTIME_PACKAGE_NAME}/dist/hook-bin.js\n` +
        `Recovery: ${RECOVERY_GUIDANCE}\n`,
    );
    return EXIT_CODES.FAILURE;
  }

  const { host, event } = parseHookTarget(argv);

  // RC-07: an old repo has no runtime pin, so check its layout before
  // "runtime missing". Nothing is spawned on this path.
  if (recognisePreOvprLayout(discovered.root) !== null) {
    return emit(renderHookBlock(host, event, PRE_OVPR_LAYOUT_MESSAGE));
  }

  const hookEntry = join(
    discovered.root,
    "node_modules",
    ...RUNTIME_PACKAGE_NAME.split("/"),
    "dist",
    "hook-bin.js",
  );
  if (readInstalledRuntime(discovered.root) === null || !existsSync(hookEntry)) {
    // "deft-hook:" names the source; the guidance itself stays the outer's text.
    return emit(renderHookBlock(host, event, `deft-hook: ${HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE}`));
  }

  // Claude/Codex treat exit 1 as "carry on"; a pre-tool non-decision must block.
  const blockNonDecision = (host === "claude" || host === "codex") && isToolBefore(event);

  const result = spawnSync(process.execPath, [hookEntry, ...argv], {
    cwd: discovered.root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`deft-hook: failed to start runtime hook: ${result.error.message}\n`);
    return blockNonDecision ? 2 : EXIT_CODES.FAILURE;
  }
  if (result.status === null && result.signal) {
    return blockNonDecision ? 2 : EXIT_CODES.INTERRUPTED;
  }
  const status = result.status ?? EXIT_CODES.FAILURE;
  return status !== 0 && blockNonDecision ? 2 : status;
}
