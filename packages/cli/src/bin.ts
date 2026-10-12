#!/usr/bin/env node
/**
 * Single launcher entry (D4.3 / AC3.2 / AC3.5).
 *
 * package.json bins `directive`, `deft`, and `deft-hook` all point at dist/bin.js.
 * Optional PATH shims under bin/deft-hook[.cmd] set DEFT_LAUNCHER_MODE=hook for
 * hosts where argv[1] loses the invocation name (common on Windows npm shims).
 */
import { basename } from "node:path";
import { runHookLauncher } from "./hook-launcher.js";
import { runLauncher } from "./launcher.js";

function isHookInvocation(): boolean {
  const mode = (process.env.DEFT_LAUNCHER_MODE || "").trim().toLowerCase();
  if (mode === "hook") return true;
  if (mode === "launcher" || mode === "directive" || mode === "deft") return false;
  const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
  const inv = basename(argv1)
    .toLowerCase()
    .replace(/\.(js|mjs|cjs|cmd|ps1|exe)$/i, "");
  if (inv === "deft-hook" || inv.startsWith("deft-hook.")) return true;
  if (/(^|\/)deft-hook(\.[^/]+)?$/i.test(argv1)) return true;
  return false;
}

const code = isHookInvocation()
  ? runHookLauncher(process.argv.slice(2))
  : runLauncher(process.argv.slice(2));
process.exit(code);
