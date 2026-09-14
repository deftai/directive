import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMAND_SNIPPET_CORPUS,
  extractCommandSnippets,
  loadCommandRegistries,
  resolveCommandSnippet,
} from "./live-procedure-targets.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

const BARE_TASK_SCOPE_RECORD = /(?<!deft:)task scope:record-approved-scope/;
const PREAMBLE_ENTRY = {
  path: "content/templates/agent-prompt-preamble.md",
  audience: "consumer" as const,
  defaultClassification: "current" as const,
  failClosed: false,
};

describe("tree-correct consumer task spelling (#4447)", () => {
  it("does not add scope-provenance.md to the #4094 corpus list", () => {
    expect(COMMAND_SNIPPET_CORPUS.map((e) => e.path)).not.toContain(
      "content/docs/scope-provenance.md",
    );
  });

  it("scope-provenance.md prescribes deft primary, not bare task scope:record-approved-scope", () => {
    const text = read("content/docs/scope-provenance.md");
    expect(text).not.toMatch(BARE_TASK_SCOPE_RECORD);
    expect(text).toContain("deft scope:record-approved-scope");
    expect(text).toContain("task deft:scope:record-approved-scope");
  });

  it("preamble happy-path uses deft, not bare task ns:verb", () => {
    const text = read("content/templates/agent-prompt-preamble.md");
    expect(text).toContain("deft scope:promote");
    expect(text).toContain("deft xbrief:activate");
    expect(text).toContain("deft xbrief:preflight");
    expect(text).not.toMatch(/`task scope:promote/);
    expect(text).not.toMatch(/`task xbrief:activate/);
    expect(text).not.toMatch(/`task xbrief:preflight/);
  });

  it("preamble GitHub-body examples resolve on the CLI registry, not deft scm:body", () => {
    const text = read("content/templates/agent-prompt-preamble.md");
    expect(text).not.toContain("deft scm:body");
    expect(text).toContain("deft github-body comment-create");
    expect(text).toContain("deft github-body issue-fetch");
    const registries = loadCommandRegistries(repoRoot);
    const snippets = extractCommandSnippets(
      text,
      "content/templates/agent-prompt-preamble.md",
      PREAMBLE_ENTRY,
    );
    const recut = snippets.filter(
      (s) =>
        s.family === "cli" &&
        (s.verb === "github-body" ||
          s.verb === "scope:promote" ||
          s.verb === "xbrief:activate" ||
          s.verb === "xbrief:preflight" ||
          s.verb === "swarm:finalize-cohort"),
    );
    expect(recut.some((s) => s.verb === "github-body")).toBe(true);
    expect(snippets.some((s) => s.verb.startsWith("scm:body"))).toBe(false);
    for (const snippet of recut) {
      const resolution = resolveCommandSnippet(snippet, registries);
      expect(resolution.kind, `${snippet.raw} L${snippet.line}`).not.toBe("absent");
    }
  });

  it("BROWNFIELD hop-1 keeps the pinned v0.59.0 Taskfile migrator", () => {
    const text = read("content/docs/BROWNFIELD.md");
    expect(text).toContain("task -t /path/to/deft-v0.59.0/Taskfile.yml migrate:vbrief");
    expect(text).not.toContain("deft migrate:vbrief");
    expect(text).toContain("deft migrate:xbrief");
    expect(text).toContain("task deft:migrate:xbrief");
  });

  it("tasks/scope.yml comment examples use deft primary", () => {
    const text = read("tasks/scope.yml");
    expect(text).not.toMatch(/#\s+task scope:record-approved-scope/);
    expect(text).toContain("deft scope:record-approved-scope");
    expect(text).toContain("task deft:scope:record-approved-scope");
    expect(text).toMatch(
      /ENGINE_CMD: 'scope:record-approved-scope \{\{\.CLI_ARGS\}\} --project-root/,
    );
  });

  it("shipped remediations use deft scope:record-approved-scope", () => {
    const evaluate = read("packages/core/src/scope-provenance/evaluate.ts");
    const intent = read("packages/core/src/scope-provenance/intent-evaluate.ts");
    expect(evaluate).not.toMatch(BARE_TASK_SCOPE_RECORD);
    expect(intent).not.toMatch(BARE_TASK_SCOPE_RECORD);
    expect(evaluate).toContain("deft scope:record-approved-scope");
    expect(intent).toContain("deft scope:record-approved-scope");
  });
});
