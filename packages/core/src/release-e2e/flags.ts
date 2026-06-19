import { randomUUID } from "node:crypto";
import { REPO_SLUG_PREFIX } from "./constants.js";
import type { E2ESeams } from "./types.js";

export function emit(label: string, status: string): void {
  process.stderr.write(`[e2e] ${label}... ${status}\n`);
}

export function generateRepoSlug(seams: E2ESeams = {}): string {
  if (seams.generateRepoSlug) {
    return seams.generateRepoSlug();
  }
  const now = seams.now ?? (() => new Date());
  const d = now();
  const timestamp =
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0") +
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0") +
    String(d.getUTCSeconds()).padStart(2, "0");
  const suffix = (seams.randomUuidHex ?? (() => randomUUID().replace(/-/g, "")))().slice(0, 6);
  return `${REPO_SLUG_PREFIX}${timestamp}-${suffix}`;
}

export function parseE2EFlags(argv: readonly string[]): import("./types.js").ParsedE2EFlags {
  let help = false;
  let owner = "deftai";
  let dryRun = false;
  let keepRepo = false;
  let projectRoot: string | null = null;
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--keep-repo") {
      keepRepo = true;
    } else if (arg === "--owner") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        unknown.push(arg);
      } else {
        owner = next;
        i += 1;
      }
    } else if (arg.startsWith("--owner=")) {
      owner = arg.slice("--owner=".length);
    } else if (arg === "--project-root") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        unknown.push(arg);
      } else {
        projectRoot = next;
        i += 1;
      }
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg.startsWith("-")) {
      unknown.push(arg);
    } else {
      unknown.push(arg);
    }
  }

  return { help, owner, dryRun, keepRepo, projectRoot, unknown };
}
