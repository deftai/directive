#!/usr/bin/env node
/**
 * Golden-output parity harness (#1787 s3): runs BOTH the frozen Python oracle
 * modules and the ported TS @deftai/core/platform helpers over shared fixtures,
 * cache-off, and diffs JSON payloads + exit codes.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentsRefreshPlan,
  detectIpTerms,
  disambiguateSlug,
  normalizeSlug,
  probeRuntimeCapabilities,
  reportToDict,
  resolveChangelog,
  resolveVersion,
  toPep440,
} from "@deftai/core/platform";

export interface ParityCase {
  readonly name: string;
  readonly runPython: (deftRoot: string, repo: string) => unknown;
  readonly runTs: (deftRoot: string, repo: string) => unknown;
  readonly setup?: (repo: string) => void;
}

export interface ParityDiff {
  readonly caseName: string;
  readonly mismatch: boolean;
  readonly pythonJson: string;
  readonly tsJson: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

const FIXED_ISO = "2026-06-19T12:00:00Z";
const FIXED_SESSION = "abcdef012345";
const FIXED_SHA = "deadbeefcafe";

const SLUG_FIXTURES = [
  "Hello World",
  "Add widget (v2)!",
  "café latte",
  "El Niño Año",
  "日本語",
  "[x] Fix login bug",
  "con",
  "foo   bar---baz",
];

const PEP440_FIXTURES = ["v0.22.0", "v0.20.0-rc.3", "v0.20.0-beta.2", "0.20.0-alpha.1"];

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT) return resolve(process.env.DEFT_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function runPythonJson(deftRoot: string, code: string): unknown {
  const scriptsDir = join(deftRoot, "scripts").replace(/\\/g, "/");
  const wrapped = [
    "import json,sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    code,
  ].join("\n");
  const stdout = execFileSync("uv", ["run", "python", "-c", wrapped], {
    cwd: deftRoot,
    encoding: "utf8",
    env: { ...process.env, DEFT_CACHE_DISABLE: "1", PYTHONUTF8: "1" },
  });
  return JSON.parse(stdout.trim());
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Strip volatile filesystem paths from capability reports before compare. */
export function normalizeCapabilityReport(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  if (record.ownership && typeof record.ownership === "object") {
    out.ownership = { ...(record.ownership as Record<string, unknown>), path: "<REPO>" };
  }
  return out;
}

/** Normalise volatile agents-refresh plan fields for comparison. */
export function normalizeAgentsPlan(plan: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...plan };
  for (const key of ["sha", "refreshed", "session", "attributed_rendered", "new_content"]) {
    if (key in out) out[key] = "<NORMALIZED>";
  }
  return out;
}

const CHANGELOG_HEADER =
  "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";

function buildConflictChangelog(): string {
  return (
    `${CHANGELOG_HEADER}## [Unreleased]\n\n` +
    "### Added\n\n" +
    "<<<<<<< HEAD\n" +
    "- **feat: head entry** -- landed (#100)\n" +
    "=======\n" +
    "- **feat: branch entry** -- new (#200)\n" +
    ">>>>>>> branch-sha\n\n" +
    "## [0.1.0] - 2026-01-01\n"
  );
}

function readTemplate(deftRoot: string): string {
  // #1875: the AGENTS.md template moved under content/ in the source repo
  // (content/templates/agents-entry.md). Prefer that location and fall back to
  // the flattened layout (templates/agents-entry.md) so the harness resolves in
  // both a source checkout and a flattened consumer deposit.
  const contentCandidate = join(deftRoot, "content", "templates", "agents-entry.md");
  const flatCandidate = join(deftRoot, "templates", "agents-entry.md");
  return readFileSync(existsSync(contentCandidate) ? contentCandidate : flatCandidate, "utf8");
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "slug-normalize-unicode",
    runPython: (deftRoot) =>
      runPythonJson(
        deftRoot,
        [
          "from slug_normalize import normalize_slug, disambiguate_slug",
          `fixtures = ${JSON.stringify(SLUG_FIXTURES)}`,
          "out = {'slugs': [normalize_slug(t) for t in fixtures], 'collision': disambiguate_slug('hello-world', {'hello-world'})}",
          "print(json.dumps(out))",
        ].join("\n"),
      ),
    runTs: () => ({
      slugs: SLUG_FIXTURES.map((t) => normalizeSlug(t)),
      collision: disambiguateSlug("hello-world", new Set(["hello-world"])),
    }),
  },
  {
    name: "version-resolve-manifest",
    setup: (repo) => {
      writeFileSync(join(repo, "VERSION"), "tag: v9.8.7\nref: v9.8.7\n", "utf8");
    },
    runPython: (deftRoot, repo) =>
      runPythonJson(
        deftRoot,
        [
          "import json",
          "from pathlib import Path",
          "import resolve_version as rv",
          `base = Path(${JSON.stringify(repo)})`,
          "print(json.dumps({'version': rv._from_manifest(base), 'pep440': [rv.to_pep440(v) for v in " +
            JSON.stringify(PEP440_FIXTURES) +
            "]}))",
        ].join("\n"),
      ),
    runTs: (_deftRoot, repo) => ({
      version: resolveVersion({
        frameworkRoot: repo,
        fromEnv: () => null,
        fromManifest: (base) => {
          const text = readFileSync(join(base, "VERSION"), "utf8");
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("tag:") || trimmed.startsWith("ref:")) {
              let value = trimmed.slice(trimmed.indexOf(":") + 1).trim();
              if (value.startsWith("v")) value = value.slice(1);
              return value;
            }
          }
          return null;
        },
        fromDeftVersion: () => null,
        fromGit: () => null,
      }),
      pep440: PEP440_FIXTURES.map((v) => toPep440(v)),
    }),
  },
  {
    name: "changelog-union-merge",
    runPython: (deftRoot) =>
      runPythonJson(
        deftRoot,
        [
          "import resolve_changelog_unreleased as r",
          `content = ${JSON.stringify(buildConflictChangelog())}`,
          "new_content, msg = r.resolve_changelog(content)",
          "print(json.dumps({'message': msg, 'has_100': '(#100)' in new_content, 'has_200': '(#200)' in new_content, 'markers': '<<<<<<<' in new_content}))",
        ].join("\n"),
      ),
    runTs: () => {
      const { content, message } = resolveChangelog(buildConflictChangelog());
      return {
        message,
        has_100: content?.includes("(#100)") ?? false,
        has_200: content?.includes("(#200)") ?? false,
        markers: content?.includes("<<<<<<<") ?? false,
      };
    },
  },
  {
    name: "agents-refresh-managed-section",
    setup: (repo) => {
      const deftRoot = resolveDeftRoot();
      const template = readTemplate(deftRoot);
      writeFileSync(
        join(repo, "AGENTS.md"),
        `# Notes\n\n<!-- deft:managed-section v3 sha=old refreshed=2020-01-01T00:00:00Z session=oldsession12 -->\nlegacy body\n<!-- /deft:managed-section -->\n`,
        "utf8",
      );
      mkdirSync(join(repo, "templates"), { recursive: true });
      writeFileSync(join(repo, "templates", "agents-entry.md"), template, "utf8");
    },
    runPython: (deftRoot, repo) => {
      const template = readTemplate(deftRoot);
      return runPythonJson(
        deftRoot,
        [
          "import json",
          "from pathlib import Path",
          "import _agents_md as am",
          `root = Path(${JSON.stringify(repo)})`,
          `template = ${JSON.stringify(template)}`,
          "plan = am._agents_refresh_plan(",
          "    root,",
          "    read_template=lambda: template,",
          `    resolve_sha=lambda: ${JSON.stringify(FIXED_SHA)},`,
          `    now_iso=lambda: ${JSON.stringify(FIXED_ISO)},`,
          `    new_session=lambda: ${JSON.stringify(FIXED_SESSION)},`,
          ")",
          "print(json.dumps({'state': plan['state'], 'rendered_len': len(plan.get('rendered') or ''), 'has_v3': 'v3 sha=' in (plan.get('new_content') or '')}))",
        ].join("\n"),
      );
    },
    runTs: (deftRoot, repo) => {
      const template = readTemplate(deftRoot);
      const plan = agentsRefreshPlan(repo, {
        frameworkRoot: repo,
        readTemplate: () => template,
        resolveSha: () => FIXED_SHA,
        nowIso: () => FIXED_ISO,
        newSession: () => FIXED_SESSION,
      });
      return {
        state: plan.state,
        rendered_len: ((plan.rendered as string | null) ?? "").length,
        has_v3: String(plan.new_content ?? "").includes("v3 sha="),
      };
    },
  },
  {
    name: "platform-capabilities-sandbox",
    setup: (repo) => {
      writeFileSync(join(repo, "uid_map"), "0 1000 1\n1 100001 1\n", "utf8");
    },
    runPython: (deftRoot, repo) =>
      runPythonJson(
        deftRoot,
        [
          "import json",
          "from pathlib import Path",
          "import platform_capabilities as pc",
          `env = {'CURSOR_ORIG_UID': '1000', 'CURSOR_SANDBOX': '1'}`,
          `report = pc.probe_runtime_capabilities(environ=env, uid_map_path=Path(${JSON.stringify(join(repo, "uid_map"))}), cwd=Path(${JSON.stringify(repo)}), effective_uid_override=0)`,
          "payload = report.to_dict()",
          "if payload.get('ownership'): payload['ownership'] = {**payload['ownership'], 'path': '<REPO>'}",
          "print(json.dumps(payload))",
        ].join("\n"),
      ),
    runTs: (_deftRoot, repo) =>
      normalizeCapabilityReport(
        reportToDict(
          probeRuntimeCapabilities({
            environ: { CURSOR_ORIG_UID: "1000", CURSOR_SANDBOX: "1" },
            uidMapPath: join(repo, "uid_map"),
            cwd: repo,
            effectiveUidOverride: 0,
          }),
        ),
      ),
  },
  {
    name: "ip-risk-detect",
    runPython: (deftRoot) =>
      runPythonJson(
        deftRoot,
        [
          "import json",
          "import ip_risk",
          "text = 'A Magic: The Gathering deck-builder with NFL stats'",
          "hits = ip_risk.detect_ip_terms(text)",
          "print(json.dumps([{'term': h.term, 'category': h.category} for h in hits]))",
        ].join("\n"),
      ),
    runTs: () =>
      detectIpTerms("A Magic: The Gathering deck-builder with NFL stats").map((h) => ({
        term: h.term,
        category: h.category,
      })),
  },
];

export function diffCase(name: string, python: unknown, ts: unknown): ParityDiff {
  const pythonJson = stableJson(python);
  const tsJson = stableJson(ts);
  return {
    caseName: name,
    mismatch: pythonJson !== tsJson,
    pythonJson,
    tsJson,
  };
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    const pyRepo = mkdtempSync(join(tmpdir(), "deft-platform-parity-py-"));
    const tsRepo = mkdtempSync(join(tmpdir(), "deft-platform-parity-ts-"));
    try {
      testCase.setup?.(pyRepo);
      testCase.setup?.(tsRepo);
      const python = testCase.runPython(deftRoot, pyRepo);
      const ts = testCase.runTs(deftRoot, tsRepo);
      diffs.push(diffCase(testCase.name, python, ts));
    } finally {
      rmSync(pyRepo, { recursive: true, force: true });
      rmSync(tsRepo, { recursive: true, force: true });
    }
  }
  return { ok: diffs.every((d) => !d.mismatch), diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `platform parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} case(s).`;
  }
  const lines = ["platform parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.mismatch) {
      lines.push(`  case: ${d.caseName}`);
      lines.push("    --- python");
      lines.push(
        d.pythonJson
          .split("\n")
          .slice(0, 12)
          .map((l) => `    ${l}`)
          .join("\n"),
      );
      lines.push("    --- ts");
      lines.push(
        d.tsJson
          .split("\n")
          .slice(0, 12)
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
  }
  return lines.join("\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runParity();
    if (result.ok) {
      process.stdout.write(`${renderReport(result)}\n`);
      process.exit(0);
    }
    process.stderr.write(`${renderReport(result)}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(`platform parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
