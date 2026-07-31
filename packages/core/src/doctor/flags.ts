import { DOCTOR_ALLOWED_FLAGS } from "./constants.js";
import type { DoctorFlags } from "./types.js";

export function parseDoctorFlags(args: readonly string[]): DoctorFlags {
  let session = false;
  let fix = false;
  let json = false;
  let quiet = false;
  let full = false;
  let network = false;
  let help = false;
  let projectRoot: string | null = null;
  let force = false;
  let openclawAllAgents = false;
  const unknown: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "--session") {
      session = true;
    } else if (token === "--fix" || token === "--repair" || token === "--repair-taskfile") {
      fix = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--quiet") {
      quiet = true;
    } else if (token === "--full") {
      full = true;
    } else if (token === "--network") {
      network = true;
    } else if (token === "--force") {
      force = true;
    } else if (token === "--openclaw-all-agents") {
      openclawAllAgents = true;
    } else if (token === "-h" || token === "--help") {
      help = true;
    } else if (token === "--project-root") {
      if (i + 1 >= args.length) {
        unknown.push("--project-root (missing value)");
      } else {
        i += 1;
        projectRoot = args[i] ?? null;
      }
    } else if (token.startsWith("--project-root=")) {
      const value = token.split("=", 2)[1] ?? "";
      if (value) {
        projectRoot = value;
      } else {
        unknown.push("--project-root= (empty value)");
      }
    } else {
      unknown.push(token);
    }
    i += 1;
  }
  return {
    session,
    fix,
    json,
    quiet,
    full,
    network,
    help,
    projectRoot,
    force,
    openclawAllAgents,
    unknown,
  };
}

export function formatUnknownFlagsError(unknown: readonly string[]): string {
  return `Unknown flag(s): ${unknown.join(", ")}`;
}

export function formatAllowedFlagsHint(): string {
  return `Allowed: ${DOCTOR_ALLOWED_FLAGS.join(", ")}`;
}
