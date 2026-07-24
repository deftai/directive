import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as ruleMapMain } from "./rule-map.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A rule doc whose body deliberately contains the tokens that break naive inline-JSON
// injection: `$&` / `$1` / `$'` (special in String.prototype.replace replacements) and a
// literal `</script>` / `<!--` that could terminate the inline <script> if not escaped.
const CODING_MD = `# Coding Standards

Core software-development rules for agents.

## Testing

- ! MUST write tests for new code
- ⊗ MUST NOT commit secrets
- ~ SHOULD run the linter
- ≉ SHOULD NOT skip the gate
- ? MAY cache results

## Gotchas

Use \`sed 's/foo/$&-$1/g'\` and mind \`$'\` quoting. Inline markup such as
</script> and <!-- a comment --> must not break the embedded data blob.
`;

const SKILLS_README = `# Skills

Packaged multi-step agent workflows.
`;

const SKILL_MD = `# Build

- ~ SHOULD do the thing
`;

const TASKFILE_YML = `version: '3'

includes:
  scm:
    taskfile: ./tasks/scm.yml
  metrics:
    taskfile: ./tasks/metrics.yml
`;

const TASKS_YML = `version: '3'

# Source-control conventions

tasks:
  commit:
    desc: "Create a commit"
  push:
    desc: "Push the branch"
  sync:
    desc: >-
      Sync the local branch
      with the upstream remote.
`;

const METRICS_YML = `version: '3'

# Trend readout (--window=7d|30d) (--format=text|json)

tasks:
  show:
    desc: "Show metrics"
`;

const PACK_JSON = JSON.stringify({
  pack: "core",
  version: "1.0.0",
  rules: [
    { tier: "MUST", domain: "hygiene" },
    { tier: "SHOULD", domain: "testing" },
  ],
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-rule-map-"));
  temps.push(root);

  const coding = join(root, "content", "coding");
  mkdirSync(coding, { recursive: true });
  writeFileSync(join(coding, "coding.md"), CODING_MD, "utf8");

  // A grouping with a README plus a nested directory, to exercise the dir summariser.
  const skills = join(root, "content", "skills");
  mkdirSync(join(skills, "build"), { recursive: true });
  writeFileSync(join(skills, "README.md"), SKILLS_README, "utf8");
  writeFileSync(join(skills, "build", "SKILL.md"), SKILL_MD, "utf8");

  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(join(root, "tasks", "scm.yml"), TASKS_YML, "utf8");
  writeFileSync(join(root, "tasks", "metrics.yml"), METRICS_YML, "utf8");
  writeFileSync(join(root, "Taskfile.yml"), TASKFILE_YML, "utf8");

  const packs = join(root, "content", "packs");
  mkdirSync(packs, { recursive: true });
  writeFileSync(join(packs, "core.pack.json"), PACK_JSON, "utf8");

  return root;
}

function mdPathOf(root: string): string {
  return join(root, "docs", "RULE-MAP.md");
}
function htmlPathOf(root: string): string {
  return join(root, "docs", "rule-map", "index.html");
}

/** Extract the injected `window.DIRECTIVE_DATA = <blob>;</script>` payload. */
function extractDataBlob(html: string): string {
  const marker = "window.DIRECTIVE_DATA = ";
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = start + marker.length;
  const end = html.indexOf(";</script>", from);
  expect(end).toBeGreaterThan(from);
  return html.slice(from, end);
}

describe("rule-map generator", () => {
  it("writes committed markdown + gitignored html and prints structure", () => {
    const root = makeRepo();
    expect(ruleMapMain(["--project-root", root])).toBe(0);

    expect(existsSync(mdPathOf(root))).toBe(true);
    expect(existsSync(htmlPathOf(root))).toBe(true);

    const md = readFileSync(mdPathOf(root), "utf8");
    expect(md).toContain("# Directive Rule Map");
    expect(md).toContain("## Rule groupings");
    expect(md).toContain("coding");
    expect(md).toContain("skills");
    expect(md).toContain("## Task namespaces");
    expect(md).toContain("scm");
    expect(md).toContain("## Lifecycle");
    // RFC2119 tier columns are rendered.
    expect(md).toContain("MUST");
    expect(md).toContain("SHOULD NOT");
  });

  it("markdown is timestamp-free and byte-identical across re-runs", () => {
    const root = makeRepo();
    ruleMapMain(["--project-root", root]);
    const first = readFileSync(mdPathOf(root), "utf8");
    ruleMapMain(["--project-root", root]);
    const second = readFileSync(mdPathOf(root), "utf8");
    expect(second).toBe(first);
    // No ISO date-times or other volatile fields that would churn diffs.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("--check passes right after a render", () => {
    const root = makeRepo();
    ruleMapMain(["--project-root", root]);
    expect(ruleMapMain(["--project-root", root, "--check"])).toBe(0);
  });

  it("--check fails when the taxonomy changed without regenerating", () => {
    const root = makeRepo();
    ruleMapMain(["--project-root", root]);
    const patterns = join(root, "content", "patterns");
    mkdirSync(patterns, { recursive: true });
    writeFileSync(
      join(patterns, "p.md"),
      "# Patterns\n\nReusable patterns.\n\n- ! MUST reuse\n",
      "utf8",
    );
    expect(ruleMapMain(["--project-root", root, "--check"])).toBe(1);
  });

  it("embeds a valid-JS data blob despite $-sequences and </script> in rule text", () => {
    const root = makeRepo();
    ruleMapMain(["--project-root", root]);
    const html = readFileSync(htmlPathOf(root), "utf8");

    expect(html).toContain("window.DIRECTIVE_DATA = {");
    expect(html).not.toContain("window.DIRECTIVE_DATA = /*__DATA__*/ null");

    const blob = extractDataBlob(html);
    const model = JSON.parse(blob) as { groupings: unknown[]; tasks: unknown[]; packs: unknown[] };
    expect(Array.isArray(model.groupings)).toBe(true);
    expect(Array.isArray(model.tasks)).toBe(true);

    // $-sequences survived verbatim — proves a replacer FUNCTION was used, not a
    // string replacement (which would have interpreted $&, $1, $').
    expect(blob).toContain("$&");
    expect(blob).toContain("$1");
    // The literal </script> in the body was neutralised so it cannot close the script.
    expect(blob).not.toContain("</script>");
    expect(blob).toContain("\\u003c/script>");
  });

  it("html loads no external assets (opens from file://)", () => {
    const root = makeRepo();
    ruleMapMain(["--project-root", root]);
    const html = readFileSync(htmlPathOf(root), "utf8");
    expect(html).not.toMatch(/<script\s+[^>]*src=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toContain("@import");
    // Renders the three top-level views.
    expect(html).toContain("Rules");
    expect(html).toContain("Tasks");
    expect(html).toContain("Lifecycle");
  });

  it("--help prints usage and returns 0", () => {
    expect(ruleMapMain(["--help"])).toBe(0);
    expect(ruleMapMain(["-h"])).toBe(0);
  });

  it("returns 2 when the target is not a Directive repo", () => {
    const empty = mkdtempSync(join(tmpdir(), "deft-rule-map-empty-"));
    temps.push(empty);
    expect(ruleMapMain(["--project-root", empty])).toBe(2);
  });

  it("folds YAML block-scalar task descriptions into one line", () => {
    const root = makeRepo();
    ruleMapMain(["--project-root", root]);
    const html = readFileSync(htmlPathOf(root), "utf8");
    const model = JSON.parse(extractDataBlob(html)) as {
      tasks: { namespace: string; tasks: { name: string; desc: string }[] }[];
    };
    const scm = model.tasks.find((t) => t.namespace === "scm");
    const sync = scm?.tasks.find((t) => t.name === "sync");
    expect(sync?.desc).toBe("Sync the local branch with the upstream remote.");
  });

  it("escapes literal pipe characters inside Markdown table cells", () => {
    const root = makeRepo();
    ruleMapMain(["--project-root", root]);
    const md = readFileSync(mdPathOf(root), "utf8");
    // Unescaped `|` would split the table column; escaped form preserves the option syntax.
    expect(md).toContain("--format=text\\|json");
    expect(md).toContain("--window=7d\\|30d");
    const metricsRow = md.split("\n").find((l) => l.includes("| metrics |"));
    expect(metricsRow).toBeDefined();
    // Purpose is a single cell: no raw `|json` / `|30d` column breaks (only `\|…`).
    expect(metricsRow).not.toMatch(/(?<!\\)\|json/);
    expect(metricsRow).not.toMatch(/(?<!\\)\|30d/);
  });

  it("does not throw when the repo has content/ but no tasks/ directory", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-rule-map-notasks-"));
    temps.push(root);
    const coding = join(root, "content", "coding");
    mkdirSync(coding, { recursive: true });
    writeFileSync(join(coding, "coding.md"), "# Coding\n\nRules.\n\n- ! MUST test\n", "utf8");
    expect(ruleMapMain(["--project-root", root])).toBe(0);
    expect(existsSync(mdPathOf(root))).toBe(true);
  });
});
