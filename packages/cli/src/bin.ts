#!/usr/bin/env node
/**
 * Single launcher entry (D4.3 / AC3.2 / AC3.5).
 *
 * package.json bins `directive`, `deft`, and `deft-hook` all point here.
 * Dispatch: basename(process.argv[1]) matching `deft-hook`, or
 * DEFT_LAUNCHER_MODE=hook (Windows npm shims often leave argv[1] as bin.js).
 */
import { basename } from "node:path";
import { runHookLauncher } from "./hook-launcher.js";
import { runLauncher } from "./launcher.js";

function isHookInvocation(): boolean {
  const mode = (process.env.DEFT_LAUNCHER_MODE || "").trim().toLowerCase();
  if (mode === "hook") return true;
  if (mode === "launcher" || mode === "directive" || mode === "deft") return false;
  const inv = basename(process.argv[1] ?? "")
    .toLowerCase()
    .replace(/\.(js|mjs|cjs|cmd|ps1|exe)$/i, "");
  return inv === "deft-hook" || inv.startsWith("deft-hook.");
}

const code = isHookInvocation()
  ? runHookLauncher(process.argv.slice(2))
  : runLauncher(process.argv.slice(2));
process.exit(code);
