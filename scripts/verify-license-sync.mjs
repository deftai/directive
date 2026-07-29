#!/usr/bin/env node
/**
 * verify-license-sync.mjs — drift guard for MIT packaging surfaces (#2902).
 *
 * Asserts:
 *   1. Root LICENSE exists and is classic MIT prose GitHub can detect.
 *   2. content/LICENSE.md MIT body normalizes equal to root LICENSE
 *      (content may keep a markdown H1; root should not require one).
 *   3. Root + published package.json files declare "license": "MIT".
 *
 * Exit codes (three-state):
 *   0 — clean
 *   1 — drift / missing required surface
 *   2 — config error (unreadable path / invalid JSON)
 *
 * Usage: node scripts/verify-license-sync.mjs [--project-root <path>]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CONFIG = 2;

const PACKAGE_MANIFESTS = [
  "package.json",
  "packages/cli/package.json",
  "packages/content/package.json",
  "packages/core/package.json",
  "packages/types/package.json",
];

const ROOT_LICENSE_REL = "LICENSE";
const CONTENT_LICENSE_REL = join("content", "LICENSE.md");

/**
 * Normalize license text for comparison:
 * - LF newlines
 * - strip UTF-8 BOM
 * - drop a leading markdown H1 ("# MIT License")
 * - trim trailing whitespace per line
 * - trim leading/trailing blank lines
 * - collapse 3+ blank lines to 2
 */
export function normalizeLicenseBody(raw) {
  let text = String(raw).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  // Drop leading blank lines and a single markdown H1 for "MIT License".
  let i = 0;
  let strippedMarkdownH1 = false;
  while (i < lines.length && lines[i] === "") i += 1;
  if (i < lines.length && /^#\s*MIT License\s*$/i.test(lines[i])) {
    strippedMarkdownH1 = true;
    i += 1;
    while (i < lines.length && lines[i] === "") i += 1;
  }
  // Ensure classic "MIT License" title is present for comparison identity.
  const rest = lines.slice(i);
  let body;
  if (rest.length > 0 && /^MIT License\s*$/i.test(rest[0])) {
    body = rest;
  } else if (strippedMarkdownH1) {
    body = ["MIT License", "", ...rest];
  } else {
    body = rest;
  }
  // Trim trailing blanks.
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  // Collapse runs of blank lines longer than 1 interior blank.
  const out = [];
  let blankRun = 0;
  for (const line of body) {
    if (line === "") {
      blankRun += 1;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

function parseArgs(argv) {
  let projectRoot = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--project-root") {
      const v = argv[i + 1];
      if (!v) {
        return { error: "--project-root requires a path argument" };
      }
      projectRoot = resolve(v);
      i += 1;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { help: true };
    }
    return { error: `unknown argument: ${a}` };
  }
  return { projectRoot };
}

function defaultProjectRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

function readText(path) {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function readJson(path) {
  const r = readText(path);
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.text) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid JSON: ${msg}` };
  }
}

export function evaluateLicenseSync(projectRoot) {
  const findings = [];
  const rootLicensePath = join(projectRoot, ROOT_LICENSE_REL);
  const contentLicensePath = join(projectRoot, CONTENT_LICENSE_REL);

  if (!existsSync(rootLicensePath)) {
    findings.push(`missing root ${ROOT_LICENSE_REL} (GitHub license detection needs a conventional root license file)`);
  }
  if (!existsSync(contentLicensePath)) {
    findings.push(`missing ${CONTENT_LICENSE_REL} (content deposit copy must remain)`);
  }

  let rootNorm = null;
  let contentNorm = null;

  if (existsSync(rootLicensePath)) {
    const rootRead = readText(rootLicensePath);
    if (!rootRead.ok) {
      return {
        exitCode: EXIT_CONFIG,
        message: `config error: cannot read ${ROOT_LICENSE_REL}: ${rootRead.error}`,
        findings: [],
      };
    }
    rootNorm = normalizeLicenseBody(rootRead.text);
    if (!/^MIT License\n/i.test(rootNorm)) {
      findings.push(`root ${ROOT_LICENSE_REL} must start with classic "MIT License" prose (no markdown H1 required)`);
    }
    // Prefer no markdown H1 on the root file (GitHub MIT matcher is classic prose).
    if (/^#\s*MIT License/m.test(rootRead.text.replace(/^\uFEFF/, ""))) {
      findings.push(`root ${ROOT_LICENSE_REL} should be plain MIT prose without a markdown H1`);
    }
  }

  if (existsSync(contentLicensePath)) {
    const contentRead = readText(contentLicensePath);
    if (!contentRead.ok) {
      return {
        exitCode: EXIT_CONFIG,
        message: `config error: cannot read ${CONTENT_LICENSE_REL}: ${contentRead.error}`,
        findings: [],
      };
    }
    contentNorm = normalizeLicenseBody(contentRead.text);
  }

  if (rootNorm !== null && contentNorm !== null && rootNorm !== contentNorm) {
    findings.push(
      `license body drift: ${ROOT_LICENSE_REL} and ${CONTENT_LICENSE_REL} differ after normalization (copyright/terms must match)`,
    );
  }

  // Copyright holder sanity (do not rewrite holder; only detect empty/missing).
  const copyrightRe = /Copyright \(c\) 2025-2026 Jonathan "visionik" Taylor/i;
  if (rootNorm && !copyrightRe.test(rootNorm)) {
    findings.push(`root ${ROOT_LICENSE_REL} missing expected copyright line for Jonathan "visionik" Taylor / 2025-2026`);
  }
  if (contentNorm && !copyrightRe.test(contentNorm)) {
    findings.push(`${CONTENT_LICENSE_REL} missing expected copyright line for Jonathan "visionik" Taylor / 2025-2026`);
  }

  for (const rel of PACKAGE_MANIFESTS) {
    const path = join(projectRoot, rel);
    if (!existsSync(path)) {
      findings.push(`missing package manifest ${rel}`);
      continue;
    }
    const parsed = readJson(path);
    if (!parsed.ok) {
      return {
        exitCode: EXIT_CONFIG,
        message: `config error: cannot parse ${rel}: ${parsed.error}`,
        findings: [],
      };
    }
    if (parsed.value?.license !== "MIT") {
      findings.push(`${rel} must declare "license": "MIT" (got ${JSON.stringify(parsed.value?.license)})`);
    }
  }

  if (findings.length > 0) {
    return {
      exitCode: EXIT_DRIFT,
      message:
        `verify-license-sync: ${findings.length} problem(s) (#2902)\n` +
        findings.map((f) => `  - ${f}`).join("\n") +
        "\n",
      findings,
    };
  }

  return {
    exitCode: EXIT_OK,
    message:
      "verify-license-sync: root LICENSE, content/LICENSE.md, and package.json license fields are in sync (MIT, #2902).\n",
    findings: [],
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/verify-license-sync.mjs [--project-root <path>]\n" +
        "Drift guard for root LICENSE ↔ content/LICENSE.md and package.json license fields (#2902).\n",
    );
    return EXIT_OK;
  }
  if (args.error) {
    process.stderr.write(`verify-license-sync: ${args.error}\n`);
    return EXIT_CONFIG;
  }
  const projectRoot = args.projectRoot ?? defaultProjectRoot();
  if (!existsSync(projectRoot)) {
    process.stderr.write(`verify-license-sync: project root not found: ${projectRoot}\n`);
    return EXIT_CONFIG;
  }
  const result = evaluateLicenseSync(projectRoot);
  if (result.exitCode === EXIT_OK) {
    process.stdout.write(result.message);
  } else {
    process.stderr.write(result.message);
  }
  return result.exitCode;
}

const isDirect =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  process.exit(main());
}
