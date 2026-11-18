/**
 * Global `deft-hook` PATH shim (AC3.5), invoked from the single launcher entry
 * when basename(argv[1]) is deft-hook (or DEFT_LAUNCHER_MODE=hook).
 * OVPR host configs call the committed `.mjs` outer, never bare `deft-hook`.
 *
 * Entry order (RC-07 / RC-12): no runtime pin and an old-style project → run
 * the project's own installed pre-split copy, or block with the old-project
 * message when none is installed; a runtime pin → run the pinned runtime's
 * hook-bin, or block with project install guidance when it is missing or at
 * another version (AC10.11). Blocks use the host's response (RC-02,
 * `hook-block.ts`). Never a global, out-of-project or different-version copy.
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
import { type ProjectLocalCopy, recognisePreOvprLayout } from "./legacy-shapes/pre-ovpr.js";
import { checkNodeVersion } from "./node-check.js";
import { readInstalledRuntime, readPin } from "./pin.js";

function emit(block: HookBlock): number {
  if (block.stdout.length > 0) process.stdout.write(block.stdout);
  if (block.stderr.length > 0) process.stderr.write(block.stderr);
  return block.exitCode;
}

/**
 * Run a bin of the project's own pre-split copy with the same arguments,
 * standard input, environment and working directory, and return its exit
 * code. Null when the copy has no such bin.
 */
export function runProjectLocalCopy(
  copy: ProjectLocalCopy,
  binName: string,
  args: readonly string[],
): number | null {
  const file = copy.bins[binName];
  if (file === undefined) return null;
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`deft: failed to start ${binName}: ${result.error.message}\n`);
    return EXIT_CODES.FAILURE;
  }
  if (result.status === null && result.signal) return EXIT_CODES.INTERRUPTED;
  return result.status ?? EXIT_CODES.FAILURE;
}

/** How the hook launcher was reached: `deft-hook …` or `deft hook:dispatch …`. */
export type HookEntry = "deft-hook" | "hook:dispatch";

/**
 * @param projectRoot a root the caller already resolved (`deft hook:dispatch
 *   --root <path>`); when null, discover it from the working directory.
 * @param entry `hook:dispatch` hands an old-style project's call to the copy's
 *   `deft` bin as `deft hook:dispatch …`, as its own registration did.
 */
export function runHookLauncher(
  argv: string[],
  projectRoot: string | null = null,
  entry: HookEntry = "deft-hook",
): number {
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

  // RC-07 / RC-12: an old-style project has no runtime pin, so check it before
  // "runtime missing", and hand the call to its own installed copy.
  const old = recognisePreOvprLayout(discovered.root, { hookCall: true });
  if (old !== null) {
    if (old.localCopy !== null) {
      const code =
        entry === "hook:dispatch"
          ? runProjectLocalCopy(old.localCopy, "deft", ["hook:dispatch", ...argv])
          : runProjectLocalCopy(old.localCopy, "deft-hook", argv);
      if (code !== null) return code;
    }
    return emit(renderHookBlock(host, event, PRE_OVPR_LAYOUT_MESSAGE));
  }

  // AC10.11: a bare deft-hook call in a runtime-pinned project is out-of-date
  // wiring; the pinned runtime's readiness check rewrites it (AC8.6).
  const hookEntry = join(
    discovered.root,
    "node_modules",
    ...RUNTIME_PACKAGE_NAME.split("/"),
    "dist",
    "hook-bin.js",
  );
  const installed = readInstalledRuntime(discovered.root);
  const pin = readPin(discovered.root);
  const versionMismatch =
    installed !== null && pin.kind === "exact" && pin.version !== installed.version;
  if (installed === null || versionMismatch || !existsSync(hookEntry)) {
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
