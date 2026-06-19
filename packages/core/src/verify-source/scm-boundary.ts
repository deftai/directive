import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fnmatchCase } from "../encoding/text.js";
import { scanPythonGhCalls } from "./python-call-scan.js";

export const GH_BINARIES = new Set(["gh", "ghx"]);

export const SCOPE_GLOBS: readonly string[] = [
  "scripts/triage_*.py",
  "scripts/_triage_*.py",
  "scripts/scope_*.py",
  "scripts/_scope_*.py",
  "scripts/slice_*.py",
  "scripts/resume_conditions.py",
  "scripts/issue_ingest.py",
];

export const BUILTIN_ALLOW_LIST: readonly string[] = [
  "scripts/scm.py",
  "tests/cli/test_verify_scm_boundary.py",
];

export interface ScmFinding {
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly helper: string;
  readonly context: string;
}

export function renderScmFinding(f: ScmFinding): string {
  const ctx = f.context.length <= 120 ? f.context : `${f.context.slice(0, 117)}...`;
  return `  ${f.path}:${f.line}:${f.col} [${f.helper}] ${ctx}`;
}

function loadAllowList(path: string | null): string[] | { error: string } {
  if (path === null) {
    return [];
  }
  if (!existsSync(path)) {
    return {
      error:
        `verify_scm_boundary: --allow-list file not found: [Errno 2] No such file or directory: '${path}'\n` +
        "  Recovery: pass an existing path or omit the flag.",
    };
  }
  try {
    const raw = readFileSync(path, { encoding: "utf8" });
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) {
        continue;
      }
      out.push(stripped);
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error:
        `verify_scm_boundary: --allow-list unreadable: ${msg}\n` +
        "  Recovery: check file permissions.",
    };
  }
}

function isAllowListed(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pat) => fnmatchCase(relPath, pat));
}

function globOnePattern(projectRoot: string, pattern: string): Array<[string, string]> {
  const slash = pattern.lastIndexOf("/");
  const dir = slash >= 0 ? join(projectRoot, pattern.slice(0, slash)) : projectRoot;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(dir)) {
    const rel = slash >= 0 ? `${pattern.slice(0, slash)}/${name}` : name;
    const full = join(projectRoot, rel);
    try {
      if (!statSync(full).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    if (fnmatchCase(rel.replace(/\\/g, "/"), pattern)) {
      out.push([rel.replace(/\\/g, "/"), full]);
    }
  }
  return out;
}

export function candidateFiles(
  projectRoot: string,
  scopeGlobs: readonly string[] = SCOPE_GLOBS,
): Array<[string, string]> {
  const out = new Map<string, string>();
  for (const pattern of scopeGlobs) {
    for (const [rel, full] of globOnePattern(projectRoot, pattern)) {
      out.set(rel, full);
    }
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function scanFile(relPath: string, fullPath: string): ScmFinding[] {
  let source: string;
  try {
    source = readFileSync(fullPath, { encoding: "utf8" });
  } catch {
    return [];
  }

  const findings: ScmFinding[] = [];
  const sites = scanPythonGhCalls(source);
  for (const site of sites) {
    findings.push({
      path: relPath,
      line: site.line,
      col: site.col,
      helper: site.helper,
      context: site.context,
    });
  }
  return findings;
}

export interface ScmEvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly findings: readonly ScmFinding[];
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

export interface ScmEvaluateOptions {
  readonly allowListPath?: string | null;
  readonly scopeGlobs?: readonly string[];
  readonly quiet?: boolean;
}

export function evaluateScmBoundary(
  projectRoot: string,
  options: ScmEvaluateOptions = {},
): ScmEvaluateResult {
  const root = resolve(projectRoot);
  const allowLoaded = loadAllowList(options.allowListPath ?? null);
  if (!Array.isArray(allowLoaded)) {
    return { code: 2, findings: [], message: allowLoaded.error, stream: "stderr" };
  }

  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      code: 2,
      findings: [],
      message:
        `verify_scm_boundary: --project-root is not a directory: ${root}\n` +
        "  Recovery: pass an existing directory path.",
      stream: "stderr",
    };
  }

  const allowGlobs = [...BUILTIN_ALLOW_LIST, ...allowLoaded];
  const scopeGlobs = options.scopeGlobs ?? SCOPE_GLOBS;
  const candidates = candidateFiles(root, scopeGlobs);
  const findings: ScmFinding[] = [];
  let scanned = 0;

  for (const [rel, full] of candidates) {
    if (isAllowListed(rel, allowGlobs)) {
      continue;
    }
    scanned += 1;
    findings.push(...scanFile(rel, full));
  }

  if (findings.length > 0) {
    const filesWithHits = new Set(findings.map((f) => f.path)).size;
    const header =
      `verify_scm_boundary: detected ${findings.length} raw ` +
      "`gh` / `ghx` subprocess call(s) across " +
      `${filesWithHits} file(s) (#1145 / N5).\n` +
      "  Root cause: the verb layer is required to invoke `gh` only via `scripts.scm.call(source, verb, args, **kwargs)` so a future\n" +
      "  GitLab / Gitea / local consumer sees a loud `NotImplementedError` (see #445 / #935 Workstream 6) instead of a confusing\n" +
      "  `gh: command not found` deep in the call stack. Fix: rewrite the offending call sites as\n" +
      "    `import scm`\n" +
      '    `scm.call("github-issue", verb, args, ...)`\n' +
      "  Allow-list a documented exception via `--allow-list <path>` (file with newline-separated glob patterns).";
    let body = findings
      .slice(0, 50)
      .map((f) => renderScmFinding(f))
      .join("\n");
    if (findings.length > 50) {
      body += `\n  ... and ${findings.length - 50} more`;
    }
    return { code: 1, findings, message: `${header}\n${body}`, stream: "stderr" };
  }

  const msg = `verify_scm_boundary: ${scanned} verb-layer file(s) clean -- every \`gh\` / \`ghx\` invocation routes through \`scm.call\` (#1145 / N5).`;
  if (options.quiet) {
    return { code: 0, findings: [], message: "", stream: "stdout" };
  }
  return { code: 0, findings: [], message: msg, stream: "stdout" };
}
