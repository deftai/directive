import type { DispatchIo } from "../dispatch.js";

/** Flags that request usage text without executing a mutating install path (#2828). */
export const INIT_CLI_HELP_FLAGS = ["--help", "-h", "/help", "/h"] as const;

/** True when argv includes a help flag anywhere in the token list. */
export function argvWantsHelp(argv: readonly string[]): boolean {
  const flags = INIT_CLI_HELP_FLAGS as readonly string[];
  return argv.some((arg) => flags.includes(arg));
}

export function printUpdateHelp(io: DispatchIo): void {
  io.writeOut(
    "Usage: directive update [options]\n" +
      "       deft update [options]\n\n" +
      "Refresh the framework deposit in an existing Directive project and self-heal the engine.\n\n" +
      "Options:\n" +
      "  --repo-root <path>          Project root (default: current directory)\n" +
      "  --json                      Machine-readable summary on stdout\n" +
      "  --yes, --non-interactive  Run without prompts\n" +
      "  --dry-run, --plan           Print deposit freshness and classified plan without writing\n" +
      "  -h, --help                  Show this help\n",
  );
}

export function printInitHelp(io: DispatchIo): void {
  io.writeOut(
    "Usage: directive init [options]\n" +
      "       deft init [options]\n\n" +
      "Set up Directive in the current project (greenfield scaffold or brownfield adoption).\n\n" +
      "Options:\n" +
      "  --repo-root <path>          Project root (default: current directory)\n" +
      "  --json                      Machine-readable summary on stdout\n" +
      "  --yes, --non-interactive  Run without prompts\n" +
      "  --dry-run, --plan           Classify and print the dispatch plan without writing\n" +
      "  --headless                  Emit a { version, files } manifest with no side effects\n" +
      "  --output <path>             Manifest output path for --headless (default: stdout)\n" +
      "  -h, --help                  Show this help\n",
  );
}

export function printMigrateHelp(io: DispatchIo): void {
  io.writeOut(
    "Usage: directive migrate [options]\n" +
      "       deft migrate [options]\n\n" +
      "Stamp a canonical-vendored .deft/core deposit as npm-managed (provenance only).\n\n" +
      "Options:\n" +
      "  --repo-root <path>          Project root (default: current directory)\n" +
      "  --json                      Machine-readable summary on stdout\n" +
      "  --untrack-core              Un-commit .deft/core from git (destructive index mutation)\n" +
      "  -h, --help                  Show this help\n",
  );
}
