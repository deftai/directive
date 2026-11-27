import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveSpecArtifactPath } from "../layout/resolve.js";
import { buildPrdBanner, buildSpecRenderBanner } from "../render/constants.js";
import { buildExpectedPrdMarkdown } from "../render/prd-render.js";
import { renderSpecMarkdown } from "../render/spec-render.js";

export interface SpecPrdFreshFinding {
  readonly artifact: "SPECIFICATION.md" | "PRD.md";
  readonly assertion: "banner-canon" | "projection-fresh";
  readonly detail: string;
}

export interface SpecPrdFreshResult {
  readonly code: 0 | 1 | 2;
  readonly findings: readonly SpecPrdFreshFinding[];
  readonly message: string;
}

function readText(path: string): string | { error: string } {
  try {
    return readFileSync(path, { encoding: "utf8" }).replace(/\r\n/g, "\n");
  } catch (err) {
    return { error: String(err) };
  }
}

function bannerBlock(banner: string): string {
  return banner.replace(/\n$/u, "");
}

function committedBanner(content: string): string {
  return content.split("\n").slice(0, 4).join("\n");
}

function normalizeSpec(content: string): string {
  return `${content.replace(/[ \t]+$/gmu, "").replace(/\n+$/u, "")}\n`;
}

function sectionHeadings(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("## "));
}

function tryResolveExistingSpecPath(root: string): string | null {
  try {
    const specPath = resolveSpecArtifactPath(root);
    return existsSync(specPath) ? specPath : null;
  } catch {
    return null;
  }
}

/** Fail-closed SPECIFICATION.md / PRD.md freshness (#4086). Banner canon and projection are separate. */
export function evaluateSpecPrdFresh(projectRoot: string): SpecPrdFreshResult {
  const root = resolve(projectRoot);
  const specPath = tryResolveExistingSpecPath(root);

  const findings: SpecPrdFreshFinding[] = [];
  const expectedSpecBanner =
    specPath === null ? null : bannerBlock(buildSpecRenderBanner(specPath));

  const specMdPath = join(root, "SPECIFICATION.md");
  if (specPath !== null && expectedSpecBanner !== null && existsSync(specMdPath)) {
    const committed = readText(specMdPath);
    if (typeof committed !== "string") {
      return {
        code: 2,
        findings: [],
        message: `verify_spec_prd_fresh: SPECIFICATION.md unreadable: ${committed.error}`,
      };
    }
    if (committedBanner(committed) !== expectedSpecBanner) {
      findings.push({
        artifact: "SPECIFICATION.md",
        assertion: "banner-canon",
        detail:
          "banner does not match `buildGeneratedArtifactBanner` from the resolved specification path; run `task spec:render` or restore the four-line banner",
      });
    }
    const rendered = renderSpecMarkdown(specPath, {
      includeScopes: "off",
      includeLegacyArtifacts: false,
    });
    if (!rendered.ok) {
      findings.push({
        artifact: "SPECIFICATION.md",
        assertion: "projection-fresh",
        detail: `re-render failed: ${rendered.message}`,
      });
    } else {
      // The default render writes Overview..OpenQuestions only. A committed section it
      // does not produce (e.g. a frozen `## Scope outlook`) marks a stale snapshot (#6826).
      const known = new Set(sectionHeadings(rendered.markdown));
      const extra = [...new Set(sectionHeadings(committed))].filter((h) => !known.has(h));
      if (extra.length > 0) {
        findings.push({
          artifact: "SPECIFICATION.md",
          assertion: "projection-fresh",
          detail: `contains section(s) the default \`task spec:render\` does not produce: ${extra
            .map((h) => `"${h}"`)
            .join(", ")}; run \`task spec:render\``,
        });
      } else if (normalizeSpec(rendered.markdown) !== normalizeSpec(committed)) {
        findings.push({
          artifact: "SPECIFICATION.md",
          assertion: "projection-fresh",
          detail:
            "SPECIFICATION.md differs from a fresh compact render buffer; run `task spec:render`",
        });
      }
    }
  }

  const prdMdPath = join(root, "PRD.md");
  if (existsSync(prdMdPath)) {
    const committed = readText(prdMdPath);
    if (typeof committed !== "string") {
      return {
        code: 2,
        findings: [],
        message: `verify_spec_prd_fresh: PRD.md unreadable: ${committed.error}`,
      };
    }
    const expectedPrd = buildExpectedPrdMarkdown(root);
    if (!expectedPrd.ok) {
      if (specPath === null) {
        return {
          code: 2,
          findings: [],
          message:
            `verify_spec_prd_fresh: ${expectedPrd.message}\n` +
            "  Recovery: restore `xbrief/specification.xbrief.json` or `xbrief/PROJECT-DEFINITION.xbrief.json`.",
        };
      }
      findings.push({
        artifact: "PRD.md",
        assertion: "projection-fresh",
        detail: `re-render failed: ${expectedPrd.message}`,
      });
    } else {
      if (committedBanner(committed) !== bannerBlock(buildPrdBanner(expectedPrd.sourcePath))) {
        findings.push({
          artifact: "PRD.md",
          assertion: "banner-canon",
          detail:
            "banner does not match `buildGeneratedArtifactBanner` from the resolved PRD source path; run `task prd:render`",
        });
      }
      if (expectedPrd.markdown !== committed) {
        findings.push({
          artifact: "PRD.md",
          assertion: "projection-fresh",
          detail: "PRD.md differs from a fresh `task prd:render` buffer; run `task prd:render`",
        });
      }
    }
  } else if (specPath === null) {
    return {
      code: 2,
      findings: [],
      message:
        "verify_spec_prd_fresh: specification source missing and no PRD.md to check via PROJECT-DEFINITION.\n" +
        "  Recovery: restore `xbrief/specification.xbrief.json` or pass a greenfield tree with `xbrief/PROJECT-DEFINITION.xbrief.json` and PRD.md.",
    };
  }

  if (findings.length > 0) {
    const body = findings.map((f) => `  ${f.artifact} [${f.assertion}] ${f.detail}`).join("\n");
    return {
      code: 1,
      findings,
      message:
        `verify_spec_prd_fresh: ${findings.length} generated-view freshness error(s) (#4086).\n` +
        "  Banner canon and full projection freshness are separate assertions.\n" +
        `${body}\n` +
        "  Recovery: restore banners via `buildGeneratedArtifactBanner` from the resolved path; re-render PRD.md; run `task spec:render` for SPECIFICATION.md (#6826).",
    };
  }
  return {
    code: 0,
    findings: [],
    message:
      "verify_spec_prd_fresh: SPECIFICATION.md and PRD.md banners and projections are fresh (#4086).",
  };
}

export interface SpecPrdFreshCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runSpecPrdFreshCli(argv: string[]): SpecPrdFreshCliResult {
  let projectRoot = ".";
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "verify_spec_prd_fresh: argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--quiet") {
      quiet = true;
    } else {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `verify_spec_prd_fresh: unrecognized argument: ${arg}\n`,
      };
    }
  }
  const root = isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot);
  const result = evaluateSpecPrdFresh(root);
  if (result.code === 0) {
    return { exitCode: 0, stdout: quiet ? "" : `${result.message}\n`, stderr: "" };
  }
  return { exitCode: result.code, stdout: "", stderr: `${result.message}\n` };
}
