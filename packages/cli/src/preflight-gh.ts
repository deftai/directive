#!/usr/bin/env node
/**
 * preflight-gh.ts -- CLI for the destructive-gh-verb gate (#1019).
 *
 * Usage:
 *   deft-ts preflight-gh --self-test
 *   deft-ts preflight-gh --command "<gh ...>"
 *   deft-ts preflight-gh --pre-push-stdin  (reads from stdin)
 *
 * Thin shim -- delegates to @deftai/core/preflight-gh.
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BRANCHES,
  ENV_BYPASS,
  evaluateCommand,
  runSelfTest,
} from "@deftai/core/preflight-gh";

interface ParsedArgs {
  mode?: "self-test" | "command" | "pre-push-stdin";
  command?: string;
  defaultBranches?: Set<string>;
  quiet?: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { defaultBranches: new Set(DEFAULT_BRANCHES) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--self-test") {
      parsed.mode = "self-test";
    } else if (arg === "--pre-push-stdin") {
      parsed.mode = "pre-push-stdin";
    } else if (arg === "--command") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ...parsed, error: "argument --command: expected one argument" };
      }
      parsed.mode = "command";
      parsed.command = next;
      i++;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--default-branch") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ...parsed, error: "argument --default-branch: expected one argument" };
      }
      parsed.defaultBranches ??= new Set();
      parsed.defaultBranches.add(next);
      i++;
    } else if (arg === "--project-root") {
      // accepted for parity with preflight_branch.py; ignored here
      i++;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number | Promise<number> {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`preflight-gh: ${args.error}\n`);
    return 2;
  }

  const quiet = args.quiet ?? false;
  const branches = args.defaultBranches ?? new Set(DEFAULT_BRANCHES);

  if (args.mode === "self-test") {
    const [code, msg] = runSelfTest();
    if (code === 0) {
      if (!quiet) process.stdout.write(`${msg}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return code;
  }

  if (args.mode === "command" && args.command !== undefined) {
    const [code, msg] = evaluateCommand(args.command, branches);
    if (code === 0) {
      if (!quiet) process.stdout.write(`${msg}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return code;
  }

  if (args.mode === "pre-push-stdin") {
    return runPrePushStdin(branches, quiet);
  }

  process.stderr.write(
    "preflight-gh: one of --self-test / --command / --pre-push-stdin required\n",
  );
  return 2;
}

interface RefLine {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}

function parsePrePushLines(text: string): RefLine[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .flatMap((l) => {
      const parts = l.split(/\s+/);
      if (parts.length !== 4) return [];
      return [
        {
          localRef: parts[0] ?? "",
          localOid: parts[1] ?? "",
          remoteRef: parts[2] ?? "",
          remoteOid: parts[3] ?? "",
        },
      ];
    });
}

const ZERO_OID_RE = /^0+$/;

function evaluatePrePush(refs: RefLine[], branches: ReadonlySet<string>): [number, string] {
  if (refs.length === 0) {
    return [0, "✓ deft destructive-gh-verb gate (pre-push): no refs in stdin -- nothing to gate."];
  }

  const branchesLower = new Set([...branches].map((b) => b.toLowerCase()));
  const blocked: string[] = [];

  for (const { localRef, localOid, remoteRef, remoteOid } of refs) {
    const branch = remoteRef.replace(/^refs\/heads\//, "");
    if (!branchesLower.has(branch.toLowerCase())) continue;
    if (ZERO_OID_RE.test(remoteOid)) {
      blocked.push(`create ${branch} (local=${localRef})`);
    } else if (ZERO_OID_RE.test(localOid)) {
      blocked.push(`delete ${branch}`);
    } else {
      blocked.push(`update ${branch} (local=${localRef})`);
    }
  }

  if (blocked.length === 0) {
    return [
      0,
      "✓ deft destructive-gh-verb gate (pre-push): no pushes to default branches detected -- proceeding.",
    ];
  }

  const bypass = (process.env[ENV_BYPASS] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(bypass)) {
    return [
      0,
      `⚠ deft destructive-gh-verb gate (pre-push): default-branch push detected (${blocked.join("; ")}) but ${ENV_BYPASS}=1 is set -- policy bypassed for this invocation.`,
    ];
  }

  return [
    1,
    [
      "❌ deft destructive-gh-verb gate (pre-push): refusing to push directly to the default branch.",
      `  Detail: ${blocked.join("; ")}`,
      "",
      "  How to proceed:",
      "    • push to a feature branch and open a PR",
      `    • or set the env-var bypass for this shell:  ${ENV_BYPASS}=1`,
      "  See scm/github.md (## Destructive gh verbs (#1019)).",
    ].join("\n"),
  ];
}

function runPrePushStdin(branches: ReadonlySet<string>, quiet: boolean): Promise<number> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => lines.push(l));
    rl.on("close", () => {
      const refs = parsePrePushLines(lines.join("\n"));
      const [code, msg] = evaluatePrePush(refs, branches);
      if (code === 0) {
        if (!quiet) process.stdout.write(`${msg}\n`);
      } else {
        process.stderr.write(`${msg}\n`);
      }
      resolve(code);
    });
  });
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = run(process.argv.slice(2));
  if (result instanceof Promise) {
    result.then((code) => process.exit(code)).catch(() => process.exit(2));
  } else {
    process.exit(result);
  }
}
/* v8 ignore stop */
