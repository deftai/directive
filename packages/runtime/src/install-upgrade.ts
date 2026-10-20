#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import type { DispatchIo } from "./dispatch.js";
import { runUpdate } from "./init-cli/update.js";

/**
 * #2064: `deft install-upgrade` is now a thin redirect onto the SAME code path
 * as `directive update` (`runRefreshDeposit`). The two verbs previously had
 * overlapping-but-divergent semantics: `directive update` file-swaps the
 * vendored `.deft/core` payload, rewrites the install manifest (#2056), and
 * regenerates the `.deft-version` marker (#2055), whereas the old
 * `install-upgrade` only wrote the marker/manifest and refreshed AGENTS.md
 * WITHOUT swapping the payload -- so on a stale deposit it reported a confident
 * false no-op ("Project already at X. Nothing to do.") that steered operators
 * away from the command that actually works. Consolidating to one path removes
 * that hazard and gives consumers a single upgrade mental model:
 *   npm i -g @deftai/directive@latest -> deft update -> deft migrate -> deft doctor
 *
 * The legacy `.deft/VERSION` cleanup that only `install-upgrade` used to perform
 * is folded into the shared `runRefreshDeposit` path (see
 * `migrateLegacyInstallManifest` in init-deposit/refresh.ts) so no manifest
 * behavior is dropped. Layout migration (the old `--migrate` flag) is the
 * separate `deft migrate` step in the canonical flow above.
 */

/** One-line notice emitted on the redirect so operators learn the canonical verb. */
export const REDIRECT_NOTICE =
  "install-upgrade: delegating to `directive update` -- the single canonical " +
  "upgrade verb (run `deft update` directly; use `deft migrate` for layout " +
  "migration). Refs #2064.\n";

export interface InstallUpgradeDeps {
  /** Injectable seam so tests can drive the shared update path with fixtures. */
  readonly runUpdate?: (argv: readonly string[], io: DispatchIo) => Promise<number>;
}

/**
 * Translate the historical `install-upgrade` flag surface onto the
 * `directive update` argv. `--project-root <p>` maps to `--repo-root <p>`;
 * `--framework-root` is dropped (update resolves its own content root) and the
 * legacy `--migrate` / `--force` flags are dropped (layout migration is now the
 * separate `deft migrate` step). Any other argv passes through unchanged.
 */
export function translateArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      out.push("--repo-root");
      const value = argv[i + 1];
      if (value !== undefined) {
        out.push(value);
        i += 1;
      }
    } else if (arg.startsWith("--project-root=")) {
      out.push(`--repo-root=${arg.slice("--project-root=".length)}`);
    } else if (arg === "--framework-root") {
      i += 1; // drop the flag and its value
    } else if (arg.startsWith("--framework-root=") || arg === "--migrate" || arg === "--force") {
      // Intentionally dropped: update resolves its own content root, and layout
      // migration is the separate `deft migrate` step in the canonical flow.
    } else {
      out.push(arg);
    }
  }
  return out;
}

function defaultIo(): DispatchIo {
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  };
}

/**
 * Redirect handler: emit the one-line notice, then delegate to the identical
 * code path `directive update` uses so deposit state + stdout are identical.
 */
export async function run(
  argv: readonly string[],
  io: DispatchIo = defaultIo(),
  deps: InstallUpgradeDeps = {},
): Promise<number> {
  const update = deps.runUpdate ?? runUpdate;
  io.writeErr(REDIRECT_NOTICE);
  return update(translateArgs(argv), io);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
