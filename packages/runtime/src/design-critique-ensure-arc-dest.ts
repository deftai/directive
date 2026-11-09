#!/usr/bin/env node
/**
 * design-critique:ensure-arc-dest — sanctioned pin-bin arc dest create/verify (#6142).
 * Defaults to guarded-prep; explicit process-only-no-install for pin-read callers.
 * Never treat gitignored packages/core/dist as SoT — call this verb instead.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ArcDestInstallMode,
  ensureArcDest,
} from "@deftai/directive-core/dist/design-critique/arc-dest.js";

export const DESIGN_CRITIQUE_ENSURE_ARC_DEST_HELP = `design-critique:ensure-arc-dest — create/verify arc dest via pin-bin (#6142)

Usage:
  deft design-critique:ensure-arc-dest --dest-path <path> [--project-root PATH] [--against-implementation SHA] [--install-mode guarded-prep|process-only-no-install] [--json]

Options:
  --dest-path PATH          Linked worktree path for the arc dest (required)
  --project-root PATH       Repo root that owns the worktree (default: cwd)
  --against-implementation SHA  Fetched PR head SHA (against-implementation pin)
  --install-mode MODE       guarded-prep (default) or process-only-no-install
  --json                    Emit structured result

Exit codes:
  0  Dest created or reused with selected install mode
  1  Operational refuse (prep failed, runtime pin missing, stranger lease, …)
  2  Config / usage error
`;

export interface DesignCritiqueEnsureArcDestArgs {
  destPath: string | null;
  projectRoot: string;
  againstImplementationSha: string | null;
  installMode: ArcDestInstallMode | null;
  emitJson: boolean;
  help: boolean;
  error?: string;
}

export function parseDesignCritiqueEnsureArcDestArgs(
  argv: readonly string[],
): DesignCritiqueEnsureArcDestArgs {
  const acc: DesignCritiqueEnsureArcDestArgs = {
    destPath: null,
    projectRoot: ".",
    againstImplementationSha: null,
    installMode: null,
    emitJson: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...acc, help: true };
    if (arg === "--json") {
      acc.emitJson = true;
      continue;
    }
    if (arg === "--dest-path") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...acc, error: "argument --dest-path: expected one argument" };
      }
      acc.destPath = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--dest-path=")) {
      acc.destPath = arg.slice("--dest-path=".length);
      continue;
    }
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...acc, error: "argument --project-root: expected one argument" };
      }
      acc.projectRoot = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--project-root=")) {
      acc.projectRoot = arg.slice("--project-root=".length);
      continue;
    }
    if (arg === "--against-implementation") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...acc, error: "argument --against-implementation: expected one argument" };
      }
      acc.againstImplementationSha = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--against-implementation=")) {
      acc.againstImplementationSha = arg.slice("--against-implementation=".length);
      continue;
    }
    if (arg === "--install-mode") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...acc, error: "argument --install-mode: expected one argument" };
      }
      if (value !== "guarded-prep" && value !== "process-only-no-install") {
        return {
          ...acc,
          error: "argument --install-mode: expected guarded-prep|process-only-no-install",
        };
      }
      acc.installMode = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--install-mode=")) {
      const value = arg.slice("--install-mode=".length);
      if (value !== "guarded-prep" && value !== "process-only-no-install") {
        return {
          ...acc,
          error: "argument --install-mode: expected guarded-prep|process-only-no-install",
        };
      }
      acc.installMode = value;
      continue;
    }
    return { ...acc, error: `unknown argument: ${arg}` };
  }
  return acc;
}

export function run(argv: readonly string[]): number {
  const args = parseDesignCritiqueEnsureArcDestArgs(argv);
  if (args.help) {
    process.stdout.write(`${DESIGN_CRITIQUE_ENSURE_ARC_DEST_HELP}\n`);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`design-critique:ensure-arc-dest: ${args.error}\n`);
    return 2;
  }
  if (args.destPath === null || args.destPath.trim().length === 0) {
    process.stderr.write(
      "design-critique:ensure-arc-dest: --dest-path is required\n" +
        "Remediation: deft design-critique:ensure-arc-dest --dest-path .deft-scratch/worktrees/arc-<N>\n",
    );
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const destPath = resolve(projectRoot, args.destPath);
  let result: ReturnType<typeof ensureArcDest>;
  try {
    result = ensureArcDest({
      repoRoot: projectRoot,
      destPath,
      againstImplementationSha: args.againstImplementationSha ?? undefined,
      installMode: args.installMode ?? "guarded-prep",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.emitJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: "ensure-failed", message }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`design-critique:ensure-arc-dest: ${message}\n`);
    }
    return 1;
  }

  if (args.emitJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `design-critique:ensure-arc-dest: ok dest=${result.destPath} sha=${result.dispatchSha} pin=${result.pinKind} reused=${result.reused}\n`,
    );
  } else {
    process.stderr.write(`design-critique:ensure-arc-dest: ${result.code}: ${result.message}\n`);
  }
  return result.ok ? 0 : 1;
}

export function main(argv: readonly string[]): number {
  return run(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
