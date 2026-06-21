import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

describe("test_contracts.py", () => {
  it("refs ./main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("refs ./core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("refs ./coding/coding.md", () => {
    expect(existsSync(join(repoRoot(), "coding/coding.md"))).toBe(true);
  });
  it("refs ./languages/python.md", () => {
    expect(existsSync(join(repoRoot(), "languages/python.md"))).toBe(true);
  });
  it("refs ./languages/go.md", () => {
    expect(existsSync(join(repoRoot(), "languages/go.md"))).toBe(true);
  });
  it("refs ./languages/typescript.md", () => {
    expect(existsSync(join(repoRoot(), "languages/typescript.md"))).toBe(true);
  });
  it("refs ./languages/officejs.md", () => {
    expect(existsSync(join(repoRoot(), "languages/officejs.md"))).toBe(true);
  });
  it("refs ./languages/cpp.md", () => {
    expect(existsSync(join(repoRoot(), "languages/cpp.md"))).toBe(true);
  });
  it("refs ./languages/vba.md", () => {
    expect(existsSync(join(repoRoot(), "languages/vba.md"))).toBe(true);
  });
  it("refs ./vbrief/vbrief.md#project-definitionvbriefjson", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("refs ./interfaces/cli.md", () => {
    expect(existsSync(join(repoRoot(), "interfaces/cli.md"))).toBe(true);
  });
  it("refs ./interfaces/rest.md", () => {
    expect(existsSync(join(repoRoot(), "interfaces/rest.md"))).toBe(true);
  });
  it("refs ./interfaces/tui.md", () => {
    expect(existsSync(join(repoRoot(), "interfaces/tui.md"))).toBe(true);
  });
  it("refs ./interfaces/web.md", () => {
    expect(existsSync(join(repoRoot(), "interfaces/web.md"))).toBe(true);
  });
  it("refs ./deployments/README.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/README.md"))).toBe(true);
  });
  it("refs ./scm/git.md", () => {
    expect(existsSync(join(repoRoot(), "scm/git.md"))).toBe(true);
  });
  it("refs ./scm/github.md", () => {
    expect(existsSync(join(repoRoot(), "scm/github.md"))).toBe(true);
  });
  it("refs ./tools/taskfile.md", () => {
    expect(existsSync(join(repoRoot(), "tools/taskfile.md"))).toBe(true);
  });
  it("refs ./coding/testing.md", () => {
    expect(existsSync(join(repoRoot(), "coding/testing.md"))).toBe(true);
  });
  it("refs ./coding/security.md", () => {
    expect(existsSync(join(repoRoot(), "coding/security.md"))).toBe(true);
  });
  it("refs ./tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("refs ./swarm/swarm.md", () => {
    expect(existsSync(join(repoRoot(), "swarm/swarm.md"))).toBe(true);
  });
  it("refs ./patterns/llm-app.md", () => {
    expect(existsSync(join(repoRoot(), "patterns/llm-app.md"))).toBe(true);
  });
  it("refs ./patterns/role-as-overlay.md", () => {
    expect(existsSync(join(repoRoot(), "patterns/role-as-overlay.md"))).toBe(true);
  });
  it("refs ./patterns/prompt-assembly-layer-ordering.md", () => {
    expect(existsSync(join(repoRoot(), "patterns/prompt-assembly-layer-ordering.md"))).toBe(true);
  });
  it("refs ./context/context.md", () => {
    expect(existsSync(join(repoRoot(), "context/context.md"))).toBe(true);
  });
  it("refs ./context/working-memory.md", () => {
    expect(existsSync(join(repoRoot(), "context/working-memory.md"))).toBe(true);
  });
  it("refs ./context/long-horizon.md", () => {
    expect(existsSync(join(repoRoot(), "context/long-horizon.md"))).toBe(true);
  });
  it("refs ./context/tool-design.md", () => {
    expect(existsSync(join(repoRoot(), "context/tool-design.md"))).toBe(true);
  });
  it("refs ./context/deterministic-split.md", () => {
    expect(existsSync(join(repoRoot(), "context/deterministic-split.md"))).toBe(true);
  });
  it("refs ./context/fractal-summaries.md", () => {
    expect(existsSync(join(repoRoot(), "context/fractal-summaries.md"))).toBe(true);
  });
  it("refs ./context/examples.md", () => {
    expect(existsSync(join(repoRoot(), "context/examples.md"))).toBe(true);
  });
  it("refs ./verification/verification.md", () => {
    expect(existsSync(join(repoRoot(), "verification/verification.md"))).toBe(true);
  });
  it("refs ./verification/uat.md", () => {
    expect(existsSync(join(repoRoot(), "verification/uat.md"))).toBe(true);
  });
  it("refs ./verification/plan-checking.md", () => {
    expect(existsSync(join(repoRoot(), "verification/plan-checking.md"))).toBe(true);
  });
  it("refs ./verification/integration.md", () => {
    expect(existsSync(join(repoRoot(), "verification/integration.md"))).toBe(true);
  });
  it("refs ./resilience/continue-here.md", () => {
    expect(existsSync(join(repoRoot(), "resilience/continue-here.md"))).toBe(true);
  });
  it("refs ./resilience/context-pruning.md", () => {
    expect(existsSync(join(repoRoot(), "resilience/context-pruning.md"))).toBe(true);
  });
  it("refs ./contracts/boundary-maps.md", () => {
    expect(existsSync(join(repoRoot(), "contracts/boundary-maps.md"))).toBe(true);
  });
  it("refs ./strategies/discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("refs ./strategies/map.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/map.md"))).toBe(true);
  });
  it("refs ./strategies/research.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/research.md"))).toBe(true);
  });
  it("refs ./core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("refs ./commands.md", () => {
    expect(existsSync(join(repoRoot(), "commands.md"))).toBe(true);
  });
  it("refs ./history/README.md", () => {
    expect(existsSync(join(repoRoot(), "history/README.md"))).toBe(true);
  });
  it("refs ./context/spec-deltas.md", () => {
    expect(existsSync(join(repoRoot(), "context/spec-deltas.md"))).toBe(true);
  });
  it("refs ./templates/make-spec.md", () => {
    expect(existsSync(join(repoRoot(), "templates/make-spec.md"))).toBe(true);
  });
  it("refs ./vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("refs ./vbrief/schemas/vbrief-core.schema.json", () => {
    expect(existsSync(join(repoRoot(), "vbrief/schemas/vbrief-core.schema.json"))).toBe(true);
  });
  it("refs ./core/ralph.md", () => {
    expect(existsSync(join(repoRoot(), "core/ralph.md"))).toBe(true);
  });
  it("refs ./meta/code-field.md", () => {
    expect(existsSync(join(repoRoot(), "meta/code-field.md"))).toBe(true);
  });
  it("refs ./meta/ideas.md", () => {
    expect(existsSync(join(repoRoot(), "meta/ideas.md"))).toBe(true);
  });
  it("refs ./meta/lessons.md", () => {
    expect(existsSync(join(repoRoot(), "meta/lessons.md"))).toBe(true);
  });
  it("refs ./meta/suggestions.md", () => {
    expect(existsSync(join(repoRoot(), "meta/suggestions.md"))).toBe(true);
  });
  it("strategies/./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/./yolo.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/yolo.md"))).toBe(true);
  });
  it("strategies/./speckit.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/speckit.md"))).toBe(true);
  });
  it("strategies/./map.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/map.md"))).toBe(true);
  });
  it("strategies/./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/./probe.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/probe.md"))).toBe(true);
  });
  it("strategies/./research.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/research.md"))).toBe(true);
  });
  it("strategies/./roadmap.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/roadmap.md"))).toBe(true);
  });
  it("strategies/./bdd.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/bdd.md"))).toBe(true);
  });
  it("strategies/./rapid.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/rapid.md"))).toBe(true);
  });
  it("strategies/./enterprise.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/enterprise.md"))).toBe(true);
  });
  it("strategies/./interview.md#chaining-gate", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/./v0-20-contract.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/v0-20-contract.md"))).toBe(true);
  });
  it("strategies/./v0-20-contract.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/v0-20-contract.md"))).toBe(true);
  });
  it("strategies/../strategies/interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("coding/security.md::coding.md", () => {
    expect(existsSync(join(repoRoot(), "coding/coding.md"))).toBe(true);
  });
  it("coding/security.md::testing.md", () => {
    expect(existsSync(join(repoRoot(), "coding/testing.md"))).toBe(true);
  });
  it("coding/security.md::hygiene.md", () => {
    expect(existsSync(join(repoRoot(), "coding/hygiene.md"))).toBe(true);
  });
  it("coding/security.md::../scm/github.md", () => {
    expect(existsSync(join(repoRoot(), "scm/github.md"))).toBe(true);
  });
  it("coding/security.md::../incidents/README.md", () => {
    expect(existsSync(join(repoRoot(), "incidents/README.md"))).toBe(true);
  });
  it("coding/testing.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("commands.md::./verification/verification.md", () => {
    expect(existsSync(join(repoRoot(), "verification/verification.md"))).toBe(true);
  });
  it("commands.md::./resilience/continue-here.md", () => {
    expect(existsSync(join(repoRoot(), "resilience/continue-here.md"))).toBe(true);
  });
  it("commands.md::./vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("commands.md::./docs/ARCHITECTURE.md", () => {
    expect(existsSync(join(repoRoot(), "docs/ARCHITECTURE.md"))).toBe(true);
  });
  it("context/deterministic-split.md::./tool-design.md", () => {
    expect(existsSync(join(repoRoot(), "context/tool-design.md"))).toBe(true);
  });
  it("context/deterministic-split.md::./context.md", () => {
    expect(existsSync(join(repoRoot(), "context/context.md"))).toBe(true);
  });
  it("context/deterministic-split.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("context/fractal-summaries.md::./context.md", () => {
    expect(existsSync(join(repoRoot(), "context/context.md"))).toBe(true);
  });
  it("context/fractal-summaries.md::../resilience/context-pruning.md", () => {
    expect(existsSync(join(repoRoot(), "resilience/context-pruning.md"))).toBe(true);
  });
  it("context/fractal-summaries.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("context/spec-deltas.md::../commands.md", () => {
    expect(existsSync(join(repoRoot(), "commands.md"))).toBe(true);
  });
  it("context/spec-deltas.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("context/spec-deltas.md::./context.md", () => {
    expect(existsSync(join(repoRoot(), "context/context.md"))).toBe(true);
  });
  it("contracts/boundary-maps.md::../coding/coding.md", () => {
    expect(existsSync(join(repoRoot(), "coding/coding.md"))).toBe(true);
  });
  it("contracts/boundary-maps.md::../verification/verification.md", () => {
    expect(existsSync(join(repoRoot(), "verification/verification.md"))).toBe(true);
  });
  it("contracts/boundary-maps.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("contracts/deterministic-questions.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("contracts/deterministic-questions.md::../glossary.md", () => {
    expect(existsSync(join(repoRoot(), "glossary.md"))).toBe(true);
  });
  it("contracts/deterministic-questions.md::../skills/deft-directive-interview/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-interview/SKILL.md"))).toBe(true);
  });
  it("contracts/deterministic-questions.md::../vbrief/completed/2026-04-20-431-deterministic-questions-rc2-defects.vbrief.json", () => {
    expect(
      existsSync(
        join(
          repoRoot(),
          "vbrief/completed/2026-04-20-431-deterministic-questions-rc2-defects.vbrief.json",
        ),
      ),
    ).toBe(true);
  });
  it("contracts/hierarchy.md::./boundary-maps.md", () => {
    expect(existsSync(join(repoRoot(), "contracts/boundary-maps.md"))).toBe(true);
  });
  it("contracts/hierarchy.md::../coding/coding.md", () => {
    expect(existsSync(join(repoRoot(), "coding/coding.md"))).toBe(true);
  });
  it("contracts/hierarchy.md::../meta/philosophy.md", () => {
    expect(existsSync(join(repoRoot(), "meta/philosophy.md"))).toBe(true);
  });
  it("contracts/hierarchy.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("conventions/references.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("conventions/references.md::../vbrief/schemas/vbrief-core.schema.json", () => {
    expect(existsSync(join(repoRoot(), "vbrief/schemas/vbrief-core.schema.json"))).toBe(true);
  });
  it("conventions/references.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("conventions/task-caching.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("conventions/task-caching.md::../tasks/prd.yml", () => {
    expect(existsSync(join(repoRoot(), "tasks/prd.yml"))).toBe(true);
  });
  it("conventions/task-caching.md::../tasks/scope.yml", () => {
    expect(existsSync(join(repoRoot(), "tasks/scope.yml"))).toBe(true);
  });
  it("conventions/task-caching.md::../tests/content/test_taskfile_caching.py", () => {
    expect(existsSync(join(repoRoot(), "tests/content/test_taskfile_caching.py"))).toBe(true);
  });
  it("conventions/vbrief-filenames.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("conventions/vbrief-filenames.md::./references.md", () => {
    expect(existsSync(join(repoRoot(), "conventions/references.md"))).toBe(true);
  });
  it("conventions/vbrief-filenames.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("core/project.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("core/project.md::../languages/", () => {
    expect(existsSync(join(repoRoot(), "languages"))).toBe(true);
  });
  it("core/versioning.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("core/versioning.md::../scm/git.md", () => {
    expect(existsSync(join(repoRoot(), "scm/git.md"))).toBe(true);
  });
  it("core/versioning.md::../scm/github.md", () => {
    expect(existsSync(join(repoRoot(), "scm/github.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-dashboard.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/README.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-dashboard.md::./via-git.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-git.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-dashboard.md::./via-wrangler.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-wrangler.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-git.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/README.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-git.md::./via-wrangler.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-wrangler.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-git.md::./via-github-actions.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-github-actions.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-github-actions.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/README.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-github-actions.md::./via-wrangler.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-wrangler.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-github-actions.md::./via-git.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-git.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-terraform.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/README.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-terraform.md::./via-wrangler.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-wrangler.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-terraform.md::./via-github-actions.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-github-actions.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-wrangler.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/README.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-wrangler.md::./via-git.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-git.md"))).toBe(true);
  });
  it("deployments/cloudflare/via-wrangler.md::./via-github-actions.md", () => {
    expect(existsSync(join(repoRoot(), "deployments/cloudflare/via-github-actions.md"))).toBe(true);
  });
  it("docs/ARCHITECTURE.md::./CONCEPTS.md", () => {
    expect(existsSync(join(repoRoot(), "docs/CONCEPTS.md"))).toBe(true);
  });
  it("docs/ARCHITECTURE.md::./FILES.md", () => {
    expect(existsSync(join(repoRoot(), "docs/FILES.md"))).toBe(true);
  });
  it("docs/ARCHITECTURE.md::./code-structure-profile.md", () => {
    expect(existsSync(join(repoRoot(), "docs/code-structure-profile.md"))).toBe(true);
  });
  it("docs/ARCHITECTURE.md::./codebase-map-source-of-truth.md", () => {
    expect(existsSync(join(repoRoot(), "docs/codebase-map-source-of-truth.md"))).toBe(true);
  });
  it("docs/ARCHITECTURE.md::../README.md", () => {
    expect(existsSync(join(repoRoot(), "README.md"))).toBe(true);
  });
  it("docs/BROWNFIELD.md::../README.md", () => {
    expect(existsSync(join(repoRoot(), "README.md"))).toBe(true);
  });
  it("docs/BROWNFIELD.md::../QUICK-START.md", () => {
    expect(existsSync(join(repoRoot(), "QUICK-START.md"))).toBe(true);
  });
  it("docs/BROWNFIELD.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("docs/CONCEPTS.md::./ARCHITECTURE.md", () => {
    expect(existsSync(join(repoRoot(), "docs/ARCHITECTURE.md"))).toBe(true);
  });
  it("docs/CONCEPTS.md::./FILES.md", () => {
    expect(existsSync(join(repoRoot(), "docs/FILES.md"))).toBe(true);
  });
  it("docs/CONCEPTS.md::./codebase-map-source-of-truth.md", () => {
    expect(existsSync(join(repoRoot(), "docs/codebase-map-source-of-truth.md"))).toBe(true);
  });
  it("docs/CONCEPTS.md::../README.md", () => {
    expect(existsSync(join(repoRoot(), "README.md"))).toBe(true);
  });
  it("docs/FILES.md::./ARCHITECTURE.md", () => {
    expect(existsSync(join(repoRoot(), "docs/ARCHITECTURE.md"))).toBe(true);
  });
  it("docs/FILES.md::./CONCEPTS.md", () => {
    expect(existsSync(join(repoRoot(), "docs/CONCEPTS.md"))).toBe(true);
  });
  it("docs/FILES.md::./RELEASING.md", () => {
    expect(existsSync(join(repoRoot(), "docs/RELEASING.md"))).toBe(true);
  });
  it("docs/RELEASING.md::./ARCHITECTURE.md", () => {
    expect(existsSync(join(repoRoot(), "docs/ARCHITECTURE.md"))).toBe(true);
  });
  it("docs/RELEASING.md::./CONCEPTS.md", () => {
    expect(existsSync(join(repoRoot(), "docs/CONCEPTS.md"))).toBe(true);
  });
  it("docs/RELEASING.md::./FILES.md", () => {
    expect(existsSync(join(repoRoot(), "docs/FILES.md"))).toBe(true);
  });
  it("docs/RELEASING.md::../README.md", () => {
    expect(existsSync(join(repoRoot(), "README.md"))).toBe(true);
  });
  it("docs/versioning.md::../scm/changelog.md", () => {
    expect(existsSync(join(repoRoot(), "scm/changelog.md"))).toBe(true);
  });
  it("docs/versioning.md::../scm/github.md", () => {
    expect(existsSync(join(repoRoot(), "scm/github.md"))).toBe(true);
  });
  it("docs/versioning.md::../skills/deft-directive-release/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-release/SKILL.md"))).toBe(true);
  });
  it("glossary.md::./vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("glossary.md::./UPGRADING.md", () => {
    expect(existsSync(join(repoRoot(), "UPGRADING.md"))).toBe(true);
  });
  it("glossary.md::./strategies/speckit.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/speckit.md"))).toBe(true);
  });
  it("glossary.md::./core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("interfaces/cli.md::../languages/python.md", () => {
    expect(existsSync(join(repoRoot(), "languages/python.md"))).toBe(true);
  });
  it("interfaces/cli.md::../languages/typescript.md", () => {
    expect(existsSync(join(repoRoot(), "languages/typescript.md"))).toBe(true);
  });
  it("interfaces/cli.md::../interfaces/tui.md", () => {
    expect(existsSync(join(repoRoot(), "interfaces/tui.md"))).toBe(true);
  });
  it("languages/6502-DASM.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/6502-DASM.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/c.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/c.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/c.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/cpp.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/cpp.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/cpp.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/csharp.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/csharp.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/csharp.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/dart.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/dart.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/delphi.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/delphi.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/delphi.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/elixir.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/elixir.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/go.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/go.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/go.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/java.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/java.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/java.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/javascript.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/javascript.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/javascript.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/julia.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/julia.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/kotlin.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/kotlin.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/markdown.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/markdown.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/mermaid.md::./markdown.md", () => {
    expect(existsSync(join(repoRoot(), "languages/markdown.md"))).toBe(true);
  });
  it("languages/mermaid.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/officejs.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/officejs.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/officejs.md::./typescript.md", () => {
    expect(existsSync(join(repoRoot(), "languages/typescript.md"))).toBe(true);
  });
  it("languages/officejs.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/r.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/r.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/rust.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/rust.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/sql.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/sql.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/swift.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/swift.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/swift.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/typescript.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/typescript.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/typescript.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/vba.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/vba.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/vba.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/vhdl.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/vhdl.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/visual-basic.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/visual-basic.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("languages/visual-basic.md::../tools/telemetry.md", () => {
    expect(existsSync(join(repoRoot(), "tools/telemetry.md"))).toBe(true);
  });
  it("languages/zig.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("languages/zig.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("meta/philosophy.md::../contracts/hierarchy.md", () => {
    expect(existsSync(join(repoRoot(), "contracts/hierarchy.md"))).toBe(true);
  });
  it("meta/philosophy.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("platforms/2600.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("platforms/2600.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("platforms/unity.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("platforms/unity.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("platforms/unity.md::../languages/csharp.md", () => {
    expect(existsSync(join(repoRoot(), "languages/csharp.md"))).toBe(true);
  });
  it("references/composer-skill-porting.md::../skills/deft-directive-write-skill/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-write-skill/SKILL.md"))).toBe(true);
  });
  it("references/composer-skill-porting.md::../scm/github.md", () => {
    expect(existsSync(join(repoRoot(), "scm/github.md"))).toBe(true);
  });
  it("references/ip-risk.md::../skills/deft-directive-interview/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-interview/SKILL.md"))).toBe(true);
  });
  it("references/ip-risk.md::../strategies/research.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/research.md"))).toBe(true);
  });
  it("references/ip-risk.md::../scripts/ip_risk.py", () => {
    expect(existsSync(join(repoRoot(), "scripts/ip_risk.py"))).toBe(true);
  });
  it("references/plain-english-ux.md::../skills/deft-directive-interview/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-interview/SKILL.md"))).toBe(true);
  });
  it("references/plain-english-ux.md::../strategies/interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("resilience/context-pruning.md::../context/context.md", () => {
    expect(existsSync(join(repoRoot(), "context/context.md"))).toBe(true);
  });
  it("resilience/context-pruning.md::../context/fractal-summaries.md", () => {
    expect(existsSync(join(repoRoot(), "context/fractal-summaries.md"))).toBe(true);
  });
  it("resilience/context-pruning.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("resilience/continue-here.md::../context/long-horizon.md", () => {
    expect(existsSync(join(repoRoot(), "context/long-horizon.md"))).toBe(true);
  });
  it("resilience/continue-here.md::./context-pruning.md", () => {
    expect(existsSync(join(repoRoot(), "resilience/context-pruning.md"))).toBe(true);
  });
  it("resilience/continue-here.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("scm/changelog.md::./git.md", () => {
    expect(existsSync(join(repoRoot(), "scm/git.md"))).toBe(true);
  });
  it("scm/changelog.md::./github.md", () => {
    expect(existsSync(join(repoRoot(), "scm/github.md"))).toBe(true);
  });
  it("scm/changelog.md::../core/versioning.md", () => {
    expect(existsSync(join(repoRoot(), "core/versioning.md"))).toBe(true);
  });
  it("scm/git.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("scm/git.md::../PROJECT.md", () => {
    expect(existsSync(join(repoRoot(), "PROJECT.md"))).toBe(true);
  });
  it("scm/git.md::../scm/github.md", () => {
    expect(existsSync(join(repoRoot(), "scm/github.md"))).toBe(true);
  });
  it("scm/github.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("scm/github.md::./git.md", () => {
    expect(existsSync(join(repoRoot(), "scm/git.md"))).toBe(true);
  });
  it("scm/github.md::./changelog.md", () => {
    expect(existsSync(join(repoRoot(), "scm/changelog.md"))).toBe(true);
  });
  it("skills/deft-directive-decompose/SKILL.md::../../strategies/speckit.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/speckit.md"))).toBe(true);
  });
  it("skills/deft-directive-decompose/SKILL.md::../../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("skills/deft-directive-decompose/SKILL.md::../deft-directive-swarm/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-swarm/SKILL.md"))).toBe(true);
  });
  it("skills/deft-directive-pre-pr/SKILL.md::../deft-directive-review-cycle/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-review-cycle/SKILL.md"))).toBe(true);
  });
  it("skills/deft-directive-pre-pr/SKILL.md::../deft-directive-build/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-build/SKILL.md"))).toBe(true);
  });
  it("skills/deft-directive-pre-pr/SKILL.md::../../tools/RWLDL.md", () => {
    expect(existsSync(join(repoRoot(), "tools/RWLDL.md"))).toBe(true);
  });
  it("skills/deft-directive-refinement/SKILL.md::../../contracts/deterministic-questions.md", () => {
    expect(existsSync(join(repoRoot(), "contracts/deterministic-questions.md"))).toBe(true);
  });
  it("skills/deft-directive-release/SKILL.md::../deft-directive-swarm/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-swarm/SKILL.md"))).toBe(true);
  });
  it("skills/deft-directive-release/SKILL.md::../deft-directive-review-cycle/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-review-cycle/SKILL.md"))).toBe(true);
  });
  it("skills/deft-directive-release/SKILL.md::../deft-directive-refinement/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-refinement/SKILL.md"))).toBe(true);
  });
  it("skills/deft-directive-swarm/SKILL.md::../../swarm/swarm.md", () => {
    expect(existsSync(join(repoRoot(), "swarm/swarm.md"))).toBe(true);
  });
  it("skills/deft-directive-swarm/SKILL.md::../deft-directive-review-cycle/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-review-cycle/SKILL.md"))).toBe(true);
  });
  it("strategies/artifact-guards.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("strategies/artifact-guards.md::./v0-20-contract.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/v0-20-contract.md"))).toBe(true);
  });
  it("strategies/artifact-guards.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/bdd.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/bdd.md::./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/bdd.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("strategies/discuss.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/discuss.md::./speckit.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/speckit.md"))).toBe(true);
  });
  it("strategies/discuss.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("strategies/emit-hints.md::./artifact-guards.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/artifact-guards.md"))).toBe(true);
  });
  it("strategies/emit-hints.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("strategies/emit-hints.md::./v0-20-contract.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/v0-20-contract.md"))).toBe(true);
  });
  it("strategies/enterprise.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/enterprise.md::./speckit.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/speckit.md"))).toBe(true);
  });
  it("strategies/enterprise.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/README.md"))).toBe(true);
  });
  it("strategies/enterprise.md::./v0-20-contract.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/v0-20-contract.md"))).toBe(true);
  });
  it("strategies/enterprise.md::./artifact-guards.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/artifact-guards.md"))).toBe(true);
  });
  it("strategies/interview.md::./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/interview.md::./yolo.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/yolo.md"))).toBe(true);
  });
  it("strategies/interview.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("strategies/map.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/map.md::./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/map.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("strategies/probe.md::./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/probe.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/probe.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("strategies/rapid.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/rapid.md::./yolo.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/yolo.md"))).toBe(true);
  });
  it("strategies/rapid.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/README.md"))).toBe(true);
  });
  it("strategies/rapid.md::./v0-20-contract.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/v0-20-contract.md"))).toBe(true);
  });
  it("strategies/rapid.md::./artifact-guards.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/artifact-guards.md"))).toBe(true);
  });
  it("strategies/research.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/research.md::./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/research.md::./map.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/map.md"))).toBe(true);
  });
  it("strategies/speckit.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/speckit.md::./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/speckit.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("strategies/speckit.md::./v0-20-contract.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/v0-20-contract.md"))).toBe(true);
  });
  it("strategies/speckit.md::./artifact-guards.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/artifact-guards.md"))).toBe(true);
  });
  it("strategies/speckit.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("strategies/v0-20-contract.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("strategies/v0-20-contract.md::./README.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/README.md"))).toBe(true);
  });
  it("strategies/v0-20-contract.md::./artifact-guards.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/artifact-guards.md"))).toBe(true);
  });
  it("strategies/v0-20-contract.md::../skills/deft-directive-build/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-build/SKILL.md"))).toBe(true);
  });
  it("strategies/v0-20-contract.md::../scripts/migrate_vbrief.py", () => {
    expect(existsSync(join(repoRoot(), "scripts/migrate_vbrief.py"))).toBe(true);
  });
  it("strategies/v0-20-contract.md::../conventions/machine-generated-banner.md", () => {
    expect(existsSync(join(repoRoot(), "conventions/machine-generated-banner.md"))).toBe(true);
  });
  it("strategies/yolo.md::./interview.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/interview.md"))).toBe(true);
  });
  it("strategies/yolo.md::./discuss.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/discuss.md"))).toBe(true);
  });
  it("strategies/yolo.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("strategies/yolo.md::../vbrief/vbrief.md", () => {
    expect(existsSync(join(repoRoot(), "vbrief/vbrief.md"))).toBe(true);
  });
  it("strategies/yolo.md::./artifact-guards.md", () => {
    expect(existsSync(join(repoRoot(), "strategies/artifact-guards.md"))).toBe(true);
  });
  it("swarm/swarm.md::../coding/coding.md", () => {
    expect(existsSync(join(repoRoot(), "coding/coding.md"))).toBe(true);
  });
  it("swarm/swarm.md::../tools/taskfile.md", () => {
    expect(existsSync(join(repoRoot(), "tools/taskfile.md"))).toBe(true);
  });
  it("swarm/swarm.md::../scm/git.md", () => {
    expect(existsSync(join(repoRoot(), "scm/git.md"))).toBe(true);
  });
  it("swarm/swarm.md::../meta/security.md", () => {
    expect(existsSync(join(repoRoot(), "meta/security.md"))).toBe(true);
  });
  it("tools/RWLDL.md::./taskfile.md", () => {
    expect(existsSync(join(repoRoot(), "tools/taskfile.md"))).toBe(true);
  });
  it("tools/RWLDL.md::../coding/coding.md", () => {
    expect(existsSync(join(repoRoot(), "coding/coding.md"))).toBe(true);
  });
  it("tools/RWLDL.md::../coding/testing.md", () => {
    expect(existsSync(join(repoRoot(), "coding/testing.md"))).toBe(true);
  });
  it("tools/greptile.md::../skills/deft-directive-review-cycle/SKILL.md", () => {
    expect(existsSync(join(repoRoot(), "skills/deft-directive-review-cycle/SKILL.md"))).toBe(true);
  });
  it("tools/taskfile-migration.md::./taskfile.md", () => {
    expect(existsSync(join(repoRoot(), "tools/taskfile.md"))).toBe(true);
  });
  it("tools/taskfile-migration.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("tools/taskfile.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("tools/taskfile.md::./taskfile-migration.md", () => {
    expect(existsSync(join(repoRoot(), "tools/taskfile-migration.md"))).toBe(true);
  });
  it("tools/telemetry.md::../main.md", () => {
    expect(existsSync(join(repoRoot(), "main.md"))).toBe(true);
  });
  it("tools/telemetry.md::../coding/coding.md", () => {
    expect(existsSync(join(repoRoot(), "coding/coding.md"))).toBe(true);
  });
  it("vbrief/vbrief.md::../context/working-memory.md", () => {
    expect(existsSync(join(repoRoot(), "context/working-memory.md"))).toBe(true);
  });
  it("vbrief/vbrief.md::../resilience/continue-here.md", () => {
    expect(existsSync(join(repoRoot(), "resilience/continue-here.md"))).toBe(true);
  });
  it("vbrief/vbrief.md::../context/long-horizon.md", () => {
    expect(existsSync(join(repoRoot(), "context/long-horizon.md"))).toBe(true);
  });
  it("vbrief/vbrief.md::../glossary.md", () => {
    expect(existsSync(join(repoRoot(), "glossary.md"))).toBe(true);
  });
  it("verification/integration.md::./verification.md", () => {
    expect(existsSync(join(repoRoot(), "verification/verification.md"))).toBe(true);
  });
  it("verification/integration.md::../contracts/boundary-maps.md", () => {
    expect(existsSync(join(repoRoot(), "contracts/boundary-maps.md"))).toBe(true);
  });
  it("verification/integration.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("verification/plan-checking.md::./verification.md", () => {
    expect(existsSync(join(repoRoot(), "verification/verification.md"))).toBe(true);
  });
  it("verification/plan-checking.md::../contracts/boundary-maps.md", () => {
    expect(existsSync(join(repoRoot(), "contracts/boundary-maps.md"))).toBe(true);
  });
  it("verification/plan-checking.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("verification/uat.md::./verification.md", () => {
    expect(existsSync(join(repoRoot(), "verification/verification.md"))).toBe(true);
  });
  it("verification/uat.md::../coding/testing.md", () => {
    expect(existsSync(join(repoRoot(), "coding/testing.md"))).toBe(true);
  });
  it("verification/uat.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("verification/verification.md::../coding/testing.md", () => {
    expect(existsSync(join(repoRoot(), "coding/testing.md"))).toBe(true);
  });
  it("verification/verification.md::./uat.md", () => {
    expect(existsSync(join(repoRoot(), "verification/uat.md"))).toBe(true);
  });
  it("verification/verification.md::../core/glossary.md", () => {
    expect(existsSync(join(repoRoot(), "core/glossary.md"))).toBe(true);
  });
  it("discuss in strategy index", () => {
    expect(readText("strategies/README.md")).toContain("discuss.md");
  });
});
