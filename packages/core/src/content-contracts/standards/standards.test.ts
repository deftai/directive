import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_standards.py", () => {
  it("languages/6502-DASM.md", () => {
    expect(readText("languages/6502-DASM.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/c.md", () => {
    expect(readText("languages/c.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/commands.md", () => {
    expect(readText("languages/commands.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/cpp.md", () => {
    expect(readText("languages/cpp.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/csharp.md", () => {
    expect(readText("languages/csharp.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/dart.md", () => {
    expect(readText("languages/dart.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/delphi.md", () => {
    expect(readText("languages/delphi.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/elixir.md", () => {
    expect(readText("languages/elixir.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/go.md", () => {
    expect(readText("languages/go.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/java.md", () => {
    expect(readText("languages/java.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/javascript.md", () => {
    expect(readText("languages/javascript.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/julia.md", () => {
    expect(readText("languages/julia.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/kotlin.md", () => {
    expect(readText("languages/kotlin.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/markdown.md", () => {
    expect(readText("languages/markdown.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/mermaid.md", () => {
    expect(readText("languages/mermaid.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/officejs.md", () => {
    expect(readText("languages/officejs.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/python.md", () => {
    expect(readText("languages/python.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/r.md", () => {
    expect(readText("languages/r.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/rust.md", () => {
    expect(readText("languages/rust.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/sql.md", () => {
    expect(readText("languages/sql.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/swift.md", () => {
    expect(readText("languages/swift.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/typescript.md", () => {
    expect(readText("languages/typescript.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/vba.md", () => {
    expect(readText("languages/vba.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/vhdl.md", () => {
    expect(readText("languages/vhdl.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/visual-basic.md", () => {
    expect(readText("languages/visual-basic.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("languages/zig.md", () => {
    expect(readText("languages/zig.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("interfaces/cli.md", () => {
    expect(readText("interfaces/cli.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("interfaces/rest.md", () => {
    expect(readText("interfaces/rest.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("interfaces/tui.md", () => {
    expect(readText("interfaces/tui.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("interfaces/web.md", () => {
    expect(readText("interfaces/web.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("tools/RWLDL.md", () => {
    expect(readText("tools/RWLDL.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("tools/greptile.md", () => {
    expect(readText("tools/greptile.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("tools/installer.md", () => {
    expect(readText("tools/installer.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("tools/taskfile-migration.md", () => {
    expect(readText("tools/taskfile-migration.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("tools/taskfile.md", () => {
    expect(readText("tools/taskfile.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("tools/telemetry.md", () => {
    expect(readText("tools/telemetry.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/artifact-guards.md", () => {
    expect(readText("strategies/artifact-guards.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/bdd.md", () => {
    expect(readText("strategies/bdd.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/discuss.md", () => {
    expect(readText("strategies/discuss.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/emit-hints.md", () => {
    expect(readText("strategies/emit-hints.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/enterprise.md", () => {
    expect(readText("strategies/enterprise.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/interview.md", () => {
    expect(readText("strategies/interview.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/map.md", () => {
    expect(readText("strategies/map.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/probe.md", () => {
    expect(readText("strategies/probe.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/rapid.md", () => {
    expect(readText("strategies/rapid.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/research.md", () => {
    expect(readText("strategies/research.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/speckit.md", () => {
    expect(readText("strategies/speckit.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/v0-20-contract.md", () => {
    expect(readText("strategies/v0-20-contract.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("strategies/yolo.md", () => {
    expect(readText("strategies/yolo.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/context.md", () => {
    expect(readText("context/context.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/deterministic-split.md", () => {
    expect(readText("context/deterministic-split.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/examples.md", () => {
    expect(readText("context/examples.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/fractal-summaries.md", () => {
    expect(readText("context/fractal-summaries.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/long-horizon.md", () => {
    expect(readText("context/long-horizon.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/spec-deltas.md", () => {
    expect(readText("context/spec-deltas.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/tool-design.md", () => {
    expect(readText("context/tool-design.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("context/working-memory.md", () => {
    expect(readText("context/working-memory.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("vbrief/vbrief.md", () => {
    expect(readText("vbrief/vbrief.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("verification/integration.md", () => {
    expect(readText("verification/integration.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("verification/plan-checking.md", () => {
    expect(readText("verification/plan-checking.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("verification/uat.md", () => {
    expect(readText("verification/uat.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("verification/verification.md", () => {
    expect(readText("verification/verification.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("resilience/context-pruning.md", () => {
    expect(readText("resilience/context-pruning.md")).toContain("!=MUST, ~=SHOULD");
  });
  it("resilience/continue-here.md", () => {
    expect(readText("resilience/continue-here.md")).toContain("!=MUST, ~=SHOULD");
  });
  it(".agents/skills/deft/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft/SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it(".agents/skills/deft-directive-article-review/SKILL.md no deprecated user path", () => {
    expect(
      readText(".agents/skills/deft-directive-article-review/SKILL.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it(".agents/skills/deft-directive-build/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-build/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-cost/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-cost/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-debug/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-debug/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-gh-arch/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-gh-arch/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-gh-slice/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-gh-slice/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-glossary/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-glossary/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-interview/SKILL.md no deprecated user path", () => {
    expect(
      readText(".agents/skills/deft-directive-interview/SKILL.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it(".agents/skills/deft-directive-pre-pr/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-pre-pr/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-refinement/SKILL.md no deprecated user path", () => {
    expect(
      readText(".agents/skills/deft-directive-refinement/SKILL.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it(".agents/skills/deft-directive-release/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-release/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-review-cycle/SKILL.md no deprecated user path", () => {
    expect(
      readText(".agents/skills/deft-directive-review-cycle/SKILL.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it(".agents/skills/deft-directive-setup/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-setup/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-swarm/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-swarm/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-sync/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-sync/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-triage/SKILL.md no deprecated user path", () => {
    expect(readText(".agents/skills/deft-directive-triage/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".agents/skills/deft-directive-write-skill/SKILL.md no deprecated user path", () => {
    expect(
      readText(".agents/skills/deft-directive-write-skill/SKILL.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it(".github/PULL_REQUEST_TEMPLATE.md no deprecated user path", () => {
    expect(readText(".github/PULL_REQUEST_TEMPLATE.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".github/release-notes/upgrade-banner.md no deprecated user path", () => {
    expect(readText(".github/release-notes/upgrade-banner.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".planning/codebase/ARCHITECTURE.md no deprecated user path", () => {
    expect(readText(".planning/codebase/ARCHITECTURE.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".planning/codebase/CONVENTIONS.md no deprecated user path", () => {
    expect(readText(".planning/codebase/CONVENTIONS.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it(".planning/codebase/STACK.md no deprecated user path", () => {
    expect(readText(".planning/codebase/STACK.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("AGENTS.md no deprecated user path", () => {
    expect(readText("AGENTS.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("CONTRIBUTING.md no deprecated user path", () => {
    expect(readText("CONTRIBUTING.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("LICENSE.md no deprecated user path", () => {
    expect(readText("LICENSE.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("PROJECT.md no deprecated user path", () => {
    expect(readText("PROJECT.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("QUICK-START.md no deprecated user path", () => {
    expect(readText("QUICK-START.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("README.md no deprecated user path", () => {
    expect(readText("README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("REFERENCES.md no deprecated user path", () => {
    expect(readText("REFERENCES.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("ROADMAP.md no deprecated user path", () => {
    expect(readText("ROADMAP.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("SKILL.md no deprecated user path", () => {
    expect(readText("SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("UPGRADING.md no deprecated user path", () => {
    expect(readText("UPGRADING.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/build-output.md no deprecated user path", () => {
    expect(readText("coding/build-output.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/coding.md no deprecated user path", () => {
    expect(readText("coding/coding.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/debugging.md no deprecated user path", () => {
    expect(readText("coding/debugging.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/holzmann.md no deprecated user path", () => {
    expect(readText("coding/holzmann.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/hygiene.md no deprecated user path", () => {
    expect(readText("coding/hygiene.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/security.md no deprecated user path", () => {
    expect(readText("coding/security.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/testing.md no deprecated user path", () => {
    expect(readText("coding/testing.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("coding/toolchain.md no deprecated user path", () => {
    expect(readText("coding/toolchain.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("commands.md no deprecated user path", () => {
    expect(readText("commands.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/context.md no deprecated user path", () => {
    expect(readText("context/context.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/deterministic-split.md no deprecated user path", () => {
    expect(readText("context/deterministic-split.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/examples.md no deprecated user path", () => {
    expect(readText("context/examples.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/fractal-summaries.md no deprecated user path", () => {
    expect(readText("context/fractal-summaries.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/long-horizon.md no deprecated user path", () => {
    expect(readText("context/long-horizon.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/spec-deltas.md no deprecated user path", () => {
    expect(readText("context/spec-deltas.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/tool-design.md no deprecated user path", () => {
    expect(readText("context/tool-design.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("context/working-memory.md no deprecated user path", () => {
    expect(readText("context/working-memory.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("contracts/boundary-maps.md no deprecated user path", () => {
    expect(readText("contracts/boundary-maps.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("contracts/deterministic-questions.md no deprecated user path", () => {
    expect(readText("contracts/deterministic-questions.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("contracts/hierarchy.md no deprecated user path", () => {
    expect(readText("contracts/hierarchy.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("conventions/machine-generated-banner.md no deprecated user path", () => {
    expect(readText("conventions/machine-generated-banner.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("conventions/references.md no deprecated user path", () => {
    expect(readText("conventions/references.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("conventions/task-caching.md no deprecated user path", () => {
    expect(readText("conventions/task-caching.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("conventions/vbrief-filenames.md no deprecated user path", () => {
    expect(readText("conventions/vbrief-filenames.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("core/glossary.md no deprecated user path", () => {
    expect(readText("glossary.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("core/project.md no deprecated user path", () => {
    expect(readText("meta/project.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("core/ralph.md no deprecated user path", () => {
    expect(readText("meta/ralph.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("core/versioning.md no deprecated user path", () => {
    expect(readText("meta/versioning.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/README.md no deprecated user path", () => {
    expect(readText("deployments/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/agentuity/README.md no deprecated user path", () => {
    expect(readText("deployments/agentuity/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/agentuity/via-cli.md no deprecated user path", () => {
    expect(readText("deployments/agentuity/via-cli.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/agentuity/via-cloud.md no deprecated user path", () => {
    expect(readText("deployments/agentuity/via-cloud.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/agentuity/via-github-actions.md no deprecated user path", () => {
    expect(readText("deployments/agentuity/via-github-actions.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/agentuity/via-gravity-network.md no deprecated user path", () => {
    expect(readText("deployments/agentuity/via-gravity-network.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/agentuity/via-vpc.md no deprecated user path", () => {
    expect(readText("deployments/agentuity/via-vpc.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/aws/README.md no deprecated user path", () => {
    expect(readText("deployments/aws/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/aws/via-app-runner.md no deprecated user path", () => {
    expect(readText("deployments/aws/via-app-runner.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/aws/via-ecs-fargate.md no deprecated user path", () => {
    expect(readText("deployments/aws/via-ecs-fargate.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/aws/via-elastic-beanstalk.md no deprecated user path", () => {
    expect(readText("deployments/aws/via-elastic-beanstalk.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/aws/via-lambda.md no deprecated user path", () => {
    expect(readText("deployments/aws/via-lambda.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/azure/README.md no deprecated user path", () => {
    expect(readText("deployments/azure/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/azure/via-aks.md no deprecated user path", () => {
    expect(readText("deployments/azure/via-aks.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/azure/via-app-service.md no deprecated user path", () => {
    expect(readText("deployments/azure/via-app-service.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/azure/via-container-apps.md no deprecated user path", () => {
    expect(readText("deployments/azure/via-container-apps.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/azure/via-functions.md no deprecated user path", () => {
    expect(readText("deployments/azure/via-functions.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/README.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/cloud-gov/agents/compliance-docs.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/agents/compliance-docs.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/agents.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/agents.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/cloud-gov/cicd.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/cicd.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/cloud-gov/deployment.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/deployment.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/logging.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/logging.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/manifest.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/manifest.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/overview.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/overview.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/security.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/security.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/services.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/services.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloud-gov/upstream/README.md no deprecated user path", () => {
    expect(readText("deployments/cloud-gov/upstream/README.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloudflare/README.md no deprecated user path", () => {
    expect(readText("deployments/cloudflare/README.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloudflare/via-dashboard.md no deprecated user path", () => {
    expect(readText("deployments/cloudflare/via-dashboard.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloudflare/via-git.md no deprecated user path", () => {
    expect(readText("deployments/cloudflare/via-git.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloudflare/via-github-actions.md no deprecated user path", () => {
    expect(readText("deployments/cloudflare/via-github-actions.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloudflare/via-terraform.md no deprecated user path", () => {
    expect(readText("deployments/cloudflare/via-terraform.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/cloudflare/via-wrangler.md no deprecated user path", () => {
    expect(readText("deployments/cloudflare/via-wrangler.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/fly-io/README.md no deprecated user path", () => {
    expect(readText("deployments/fly-io/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/fly-io/via-dockerfile.md no deprecated user path", () => {
    expect(readText("deployments/fly-io/via-dockerfile.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/fly-io/via-flyctl.md no deprecated user path", () => {
    expect(readText("deployments/fly-io/via-flyctl.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/fly-io/via-github-actions.md no deprecated user path", () => {
    expect(readText("deployments/fly-io/via-github-actions.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/fly-io/via-multi-region.md no deprecated user path", () => {
    expect(readText("deployments/fly-io/via-multi-region.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/google/README.md no deprecated user path", () => {
    expect(readText("deployments/google/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/google/via-app-engine.md no deprecated user path", () => {
    expect(readText("deployments/google/via-app-engine.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/google/via-cloud-functions.md no deprecated user path", () => {
    expect(readText("deployments/google/via-cloud-functions.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/google/via-cloud-run.md no deprecated user path", () => {
    expect(readText("deployments/google/via-cloud-run.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/google/via-gke.md no deprecated user path", () => {
    expect(readText("deployments/google/via-gke.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/netlify/README.md no deprecated user path", () => {
    expect(readText("deployments/netlify/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/netlify/via-cli.md no deprecated user path", () => {
    expect(readText("deployments/netlify/via-cli.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/netlify/via-functions.md no deprecated user path", () => {
    expect(readText("deployments/netlify/via-functions.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("deployments/netlify/via-git.md no deprecated user path", () => {
    expect(readText("deployments/netlify/via-git.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/vercel/README.md no deprecated user path", () => {
    expect(readText("deployments/vercel/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/vercel/via-api.md no deprecated user path", () => {
    expect(readText("deployments/vercel/via-api.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/vercel/via-cli.md no deprecated user path", () => {
    expect(readText("deployments/vercel/via-cli.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("deployments/vercel/via-git.md no deprecated user path", () => {
    expect(readText("deployments/vercel/via-git.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/ARCHITECTURE.md no deprecated user path", () => {
    expect(readText("docs/ARCHITECTURE.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/BROWNFIELD.md no deprecated user path", () => {
    expect(readText("docs/BROWNFIELD.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/CONCEPTS.md no deprecated user path", () => {
    expect(readText("docs/CONCEPTS.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/FILES.md no deprecated user path", () => {
    expect(readText("docs/FILES.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/RELEASING.md no deprecated user path", () => {
    expect(readText("docs/RELEASING.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/agent-stuck-in-a-loop.md no deprecated user path", () => {
    expect(readText("docs/agent-stuck-in-a-loop.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/agents-md-vs-skill-md.md no deprecated user path", () => {
    expect(readText("docs/agents-md-vs-skill-md.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/ai-agent-teaming.md no deprecated user path", () => {
    expect(readText("docs/ai-agent-teaming.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/ai-coding-trust-paradox.md no deprecated user path", () => {
    expect(readText("docs/ai-coding-trust-paradox.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md no deprecated user path", () => {
    expect(
      readText(
        "docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/analysis/2026-06-12-lifecycle-taskfile-exit-smoke.md no deprecated user path", () => {
    expect(
      readText("docs/analysis/2026-06-12-lifecycle-taskfile-exit-smoke.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/analysis/2026-06-19-sign-off-layer-consumer-value.md no deprecated user path", () => {
    expect(
      readText("docs/analysis/2026-06-19-sign-off-layer-consumer-value.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/article-review-2026-05-01-03.md no deprecated user path", () => {
    expect(readText("docs/article-review-2026-05-01-03.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/audit-2026-05-10-installer-conformance.md no deprecated user path", () => {
    expect(readText("docs/audit-2026-05-10-installer-conformance.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/audit-2026-05-11-installer-conformance-recheck.md no deprecated user path", () => {
    expect(
      readText("docs/audit-2026-05-11-installer-conformance-recheck.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/claude-code-integration.md no deprecated user path", () => {
    expect(readText("docs/claude-code-integration.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/code-structure-profile.md no deprecated user path", () => {
    expect(readText("docs/code-structure-profile.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/codebase-map-source-of-truth.md no deprecated user path", () => {
    expect(readText("docs/codebase-map-source-of-truth.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/decisions/ADR-001.md no deprecated user path", () => {
    expect(readText("docs/decisions/ADR-001.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/design-deft-cache-quarantine.md no deprecated user path", () => {
    expect(readText("docs/design-deft-cache-quarantine.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/example-project-definition.md no deprecated user path", () => {
    expect(readText("docs/example-project-definition.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/getting-started.md no deprecated user path", () => {
    expect(readText("docs/getting-started.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/gitcrawl-fallback.md no deprecated user path", () => {
    expect(readText("docs/gitcrawl-fallback.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/good-agents-md.md no deprecated user path", () => {
    expect(readText("docs/good-agents-md.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/harness-is-everything-deft-plan.md no deprecated user path", () => {
    expect(readText("docs/harness-is-everything-deft-plan.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/install-manifest.md no deprecated user path", () => {
    expect(readText("docs/install-manifest.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/privacy-nfr.md no deprecated user path", () => {
    expect(readText("docs/privacy-nfr.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/quarantine-spec.md no deprecated user path", () => {
    expect(readText("docs/quarantine-spec.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/refactoring-guidelines.md no deprecated user path", () => {
    expect(readText("docs/refactoring-guidelines.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/README.md no deprecated user path", () => {
    expect(readText("docs/reference/forensic-research/README.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/reference/forensic-research/SKILL.md no deprecated user path", () => {
    expect(readText("docs/reference/forensic-research/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/reference/forensic-research/VENDORED.md no deprecated user path", () => {
    expect(readText("docs/reference/forensic-research/VENDORED.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/reference/forensic-research/examples/slizard/code-facts.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/examples/slizard/code-facts.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/examples/slizard/failures.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/examples/slizard/failures.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/examples/slizard/investigate-production.md no deprecated user path", () => {
    expect(
      readText(
        "docs/reference/forensic-research/examples/slizard/investigate-production.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/examples/slizard/slizard-production.md no deprecated user path", () => {
    expect(
      readText(
        "docs/reference/forensic-research/examples/slizard/slizard-production.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/domains/TEMPLATE.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/domains/TEMPLATE.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/domains/code-debug.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/domains/code-debug.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/failures.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/failures.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/follow-ups.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/follow-ups.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/forensic-mode.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/forensic-mode.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/investigation-profile.md no deprecated user path", () => {
    expect(
      readText(
        "docs/reference/forensic-research/references/investigation-profile.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/orchestrator-protocol.md no deprecated user path", () => {
    expect(
      readText(
        "docs/reference/forensic-research/references/orchestrator-protocol.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/outcome-template.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/outcome-template.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/question-framing.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/question-framing.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/reference/forensic-research/references/subagent-prompts.md no deprecated user path", () => {
    expect(
      readText("docs/reference/forensic-research/references/subagent-prompts.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/research/deft-directive-research.md no deprecated user path", () => {
    expect(readText("docs/research/deft-directive-research.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/security.md no deprecated user path", () => {
    expect(readText("docs/security.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/smoke-2026-05-06-v0.26.0-scale.md no deprecated user path", () => {
    expect(readText("docs/smoke-2026-05-06-v0.26.0-scale.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/smoke-2026-05-07-v0.26.0-rerun.md no deprecated user path", () => {
    expect(readText("docs/smoke-2026-05-07-v0.26.0-rerun.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/smoke-2026-05-10-v0.27.1-relocator-dogfood.md no deprecated user path", () => {
    expect(
      readText("docs/smoke-2026-05-10-v0.27.1-relocator-dogfood.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("docs/subagent-heartbeat.md no deprecated user path", () => {
    expect(readText("docs/subagent-heartbeat.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/superpowers.md no deprecated user path", () => {
    expect(readText("docs/superpowers.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/system-of-record-gate.md no deprecated user path", () => {
    expect(readText("docs/system-of-record-gate.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/the-harness-is-everything.md no deprecated user path", () => {
    expect(readText("docs/the-harness-is-everything.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/thousand-skills.md no deprecated user path", () => {
    expect(readText("docs/thousand-skills.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("docs/valuable-go-task-improvements.md no deprecated user path", () => {
    expect(readText("docs/valuable-go-task-improvements.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("docs/versioning.md no deprecated user path", () => {
    expect(readText("docs/versioning.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("events/README.md no deprecated user path", () => {
    expect(readText("events/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("glossary.md no deprecated user path", () => {
    expect(readText("glossary.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("history/README.md no deprecated user path", () => {
    expect(readText("history/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("history/analysis-2026-03-22-issue-chain-68-94.md no deprecated user path", () => {
    expect(
      readText("history/analysis-2026-03-22-issue-chain-68-94.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/archive/2026-03-20-agent-auto-alignment/design.md no deprecated user path", () => {
    expect(
      readText("history/archive/2026-03-20-agent-auto-alignment/design.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/archive/2026-03-20-agent-auto-alignment/proposal.md no deprecated user path", () => {
    expect(
      readText("history/archive/2026-03-20-agent-auto-alignment/proposal.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/archive/2026-03-20-agents-md-onboarding/design.md no deprecated user path", () => {
    expect(
      readText("history/archive/2026-03-20-agents-md-onboarding/design.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/archive/2026-03-20-agents-md-onboarding/proposal.md no deprecated user path", () => {
    expect(
      readText("history/archive/2026-03-20-agents-md-onboarding/proposal.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/changes/README.md no deprecated user path", () => {
    expect(readText("history/changes/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("history/changes/fix-171-175-commit-gate-and-review-cycle-discipline/CHANGE.md no deprecated user path", () => {
    expect(
      readText(
        "history/changes/fix-171-175-commit-gate-and-review-cycle-discipline/CHANGE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/changes/fix-172-oz-agent-run-correction/CHANGE.md no deprecated user path", () => {
    expect(
      readText("history/changes/fix-172-oz-agent-run-correction/CHANGE.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/implementation-2026-03-13-fix-interview-strategy.md no deprecated user path", () => {
    expect(
      readText("history/implementation-2026-03-13-fix-interview-strategy.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-03-11-cross-platform-agent-skills.md no deprecated user path", () => {
    expect(
      readText("history/plan-2026-03-11-cross-platform-agent-skills.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-03-12-cross-platform-agent-skills-impl.md no deprecated user path", () => {
    expect(
      readText("history/plan-2026-03-12-cross-platform-agent-skills-impl.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-03-12-go-installer-impl.md no deprecated user path", () => {
    expect(readText("history/plan-2026-03-12-go-installer-impl.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("history/plan-2026-03-12-single-entry-installer.md no deprecated user path", () => {
    expect(
      readText("history/plan-2026-03-12-single-entry-installer.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-03-13-fix-interview-strategy.md no deprecated user path", () => {
    expect(
      readText("history/plan-2026-03-13-fix-interview-strategy.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-03-29-fix-vbrief-generation.md no deprecated user path", () => {
    expect(
      readText("history/plan-2026-03-29-fix-vbrief-generation.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-05-06-883-overnight-rc-chain.md no deprecated user path", () => {
    expect(
      readText("history/plan-2026-05-06-883-overnight-rc-chain.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-06-01-1387-headless-swarm-launch.md no deprecated user path", () => {
    expect(
      readText("history/plan-2026-06-01-1387-headless-swarm-launch.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/plan-2026-06-05-swarm-fix-4-issues.md no deprecated user path", () => {
    expect(readText("history/plan-2026-06-05-swarm-fix-4-issues.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("history/proposals/2026-04-18-more-determinism.md no deprecated user path", () => {
    expect(
      readText("history/proposals/2026-04-18-more-determinism.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/proposals/2026-04-28-vbrief-x-consumer-extension-namespace.md no deprecated user path", () => {
    expect(
      readText(
        "history/proposals/2026-04-28-vbrief-x-consumer-extension-namespace.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/session-2026-05-03-phase-1-fix-now-cohort-and-v0.24.0-release.md no deprecated user path", () => {
    expect(
      readText(
        "history/session-2026-05-03-phase-1-fix-now-cohort-and-v0.24.0-release.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("history/todo-2026-03-13-retired.md no deprecated user path", () => {
    expect(readText("history/todo-2026-03-13-retired.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("incidents/2026-04-pocketos-railway-prod-db-wipe.md no deprecated user path", () => {
    expect(
      readText("incidents/2026-04-pocketos-railway-prod-db-wipe.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("incidents/README.md no deprecated user path", () => {
    expect(readText("incidents/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("incidents/_template.md no deprecated user path", () => {
    expect(readText("incidents/_template.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("interfaces/cli.md no deprecated user path", () => {
    expect(readText("interfaces/cli.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("interfaces/rest.md no deprecated user path", () => {
    expect(readText("interfaces/rest.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("interfaces/tui.md no deprecated user path", () => {
    expect(readText("interfaces/tui.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("interfaces/web.md no deprecated user path", () => {
    expect(readText("interfaces/web.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/6502-DASM.md no deprecated user path", () => {
    expect(readText("languages/6502-DASM.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/c.md no deprecated user path", () => {
    expect(readText("languages/c.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/commands.md no deprecated user path", () => {
    expect(readText("languages/commands.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/cpp.md no deprecated user path", () => {
    expect(readText("languages/cpp.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/csharp.md no deprecated user path", () => {
    expect(readText("languages/csharp.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/dart.md no deprecated user path", () => {
    expect(readText("languages/dart.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/delphi.md no deprecated user path", () => {
    expect(readText("languages/delphi.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/elixir.md no deprecated user path", () => {
    expect(readText("languages/elixir.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/go.md no deprecated user path", () => {
    expect(readText("languages/go.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/java.md no deprecated user path", () => {
    expect(readText("languages/java.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/javascript.md no deprecated user path", () => {
    expect(readText("languages/javascript.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/julia.md no deprecated user path", () => {
    expect(readText("languages/julia.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/kotlin.md no deprecated user path", () => {
    expect(readText("languages/kotlin.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/markdown.md no deprecated user path", () => {
    expect(readText("languages/markdown.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/mermaid.md no deprecated user path", () => {
    expect(readText("languages/mermaid.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/officejs.md no deprecated user path", () => {
    expect(readText("languages/officejs.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/python.md no deprecated user path", () => {
    expect(readText("languages/python.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/r.md no deprecated user path", () => {
    expect(readText("languages/r.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/rust.md no deprecated user path", () => {
    expect(readText("languages/rust.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/sql.md no deprecated user path", () => {
    expect(readText("languages/sql.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/swift.md no deprecated user path", () => {
    expect(readText("languages/swift.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/typescript.md no deprecated user path", () => {
    expect(readText("languages/typescript.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/vba.md no deprecated user path", () => {
    expect(readText("languages/vba.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/vhdl.md no deprecated user path", () => {
    expect(readText("languages/vhdl.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/visual-basic.md no deprecated user path", () => {
    expect(readText("languages/visual-basic.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("languages/zig.md no deprecated user path", () => {
    expect(readText("languages/zig.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("main.md no deprecated user path", () => {
    expect(readText("main.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/SOUL.md no deprecated user path", () => {
    expect(readText("meta/SOUL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/code-field.md no deprecated user path", () => {
    expect(readText("meta/code-field.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/ideas.md no deprecated user path", () => {
    expect(readText("meta/ideas.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/lessons.md no deprecated user path", () => {
    expect(readText("meta/lessons.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/morals.md no deprecated user path", () => {
    expect(readText("meta/morals.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/philosophy.md no deprecated user path", () => {
    expect(readText("meta/philosophy.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/security.md no deprecated user path", () => {
    expect(readText("meta/security.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("meta/suggestions.md no deprecated user path", () => {
    expect(readText("meta/suggestions.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@ampproject+remapping@2.3.0/node_modules/@ampproject/remapping/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@ampproject+remapping@2.3.0/node_modules/@ampproject/remapping/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@babel+helper-string-parser@7.29.7/node_modules/@babel/helper-string-parser/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+helper-string-parser@7.29.7/node_modules/@babel/helper-string-parser/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@babel+helper-validator-identifier@7.29.7/node_modules/@babel/helper-validator-identifier/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+helper-validator-identifier@7.29.7/node_modules/@babel/helper-validator-identifier/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@babel+types@7.29.7/node_modules/@babel/types/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+types@7.29.7/node_modules/@babel/types/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.es.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.es.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.fr.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.fr.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.hi.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.hi.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ja.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ja.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.kr.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.kr.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pl.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pl.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pt-BR.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pt-BR.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ru.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ru.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.uk.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.uk.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-CN.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-CN.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-TW.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-TW.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@biomejs+cli-linux-x64@2.5.0/node_modules/@biomejs/cli-linux-x64/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+cli-linux-x64@2.5.0/node_modules/@biomejs/cli-linux-x64/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@esbuild+linux-x64@0.27.7/node_modules/@esbuild/linux-x64/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@esbuild+linux-x64@0.27.7/node_modules/@esbuild/linux-x64/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@isaacs+cliui@8.0.2/node_modules/@isaacs/cliui/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@isaacs+cliui@8.0.2/node_modules/@isaacs/cliui/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@jridgewell+gen-mapping@0.3.13/node_modules/@jridgewell/gen-mapping/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+gen-mapping@0.3.13/node_modules/@jridgewell/gen-mapping/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@jridgewell+resolve-uri@3.1.2/node_modules/@jridgewell/resolve-uri/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+resolve-uri@3.1.2/node_modules/@jridgewell/resolve-uri/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@jridgewell+sourcemap-codec@1.5.5/node_modules/@jridgewell/sourcemap-codec/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+sourcemap-codec@1.5.5/node_modules/@jridgewell/sourcemap-codec/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@rollup+rollup-linux-x64-gnu@4.62.0/node_modules/@rollup/rollup-linux-x64-gnu/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@rollup+rollup-linux-x64-gnu@4.62.0/node_modules/@rollup/rollup-linux-x64-gnu/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@types+chai@5.2.3/node_modules/@types/chai/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+chai@5.2.3/node_modules/@types/chai/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@types+deep-eql@4.0.2/node_modules/@types/deep-eql/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+deep-eql@4.0.2/node_modules/@types/deep-eql/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@types+estree@1.0.9/node_modules/@types/estree/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+estree@1.0.9/node_modules/@types/estree/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@types+node@24.13.2/node_modules/@types/node/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+node@24.13.2/node_modules/@types/node/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@vitest+expect@3.2.6/node_modules/@vitest/expect/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+expect@3.2.6/node_modules/@vitest/expect/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@vitest+mocker@3.2.6_vite@7.3.5_@types+node@24.13.2_/node_modules/@vitest/mocker/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+mocker@3.2.6_vite@7.3.5_@types+node@24.13.2_/node_modules/@vitest/mocker/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@vitest+runner@3.2.6/node_modules/@vitest/runner/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+runner@3.2.6/node_modules/@vitest/runner/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@vitest+snapshot@3.2.6/node_modules/@vitest/snapshot/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+snapshot@3.2.6/node_modules/@vitest/snapshot/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/@vitest+spy@3.2.6/node_modules/@vitest/spy/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+spy@3.2.6/node_modules/@vitest/spy/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/ansi-regex@5.0.1/node_modules/ansi-regex/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-regex@5.0.1/node_modules/ansi-regex/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/ansi-regex@6.2.2/node_modules/ansi-regex/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-regex@6.2.2/node_modules/ansi-regex/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/ansi-styles@4.3.0/node_modules/ansi-styles/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-styles@4.3.0/node_modules/ansi-styles/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/ansi-styles@6.2.3/node_modules/ansi-styles/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-styles@6.2.3/node_modules/ansi-styles/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/assertion-error@2.0.1/node_modules/assertion-error/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/assertion-error@2.0.1/node_modules/assertion-error/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/ast-v8-to-istanbul@0.3.12/node_modules/ast-v8-to-istanbul/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/ast-v8-to-istanbul@0.3.12/node_modules/ast-v8-to-istanbul/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/brace-expansion@2.1.1/node_modules/brace-expansion/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/brace-expansion@2.1.1/node_modules/brace-expansion/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/brace-expansion@5.0.6/node_modules/brace-expansion/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/brace-expansion@5.0.6/node_modules/brace-expansion/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/cac@6.7.14/node_modules/cac/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/cac@6.7.14/node_modules/cac/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/chai@5.3.3/node_modules/chai/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/chai@5.3.3/node_modules/chai/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/check-error@2.1.3/node_modules/check-error/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/check-error@2.1.3/node_modules/check-error/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/color-name@1.1.4/node_modules/color-name/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/color-name@1.1.4/node_modules/color-name/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/debug@4.4.3/node_modules/debug/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/debug@4.4.3/node_modules/debug/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/deep-eql@5.0.2/node_modules/deep-eql/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/deep-eql@5.0.2/node_modules/deep-eql/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/eastasianwidth@0.2.0/node_modules/eastasianwidth/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/eastasianwidth@0.2.0/node_modules/eastasianwidth/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/emoji-regex@8.0.0/node_modules/emoji-regex/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/emoji-regex@8.0.0/node_modules/emoji-regex/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/emoji-regex@9.2.2/node_modules/emoji-regex/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/emoji-regex@9.2.2/node_modules/emoji-regex/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/es-module-lexer@1.7.0/node_modules/es-module-lexer/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/es-module-lexer@1.7.0/node_modules/es-module-lexer/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/LICENSE.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/LICENSE.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/estree-walker@3.0.3/node_modules/estree-walker/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/estree-walker@3.0.3/node_modules/estree-walker/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/SECURITY.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/SECURITY.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/fdir@6.5.0_picomatch@4.0.4/node_modules/fdir/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/fdir@6.5.0_picomatch@4.0.4/node_modules/fdir/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/foreground-child@3.3.1/node_modules/foreground-child/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/foreground-child@3.3.1/node_modules/foreground-child/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/glob@10.5.0/node_modules/glob/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/glob@10.5.0/node_modules/glob/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/readme.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/readme.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/html-escaper@2.0.2/node_modules/html-escaper/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/html-escaper@2.0.2/node_modules/html-escaper/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/is-fullwidth-code-point@3.0.0/node_modules/is-fullwidth-code-point/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/is-fullwidth-code-point@3.0.0/node_modules/is-fullwidth-code-point/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/js-tokens@10.0.0/node_modules/js-tokens/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/js-tokens@10.0.0/node_modules/js-tokens/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/js-tokens@9.0.1/node_modules/js-tokens/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/js-tokens@9.0.1/node_modules/js-tokens/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/loupe@3.2.1/node_modules/loupe/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/loupe@3.2.1/node_modules/loupe/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/lru-cache@10.4.3/node_modules/lru-cache/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/lru-cache@10.4.3/node_modules/lru-cache/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/magic-string@0.30.21/node_modules/magic-string/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/magic-string@0.30.21/node_modules/magic-string/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/magicast@0.3.5/node_modules/magicast/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/magicast@0.3.5/node_modules/magicast/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/make-dir@4.0.0/node_modules/make-dir/readme.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/make-dir@4.0.0/node_modules/make-dir/readme.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/minimatch@9.0.9/node_modules/minimatch/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/minimatch@9.0.9/node_modules/minimatch/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/LICENSE.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/LICENSE.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/ms@2.1.3/node_modules/ms/license.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/ms@2.1.3/node_modules/ms/license.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/ms@2.1.3/node_modules/ms/readme.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/ms@2.1.3/node_modules/ms/readme.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/nanoid@3.3.12/node_modules/nanoid/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/nanoid@3.3.12/node_modules/nanoid/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/path-key@3.1.1/node_modules/path-key/readme.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/path-key@3.1.1/node_modules/path-key/readme.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/pathe@2.0.3/node_modules/pathe/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/pathe@2.0.3/node_modules/pathe/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/pathval@2.0.1/node_modules/pathval/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/pathval@2.0.1/node_modules/pathval/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/picocolors@1.1.1/node_modules/picocolors/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/picocolors@1.1.1/node_modules/picocolors/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/picomatch@4.0.4/node_modules/picomatch/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/picomatch@4.0.4/node_modules/picomatch/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/postcss@8.5.15/node_modules/postcss/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/postcss@8.5.15/node_modules/postcss/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/LICENSE.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/LICENSE.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/semver@7.8.4/node_modules/semver/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/semver@7.8.4/node_modules/semver/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/shebang-command@2.0.0/node_modules/shebang-command/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/shebang-command@2.0.0/node_modules/shebang-command/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/shebang-regex@3.0.0/node_modules/shebang-regex/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/shebang-regex@3.0.0/node_modules/shebang-regex/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/siginfo@2.0.0/node_modules/siginfo/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/siginfo@2.0.0/node_modules/siginfo/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/signal-exit@4.1.0/node_modules/signal-exit/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/signal-exit@4.1.0/node_modules/signal-exit/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/stackback@0.0.2/node_modules/stackback/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/stackback@0.0.2/node_modules/stackback/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/std-env@3.10.0/node_modules/std-env/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/std-env@3.10.0/node_modules/std-env/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/string-width@4.2.3/node_modules/string-width/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/string-width@4.2.3/node_modules/string-width/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/string-width@5.1.2/node_modules/string-width/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/string-width@5.1.2/node_modules/string-width/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/strip-ansi@6.0.1/node_modules/strip-ansi/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/strip-ansi@6.0.1/node_modules/strip-ansi/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/strip-ansi@7.2.0/node_modules/strip-ansi/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/strip-ansi@7.2.0/node_modules/strip-ansi/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/strip-literal@3.1.0/node_modules/strip-literal/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/strip-literal@3.1.0/node_modules/strip-literal/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/readme.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/readme.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/test-exclude@7.0.2/node_modules/test-exclude/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/test-exclude@7.0.2/node_modules/test-exclude/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/tinybench@2.9.0/node_modules/tinybench/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/tinybench@2.9.0/node_modules/tinybench/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/tinyexec@0.3.2/node_modules/tinyexec/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/tinyexec@0.3.2/node_modules/tinyexec/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/tinyglobby@0.2.17/node_modules/tinyglobby/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/tinyglobby@0.2.17/node_modules/tinyglobby/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/tinyrainbow@2.0.0/node_modules/tinyrainbow/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/tinyrainbow@2.0.0/node_modules/tinyrainbow/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/SECURITY.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/SECURITY.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/undici-types@7.18.2/node_modules/undici-types/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/undici-types@7.18.2/node_modules/undici-types/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/vite-node@3.2.4_@types+node@24.13.2/node_modules/vite-node/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/vite-node@3.2.4_@types+node@24.13.2/node_modules/vite-node/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/LICENSE.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/which@2.0.2/node_modules/which/CHANGELOG.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/which@2.0.2/node_modules/which/CHANGELOG.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/which@2.0.2/node_modules/which/README.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/which@2.0.2/node_modules/which/README.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/why-is-node-running@2.3.0/node_modules/why-is-node-running/README.md no deprecated user path", () => {
    expect(
      readText(
        "node_modules/.pnpm/why-is-node-running@2.3.0/node_modules/why-is-node-running/README.md",
      ).toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/wrap-ansi@7.0.0/node_modules/wrap-ansi/readme.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/wrap-ansi@7.0.0/node_modules/wrap-ansi/readme.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("node_modules/.pnpm/wrap-ansi@8.1.0/node_modules/wrap-ansi/readme.md no deprecated user path", () => {
    expect(
      readText("node_modules/.pnpm/wrap-ansi@8.1.0/node_modules/wrap-ansi/readme.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("packages/core/src/content-contracts/standards/COVERAGE-MAP.md no deprecated user path", () => {
    expect(
      readText("packages/core/src/content-contracts/standards/COVERAGE-MAP.md").toLowerCase(),
    ).not.toContain("core/user.md");
  });
  it("patterns/executor-layer-credentials.md no deprecated user path", () => {
    expect(readText("patterns/executor-layer-credentials.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("patterns/llm-app.md no deprecated user path", () => {
    expect(readText("patterns/llm-app.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("patterns/multi-agent.md no deprecated user path", () => {
    expect(readText("patterns/multi-agent.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("patterns/prompt-assembly-layer-ordering.md no deprecated user path", () => {
    expect(readText("patterns/prompt-assembly-layer-ordering.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("patterns/role-as-overlay.md no deprecated user path", () => {
    expect(readText("patterns/role-as-overlay.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("platforms/2600.md no deprecated user path", () => {
    expect(readText("platforms/2600.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("platforms/unity.md no deprecated user path", () => {
    expect(readText("platforms/unity.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("references/composer-skill-porting.md no deprecated user path", () => {
    expect(readText("references/composer-skill-porting.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("references/cost-models.md no deprecated user path", () => {
    expect(readText("references/cost-models.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("references/ip-risk.md no deprecated user path", () => {
    expect(readText("references/ip-risk.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("references/plain-english-ux.md no deprecated user path", () => {
    expect(readText("references/plain-english-ux.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("resilience/context-pruning.md no deprecated user path", () => {
    expect(readText("resilience/context-pruning.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("resilience/continue-here.md no deprecated user path", () => {
    expect(readText("resilience/continue-here.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("scm/changelog.md no deprecated user path", () => {
    expect(readText("scm/changelog.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("scm/git.md no deprecated user path", () => {
    expect(readText("scm/git.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("scm/github.md no deprecated user path", () => {
    expect(readText("scm/github.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("skills/deft-build/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-build/SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("skills/deft-directive-article-review/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-article-review/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-build/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-build/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-cost/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-cost/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-debug/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-debug/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-decompose/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-decompose/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-gh-arch/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-gh-arch/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-gh-slice/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-gh-slice/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-glossary/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-glossary/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-interview/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-interview/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-pre-pr/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-pre-pr/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-probe/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-probe/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-refinement/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-refinement/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-release/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-release/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-review-cycle/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-review-cycle/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-setup/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-setup/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-swarm/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-swarm/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-sync/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-sync/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-triage/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-triage/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-directive-write-skill/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-directive-write-skill/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-interview/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-interview/SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("skills/deft-pre-pr/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-pre-pr/SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("skills/deft-review-cycle/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-review-cycle/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-roadmap-refresh/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-roadmap-refresh/SKILL.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("skills/deft-setup/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-setup/SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("skills/deft-swarm/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-swarm/SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("skills/deft-sync/SKILL.md no deprecated user path", () => {
    expect(readText("skills/deft-sync/SKILL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("specs/strategy-chaining/SPECIFICATION.md no deprecated user path", () => {
    expect(readText("specs/strategy-chaining/SPECIFICATION.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("specs/testbed/SPECIFICATION.md no deprecated user path", () => {
    expect(readText("specs/testbed/SPECIFICATION.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/README.md no deprecated user path", () => {
    expect(readText("strategies/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/artifact-guards.md no deprecated user path", () => {
    expect(readText("strategies/artifact-guards.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/bdd.md no deprecated user path", () => {
    expect(readText("strategies/bdd.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/brownfield.md no deprecated user path", () => {
    expect(readText("strategies/brownfield.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/discuss.md no deprecated user path", () => {
    expect(readText("strategies/discuss.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/emit-hints.md no deprecated user path", () => {
    expect(readText("strategies/emit-hints.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/enterprise.md no deprecated user path", () => {
    expect(readText("strategies/enterprise.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/interview.md no deprecated user path", () => {
    expect(readText("strategies/interview.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/map.md no deprecated user path", () => {
    expect(readText("strategies/map.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/probe.md no deprecated user path", () => {
    expect(readText("strategies/probe.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/rapid.md no deprecated user path", () => {
    expect(readText("strategies/rapid.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/research.md no deprecated user path", () => {
    expect(readText("strategies/research.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/roadmap.md no deprecated user path", () => {
    expect(readText("strategies/roadmap.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/speckit.md no deprecated user path", () => {
    expect(readText("strategies/speckit.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/v0-20-contract.md no deprecated user path", () => {
    expect(readText("strategies/v0-20-contract.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("strategies/yolo.md no deprecated user path", () => {
    expect(readText("strategies/yolo.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("swarm/swarm.md no deprecated user path", () => {
    expect(readText("swarm/swarm.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("templates/COST-ESTIMATE.md no deprecated user path", () => {
    expect(readText("templates/COST-ESTIMATE.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("templates/PULL_REQUEST_TEMPLATE.md no deprecated user path", () => {
    expect(readText("templates/PULL_REQUEST_TEMPLATE.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("templates/agent-prompt-preamble.md no deprecated user path", () => {
    expect(readText("templates/agent-prompt-preamble.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("templates/agents-entry.md no deprecated user path", () => {
    expect(readText("templates/agents-entry.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("templates/agents-entry.placeholders.md no deprecated user path", () => {
    expect(readText("templates/agents-entry.placeholders.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("templates/make-spec-example.md no deprecated user path", () => {
    expect(readText("templates/make-spec-example.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("templates/make-spec.md no deprecated user path", () => {
    expect(readText("templates/make-spec.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("templates/specification.md no deprecated user path", () => {
    expect(readText("templates/specification.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("templates/swarm-greptile-poller-prompt.md no deprecated user path", () => {
    expect(readText("templates/swarm-greptile-poller-prompt.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("tools/RWLDL.md no deprecated user path", () => {
    expect(readText("tools/RWLDL.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("tools/greptile.md no deprecated user path", () => {
    expect(readText("tools/greptile.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("tools/installer.md no deprecated user path", () => {
    expect(readText("tools/installer.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("tools/taskfile-migration.md no deprecated user path", () => {
    expect(readText("tools/taskfile-migration.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("tools/taskfile.md no deprecated user path", () => {
    expect(readText("tools/taskfile.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("tools/telemetry.md no deprecated user path", () => {
    expect(readText("tools/telemetry.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("vbrief/.eval/README.md no deprecated user path", () => {
    expect(readText("vbrief/.eval/README.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("vbrief/.eval/_tmp_976_body_after.md no deprecated user path", () => {
    expect(readText("vbrief/.eval/_tmp_976_body_after.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("vbrief/.eval/_tmp_976_body_before.md no deprecated user path", () => {
    expect(readText("vbrief/.eval/_tmp_976_body_before.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("vbrief/.eval/_tmp_985_body_after_pairing.md no deprecated user path", () => {
    expect(readText("vbrief/.eval/_tmp_985_body_after_pairing.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("vbrief/.eval/_tmp_985_body_before_pairing.md no deprecated user path", () => {
    expect(readText("vbrief/.eval/_tmp_985_body_before_pairing.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("vbrief/.eval/_tmp_988_body_after_pairing.md no deprecated user path", () => {
    expect(readText("vbrief/.eval/_tmp_988_body_after_pairing.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("vbrief/.eval/_tmp_988_body_before_pairing.md no deprecated user path", () => {
    expect(readText("vbrief/.eval/_tmp_988_body_before_pairing.md").toLowerCase()).not.toContain(
      "core/user.md",
    );
  });
  it("vbrief/vbrief.md no deprecated user path", () => {
    expect(readText("vbrief/vbrief.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("verification/integration.md no deprecated user path", () => {
    expect(readText("verification/integration.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("verification/plan-checking.md no deprecated user path", () => {
    expect(readText("verification/plan-checking.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("verification/uat.md no deprecated user path", () => {
    expect(readText("verification/uat.md").toLowerCase()).not.toContain("core/user.md");
  });
  it("verification/verification.md no deprecated user path", () => {
    expect(readText("verification/verification.md").toLowerCase()).not.toContain("core/user.md");
  });
  it(".agents/skills/deft/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it(".agents/skills/deft-directive-article-review/SKILL.md no warping", () => {
    expect(
      readText(".agents/skills/deft-directive-article-review/SKILL.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it(".agents/skills/deft-directive-build/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-build/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-cost/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-cost/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-debug/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-debug/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-gh-arch/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-gh-arch/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-gh-slice/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-gh-slice/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-glossary/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-glossary/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-interview/SKILL.md no warping", () => {
    expect(
      readText(".agents/skills/deft-directive-interview/SKILL.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it(".agents/skills/deft-directive-pre-pr/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-pre-pr/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-refinement/SKILL.md no warping", () => {
    expect(
      readText(".agents/skills/deft-directive-refinement/SKILL.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it(".agents/skills/deft-directive-release/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-release/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-review-cycle/SKILL.md no warping", () => {
    expect(
      readText(".agents/skills/deft-directive-review-cycle/SKILL.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it(".agents/skills/deft-directive-setup/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-setup/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-swarm/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-swarm/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-sync/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-sync/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-triage/SKILL.md no warping", () => {
    expect(readText(".agents/skills/deft-directive-triage/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".agents/skills/deft-directive-write-skill/SKILL.md no warping", () => {
    expect(
      readText(".agents/skills/deft-directive-write-skill/SKILL.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it(".github/PULL_REQUEST_TEMPLATE.md no warping", () => {
    expect(readText(".github/PULL_REQUEST_TEMPLATE.md").toLowerCase()).not.toContain("warping");
  });
  it(".github/release-notes/upgrade-banner.md no warping", () => {
    expect(readText(".github/release-notes/upgrade-banner.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it(".planning/codebase/ARCHITECTURE.md no warping", () => {
    expect(readText(".planning/codebase/ARCHITECTURE.md").toLowerCase()).not.toContain("warping");
  });
  it(".planning/codebase/CONCERNS.md no warping", () => {
    expect(readText(".planning/codebase/CONCERNS.md").toLowerCase()).not.toContain("warping");
  });
  it(".planning/codebase/CONVENTIONS.md no warping", () => {
    expect(readText(".planning/codebase/CONVENTIONS.md").toLowerCase()).not.toContain("warping");
  });
  it(".planning/codebase/STACK.md no warping", () => {
    expect(readText(".planning/codebase/STACK.md").toLowerCase()).not.toContain("warping");
  });
  it("AGENTS.md no warping", () => {
    expect(readText("AGENTS.md").toLowerCase()).not.toContain("warping");
  });
  it("CONTRIBUTING.md no warping", () => {
    expect(readText("CONTRIBUTING.md").toLowerCase()).not.toContain("warping");
  });
  it("LICENSE.md no warping", () => {
    expect(readText("LICENSE.md").toLowerCase()).not.toContain("warping");
  });
  it("PROJECT.md no warping", () => {
    expect(readText("PROJECT.md").toLowerCase()).not.toContain("warping");
  });
  it("QUICK-START.md no warping", () => {
    expect(readText("QUICK-START.md").toLowerCase()).not.toContain("warping");
  });
  it("README.md no warping", () => {
    expect(readText("README.md").toLowerCase()).not.toContain("warping");
  });
  it("REFERENCES.md no warping", () => {
    expect(readText("REFERENCES.md").toLowerCase()).not.toContain("warping");
  });
  it("SKILL.md no warping", () => {
    expect(readText("SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("UPGRADING.md no warping", () => {
    expect(readText("UPGRADING.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/build-output.md no warping", () => {
    expect(readText("coding/build-output.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/coding.md no warping", () => {
    expect(readText("coding/coding.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/debugging.md no warping", () => {
    expect(readText("coding/debugging.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/holzmann.md no warping", () => {
    expect(readText("coding/holzmann.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/hygiene.md no warping", () => {
    expect(readText("coding/hygiene.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/security.md no warping", () => {
    expect(readText("coding/security.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/testing.md no warping", () => {
    expect(readText("coding/testing.md").toLowerCase()).not.toContain("warping");
  });
  it("coding/toolchain.md no warping", () => {
    expect(readText("coding/toolchain.md").toLowerCase()).not.toContain("warping");
  });
  it("commands.md no warping", () => {
    expect(readText("commands.md").toLowerCase()).not.toContain("warping");
  });
  it("context/context.md no warping", () => {
    expect(readText("context/context.md").toLowerCase()).not.toContain("warping");
  });
  it("context/deterministic-split.md no warping", () => {
    expect(readText("context/deterministic-split.md").toLowerCase()).not.toContain("warping");
  });
  it("context/examples.md no warping", () => {
    expect(readText("context/examples.md").toLowerCase()).not.toContain("warping");
  });
  it("context/fractal-summaries.md no warping", () => {
    expect(readText("context/fractal-summaries.md").toLowerCase()).not.toContain("warping");
  });
  it("context/long-horizon.md no warping", () => {
    expect(readText("context/long-horizon.md").toLowerCase()).not.toContain("warping");
  });
  it("context/spec-deltas.md no warping", () => {
    expect(readText("context/spec-deltas.md").toLowerCase()).not.toContain("warping");
  });
  it("context/tool-design.md no warping", () => {
    expect(readText("context/tool-design.md").toLowerCase()).not.toContain("warping");
  });
  it("context/working-memory.md no warping", () => {
    expect(readText("context/working-memory.md").toLowerCase()).not.toContain("warping");
  });
  it("contracts/boundary-maps.md no warping", () => {
    expect(readText("contracts/boundary-maps.md").toLowerCase()).not.toContain("warping");
  });
  it("contracts/deterministic-questions.md no warping", () => {
    expect(readText("contracts/deterministic-questions.md").toLowerCase()).not.toContain("warping");
  });
  it("contracts/hierarchy.md no warping", () => {
    expect(readText("contracts/hierarchy.md").toLowerCase()).not.toContain("warping");
  });
  it("conventions/machine-generated-banner.md no warping", () => {
    expect(readText("conventions/machine-generated-banner.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("conventions/references.md no warping", () => {
    expect(readText("conventions/references.md").toLowerCase()).not.toContain("warping");
  });
  it("conventions/task-caching.md no warping", () => {
    expect(readText("conventions/task-caching.md").toLowerCase()).not.toContain("warping");
  });
  it("conventions/vbrief-filenames.md no warping", () => {
    expect(readText("conventions/vbrief-filenames.md").toLowerCase()).not.toContain("warping");
  });
  it("core/glossary.md no warping", () => {
    expect(readText("glossary.md").toLowerCase()).not.toContain("warping");
  });
  it("core/project.md no warping", () => {
    expect(readText("meta/project.md").toLowerCase()).not.toContain("warping");
  });
  it("core/ralph.md no warping", () => {
    expect(readText("meta/ralph.md").toLowerCase()).not.toContain("warping");
  });
  it("core/versioning.md no warping", () => {
    expect(readText("meta/versioning.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/README.md no warping", () => {
    expect(readText("deployments/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/agentuity/README.md no warping", () => {
    expect(readText("deployments/agentuity/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/agentuity/via-cli.md no warping", () => {
    expect(readText("deployments/agentuity/via-cli.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/agentuity/via-cloud.md no warping", () => {
    expect(readText("deployments/agentuity/via-cloud.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/agentuity/via-github-actions.md no warping", () => {
    expect(readText("deployments/agentuity/via-github-actions.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/agentuity/via-gravity-network.md no warping", () => {
    expect(readText("deployments/agentuity/via-gravity-network.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/agentuity/via-vpc.md no warping", () => {
    expect(readText("deployments/agentuity/via-vpc.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/aws/README.md no warping", () => {
    expect(readText("deployments/aws/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/aws/via-app-runner.md no warping", () => {
    expect(readText("deployments/aws/via-app-runner.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/aws/via-ecs-fargate.md no warping", () => {
    expect(readText("deployments/aws/via-ecs-fargate.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/aws/via-elastic-beanstalk.md no warping", () => {
    expect(readText("deployments/aws/via-elastic-beanstalk.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/aws/via-lambda.md no warping", () => {
    expect(readText("deployments/aws/via-lambda.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/azure/README.md no warping", () => {
    expect(readText("deployments/azure/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/azure/via-aks.md no warping", () => {
    expect(readText("deployments/azure/via-aks.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/azure/via-app-service.md no warping", () => {
    expect(readText("deployments/azure/via-app-service.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/azure/via-container-apps.md no warping", () => {
    expect(readText("deployments/azure/via-container-apps.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/azure/via-functions.md no warping", () => {
    expect(readText("deployments/azure/via-functions.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/README.md no warping", () => {
    expect(readText("deployments/cloud-gov/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/agents/compliance-docs.md no warping", () => {
    expect(readText("deployments/cloud-gov/agents/compliance-docs.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/cloud-gov/agents.md no warping", () => {
    expect(readText("deployments/cloud-gov/agents.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/cicd.md no warping", () => {
    expect(readText("deployments/cloud-gov/cicd.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/deployment.md no warping", () => {
    expect(readText("deployments/cloud-gov/deployment.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/logging.md no warping", () => {
    expect(readText("deployments/cloud-gov/logging.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/manifest.md no warping", () => {
    expect(readText("deployments/cloud-gov/manifest.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/overview.md no warping", () => {
    expect(readText("deployments/cloud-gov/overview.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/security.md no warping", () => {
    expect(readText("deployments/cloud-gov/security.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/services.md no warping", () => {
    expect(readText("deployments/cloud-gov/services.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloud-gov/upstream/README.md no warping", () => {
    expect(readText("deployments/cloud-gov/upstream/README.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/cloudflare/README.md no warping", () => {
    expect(readText("deployments/cloudflare/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloudflare/via-dashboard.md no warping", () => {
    expect(readText("deployments/cloudflare/via-dashboard.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/cloudflare/via-git.md no warping", () => {
    expect(readText("deployments/cloudflare/via-git.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/cloudflare/via-github-actions.md no warping", () => {
    expect(readText("deployments/cloudflare/via-github-actions.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/cloudflare/via-terraform.md no warping", () => {
    expect(readText("deployments/cloudflare/via-terraform.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/cloudflare/via-wrangler.md no warping", () => {
    expect(readText("deployments/cloudflare/via-wrangler.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/fly-io/README.md no warping", () => {
    expect(readText("deployments/fly-io/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/fly-io/via-dockerfile.md no warping", () => {
    expect(readText("deployments/fly-io/via-dockerfile.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/fly-io/via-flyctl.md no warping", () => {
    expect(readText("deployments/fly-io/via-flyctl.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/fly-io/via-github-actions.md no warping", () => {
    expect(readText("deployments/fly-io/via-github-actions.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/fly-io/via-multi-region.md no warping", () => {
    expect(readText("deployments/fly-io/via-multi-region.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/google/README.md no warping", () => {
    expect(readText("deployments/google/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/google/via-app-engine.md no warping", () => {
    expect(readText("deployments/google/via-app-engine.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/google/via-cloud-functions.md no warping", () => {
    expect(readText("deployments/google/via-cloud-functions.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("deployments/google/via-cloud-run.md no warping", () => {
    expect(readText("deployments/google/via-cloud-run.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/google/via-gke.md no warping", () => {
    expect(readText("deployments/google/via-gke.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/netlify/README.md no warping", () => {
    expect(readText("deployments/netlify/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/netlify/via-cli.md no warping", () => {
    expect(readText("deployments/netlify/via-cli.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/netlify/via-functions.md no warping", () => {
    expect(readText("deployments/netlify/via-functions.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/netlify/via-git.md no warping", () => {
    expect(readText("deployments/netlify/via-git.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/vercel/README.md no warping", () => {
    expect(readText("deployments/vercel/README.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/vercel/via-api.md no warping", () => {
    expect(readText("deployments/vercel/via-api.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/vercel/via-cli.md no warping", () => {
    expect(readText("deployments/vercel/via-cli.md").toLowerCase()).not.toContain("warping");
  });
  it("deployments/vercel/via-git.md no warping", () => {
    expect(readText("deployments/vercel/via-git.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/ARCHITECTURE.md no warping", () => {
    expect(readText("docs/ARCHITECTURE.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/BROWNFIELD.md no warping", () => {
    expect(readText("docs/BROWNFIELD.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/CONCEPTS.md no warping", () => {
    expect(readText("docs/CONCEPTS.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/FILES.md no warping", () => {
    expect(readText("docs/FILES.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/RELEASING.md no warping", () => {
    expect(readText("docs/RELEASING.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/agent-stuck-in-a-loop.md no warping", () => {
    expect(readText("docs/agent-stuck-in-a-loop.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/agents-md-vs-skill-md.md no warping", () => {
    expect(readText("docs/agents-md-vs-skill-md.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/ai-agent-teaming.md no warping", () => {
    expect(readText("docs/ai-agent-teaming.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/ai-coding-trust-paradox.md no warping", () => {
    expect(readText("docs/ai-coding-trust-paradox.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md no warping", () => {
    expect(
      readText(
        "docs/analysis/2026-05-26-issue-1353-grok-windows-capture-opensrc-audit.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/analysis/2026-06-12-lifecycle-taskfile-exit-smoke.md no warping", () => {
    expect(
      readText("docs/analysis/2026-06-12-lifecycle-taskfile-exit-smoke.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/analysis/2026-06-19-sign-off-layer-consumer-value.md no warping", () => {
    expect(
      readText("docs/analysis/2026-06-19-sign-off-layer-consumer-value.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/article-review-2026-05-01-03.md no warping", () => {
    expect(readText("docs/article-review-2026-05-01-03.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/audit-2026-05-10-installer-conformance.md no warping", () => {
    expect(readText("docs/audit-2026-05-10-installer-conformance.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/audit-2026-05-11-installer-conformance-recheck.md no warping", () => {
    expect(
      readText("docs/audit-2026-05-11-installer-conformance-recheck.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/claude-code-integration.md no warping", () => {
    expect(readText("docs/claude-code-integration.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/code-structure-profile.md no warping", () => {
    expect(readText("docs/code-structure-profile.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/codebase-map-source-of-truth.md no warping", () => {
    expect(readText("docs/codebase-map-source-of-truth.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/decisions/ADR-001.md no warping", () => {
    expect(readText("docs/decisions/ADR-001.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/design-deft-cache-quarantine.md no warping", () => {
    expect(readText("docs/design-deft-cache-quarantine.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/example-project-definition.md no warping", () => {
    expect(readText("docs/example-project-definition.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/getting-started.md no warping", () => {
    expect(readText("docs/getting-started.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/gitcrawl-fallback.md no warping", () => {
    expect(readText("docs/gitcrawl-fallback.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/good-agents-md.md no warping", () => {
    expect(readText("docs/good-agents-md.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/harness-is-everything-deft-plan.md no warping", () => {
    expect(readText("docs/harness-is-everything-deft-plan.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/install-manifest.md no warping", () => {
    expect(readText("docs/install-manifest.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/privacy-nfr.md no warping", () => {
    expect(readText("docs/privacy-nfr.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/quarantine-spec.md no warping", () => {
    expect(readText("docs/quarantine-spec.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/refactoring-guidelines.md no warping", () => {
    expect(readText("docs/refactoring-guidelines.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/reference/forensic-research/README.md no warping", () => {
    expect(readText("docs/reference/forensic-research/README.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/reference/forensic-research/SKILL.md no warping", () => {
    expect(readText("docs/reference/forensic-research/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/reference/forensic-research/VENDORED.md no warping", () => {
    expect(readText("docs/reference/forensic-research/VENDORED.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/reference/forensic-research/examples/slizard/code-facts.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/examples/slizard/code-facts.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/examples/slizard/failures.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/examples/slizard/failures.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/examples/slizard/investigate-production.md no warping", () => {
    expect(
      readText(
        "docs/reference/forensic-research/examples/slizard/investigate-production.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/examples/slizard/slizard-production.md no warping", () => {
    expect(
      readText(
        "docs/reference/forensic-research/examples/slizard/slizard-production.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/domains/TEMPLATE.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/domains/TEMPLATE.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/domains/code-debug.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/domains/code-debug.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/failures.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/failures.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/follow-ups.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/follow-ups.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/forensic-mode.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/forensic-mode.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/investigation-profile.md no warping", () => {
    expect(
      readText(
        "docs/reference/forensic-research/references/investigation-profile.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/orchestrator-protocol.md no warping", () => {
    expect(
      readText(
        "docs/reference/forensic-research/references/orchestrator-protocol.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/outcome-template.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/outcome-template.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/question-framing.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/question-framing.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/reference/forensic-research/references/subagent-prompts.md no warping", () => {
    expect(
      readText("docs/reference/forensic-research/references/subagent-prompts.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/research/deft-directive-research.md no warping", () => {
    expect(readText("docs/research/deft-directive-research.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/security.md no warping", () => {
    expect(readText("docs/security.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/smoke-2026-05-06-v0.26.0-scale.md no warping", () => {
    expect(readText("docs/smoke-2026-05-06-v0.26.0-scale.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/smoke-2026-05-07-v0.26.0-rerun.md no warping", () => {
    expect(readText("docs/smoke-2026-05-07-v0.26.0-rerun.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/smoke-2026-05-10-v0.27.1-relocator-dogfood.md no warping", () => {
    expect(
      readText("docs/smoke-2026-05-10-v0.27.1-relocator-dogfood.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("docs/subagent-heartbeat.md no warping", () => {
    expect(readText("docs/subagent-heartbeat.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/superpowers.md no warping", () => {
    expect(readText("docs/superpowers.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/system-of-record-gate.md no warping", () => {
    expect(readText("docs/system-of-record-gate.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/the-harness-is-everything.md no warping", () => {
    expect(readText("docs/the-harness-is-everything.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/thousand-skills.md no warping", () => {
    expect(readText("docs/thousand-skills.md").toLowerCase()).not.toContain("warping");
  });
  it("docs/valuable-go-task-improvements.md no warping", () => {
    expect(readText("docs/valuable-go-task-improvements.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("docs/versioning.md no warping", () => {
    expect(readText("docs/versioning.md").toLowerCase()).not.toContain("warping");
  });
  it("events/README.md no warping", () => {
    expect(readText("events/README.md").toLowerCase()).not.toContain("warping");
  });
  it("glossary.md no warping", () => {
    expect(readText("glossary.md").toLowerCase()).not.toContain("warping");
  });
  it("history/README.md no warping", () => {
    expect(readText("history/README.md").toLowerCase()).not.toContain("warping");
  });
  it("history/analysis-2026-03-22-issue-chain-68-94.md no warping", () => {
    expect(
      readText("history/analysis-2026-03-22-issue-chain-68-94.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/archive/2026-03-20-agent-auto-alignment/design.md no warping", () => {
    expect(
      readText("history/archive/2026-03-20-agent-auto-alignment/design.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/archive/2026-03-20-agent-auto-alignment/proposal.md no warping", () => {
    expect(
      readText("history/archive/2026-03-20-agent-auto-alignment/proposal.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/archive/2026-03-20-agents-md-onboarding/design.md no warping", () => {
    expect(
      readText("history/archive/2026-03-20-agents-md-onboarding/design.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/archive/2026-03-20-agents-md-onboarding/proposal.md no warping", () => {
    expect(
      readText("history/archive/2026-03-20-agents-md-onboarding/proposal.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/changes/README.md no warping", () => {
    expect(readText("history/changes/README.md").toLowerCase()).not.toContain("warping");
  });
  it("history/changes/fix-171-175-commit-gate-and-review-cycle-discipline/CHANGE.md no warping", () => {
    expect(
      readText(
        "history/changes/fix-171-175-commit-gate-and-review-cycle-discipline/CHANGE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/changes/fix-172-oz-agent-run-correction/CHANGE.md no warping", () => {
    expect(
      readText("history/changes/fix-172-oz-agent-run-correction/CHANGE.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/implementation-2026-03-13-fix-interview-strategy.md no warping", () => {
    expect(
      readText("history/implementation-2026-03-13-fix-interview-strategy.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-03-11-cross-platform-agent-skills.md no warping", () => {
    expect(
      readText("history/plan-2026-03-11-cross-platform-agent-skills.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-03-12-cross-platform-agent-skills-impl.md no warping", () => {
    expect(
      readText("history/plan-2026-03-12-cross-platform-agent-skills-impl.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-03-12-go-installer-impl.md no warping", () => {
    expect(readText("history/plan-2026-03-12-go-installer-impl.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("history/plan-2026-03-12-single-entry-installer.md no warping", () => {
    expect(
      readText("history/plan-2026-03-12-single-entry-installer.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-03-13-fix-interview-strategy.md no warping", () => {
    expect(
      readText("history/plan-2026-03-13-fix-interview-strategy.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-03-29-fix-vbrief-generation.md no warping", () => {
    expect(
      readText("history/plan-2026-03-29-fix-vbrief-generation.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-05-06-883-overnight-rc-chain.md no warping", () => {
    expect(
      readText("history/plan-2026-05-06-883-overnight-rc-chain.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-06-01-1387-headless-swarm-launch.md no warping", () => {
    expect(
      readText("history/plan-2026-06-01-1387-headless-swarm-launch.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/plan-2026-06-05-swarm-fix-4-issues.md no warping", () => {
    expect(readText("history/plan-2026-06-05-swarm-fix-4-issues.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("history/proposals/2026-04-18-more-determinism.md no warping", () => {
    expect(
      readText("history/proposals/2026-04-18-more-determinism.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/proposals/2026-04-28-vbrief-x-consumer-extension-namespace.md no warping", () => {
    expect(
      readText(
        "history/proposals/2026-04-28-vbrief-x-consumer-extension-namespace.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("history/session-2026-05-03-phase-1-fix-now-cohort-and-v0.24.0-release.md no warping", () => {
    expect(
      readText(
        "history/session-2026-05-03-phase-1-fix-now-cohort-and-v0.24.0-release.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("incidents/2026-04-pocketos-railway-prod-db-wipe.md no warping", () => {
    expect(
      readText("incidents/2026-04-pocketos-railway-prod-db-wipe.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("incidents/README.md no warping", () => {
    expect(readText("incidents/README.md").toLowerCase()).not.toContain("warping");
  });
  it("incidents/_template.md no warping", () => {
    expect(readText("incidents/_template.md").toLowerCase()).not.toContain("warping");
  });
  it("interfaces/cli.md no warping", () => {
    expect(readText("interfaces/cli.md").toLowerCase()).not.toContain("warping");
  });
  it("interfaces/rest.md no warping", () => {
    expect(readText("interfaces/rest.md").toLowerCase()).not.toContain("warping");
  });
  it("interfaces/tui.md no warping", () => {
    expect(readText("interfaces/tui.md").toLowerCase()).not.toContain("warping");
  });
  it("interfaces/web.md no warping", () => {
    expect(readText("interfaces/web.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/6502-DASM.md no warping", () => {
    expect(readText("languages/6502-DASM.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/c.md no warping", () => {
    expect(readText("languages/c.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/commands.md no warping", () => {
    expect(readText("languages/commands.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/cpp.md no warping", () => {
    expect(readText("languages/cpp.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/csharp.md no warping", () => {
    expect(readText("languages/csharp.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/dart.md no warping", () => {
    expect(readText("languages/dart.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/delphi.md no warping", () => {
    expect(readText("languages/delphi.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/elixir.md no warping", () => {
    expect(readText("languages/elixir.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/go.md no warping", () => {
    expect(readText("languages/go.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/java.md no warping", () => {
    expect(readText("languages/java.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/javascript.md no warping", () => {
    expect(readText("languages/javascript.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/julia.md no warping", () => {
    expect(readText("languages/julia.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/kotlin.md no warping", () => {
    expect(readText("languages/kotlin.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/markdown.md no warping", () => {
    expect(readText("languages/markdown.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/mermaid.md no warping", () => {
    expect(readText("languages/mermaid.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/officejs.md no warping", () => {
    expect(readText("languages/officejs.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/python.md no warping", () => {
    expect(readText("languages/python.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/r.md no warping", () => {
    expect(readText("languages/r.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/rust.md no warping", () => {
    expect(readText("languages/rust.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/sql.md no warping", () => {
    expect(readText("languages/sql.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/swift.md no warping", () => {
    expect(readText("languages/swift.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/typescript.md no warping", () => {
    expect(readText("languages/typescript.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/vba.md no warping", () => {
    expect(readText("languages/vba.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/vhdl.md no warping", () => {
    expect(readText("languages/vhdl.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/visual-basic.md no warping", () => {
    expect(readText("languages/visual-basic.md").toLowerCase()).not.toContain("warping");
  });
  it("languages/zig.md no warping", () => {
    expect(readText("languages/zig.md").toLowerCase()).not.toContain("warping");
  });
  it("main.md no warping", () => {
    expect(readText("main.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/SOUL.md no warping", () => {
    expect(readText("meta/SOUL.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/code-field.md no warping", () => {
    expect(readText("meta/code-field.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/ideas.md no warping", () => {
    expect(readText("meta/ideas.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/lessons.md no warping", () => {
    expect(readText("meta/lessons.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/morals.md no warping", () => {
    expect(readText("meta/morals.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/philosophy.md no warping", () => {
    expect(readText("meta/philosophy.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/security.md no warping", () => {
    expect(readText("meta/security.md").toLowerCase()).not.toContain("warping");
  });
  it("meta/suggestions.md no warping", () => {
    expect(readText("meta/suggestions.md").toLowerCase()).not.toContain("warping");
  });
  it("node_modules/.pnpm/@ampproject+remapping@2.3.0/node_modules/@ampproject/remapping/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@ampproject+remapping@2.3.0/node_modules/@ampproject/remapping/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@babel+helper-string-parser@7.29.7/node_modules/@babel/helper-string-parser/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+helper-string-parser@7.29.7/node_modules/@babel/helper-string-parser/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@babel+helper-validator-identifier@7.29.7/node_modules/@babel/helper-validator-identifier/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+helper-validator-identifier@7.29.7/node_modules/@babel/helper-validator-identifier/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+parser@7.29.7/node_modules/@babel/parser/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@babel+types@7.29.7/node_modules/@babel/types/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@babel+types@7.29.7/node_modules/@babel/types/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@bcoe+v8-coverage@1.0.2/node_modules/@bcoe/v8-coverage/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.es.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.es.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.fr.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.fr.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.hi.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.hi.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ja.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ja.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.kr.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.kr.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pl.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pl.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pt-BR.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.pt-BR.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ru.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.ru.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.uk.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.uk.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-CN.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-CN.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-TW.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+biome@2.5.0/node_modules/@biomejs/biome/README.zh-TW.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@biomejs+cli-linux-x64@2.5.0/node_modules/@biomejs/cli-linux-x64/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@biomejs+cli-linux-x64@2.5.0/node_modules/@biomejs/cli-linux-x64/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@esbuild+linux-x64@0.27.7/node_modules/@esbuild/linux-x64/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@esbuild+linux-x64@0.27.7/node_modules/@esbuild/linux-x64/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@isaacs+cliui@8.0.2/node_modules/@isaacs/cliui/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@isaacs+cliui@8.0.2/node_modules/@isaacs/cliui/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@istanbuljs+schema@0.1.6/node_modules/@istanbuljs/schema/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@jridgewell+gen-mapping@0.3.13/node_modules/@jridgewell/gen-mapping/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+gen-mapping@0.3.13/node_modules/@jridgewell/gen-mapping/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@jridgewell+resolve-uri@3.1.2/node_modules/@jridgewell/resolve-uri/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+resolve-uri@3.1.2/node_modules/@jridgewell/resolve-uri/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@jridgewell+sourcemap-codec@1.5.5/node_modules/@jridgewell/sourcemap-codec/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+sourcemap-codec@1.5.5/node_modules/@jridgewell/sourcemap-codec/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@pkgjs+parseargs@0.11.0/node_modules/@pkgjs/parseargs/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@rollup+rollup-linux-x64-gnu@4.62.0/node_modules/@rollup/rollup-linux-x64-gnu/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@rollup+rollup-linux-x64-gnu@4.62.0/node_modules/@rollup/rollup-linux-x64-gnu/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@types+chai@5.2.3/node_modules/@types/chai/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+chai@5.2.3/node_modules/@types/chai/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@types+deep-eql@4.0.2/node_modules/@types/deep-eql/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+deep-eql@4.0.2/node_modules/@types/deep-eql/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@types+estree@1.0.9/node_modules/@types/estree/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+estree@1.0.9/node_modules/@types/estree/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@types+node@24.13.2/node_modules/@types/node/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@types+node@24.13.2/node_modules/@types/node/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@vitest+expect@3.2.6/node_modules/@vitest/expect/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+expect@3.2.6/node_modules/@vitest/expect/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@vitest+mocker@3.2.6_vite@7.3.5_@types+node@24.13.2_/node_modules/@vitest/mocker/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+mocker@3.2.6_vite@7.3.5_@types+node@24.13.2_/node_modules/@vitest/mocker/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@vitest+runner@3.2.6/node_modules/@vitest/runner/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+runner@3.2.6/node_modules/@vitest/runner/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@vitest+snapshot@3.2.6/node_modules/@vitest/snapshot/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+snapshot@3.2.6/node_modules/@vitest/snapshot/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/@vitest+spy@3.2.6/node_modules/@vitest/spy/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/@vitest+spy@3.2.6/node_modules/@vitest/spy/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/ansi-regex@5.0.1/node_modules/ansi-regex/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-regex@5.0.1/node_modules/ansi-regex/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/ansi-regex@6.2.2/node_modules/ansi-regex/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-regex@6.2.2/node_modules/ansi-regex/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/ansi-styles@4.3.0/node_modules/ansi-styles/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-styles@4.3.0/node_modules/ansi-styles/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/ansi-styles@6.2.3/node_modules/ansi-styles/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/ansi-styles@6.2.3/node_modules/ansi-styles/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/assertion-error@2.0.1/node_modules/assertion-error/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/assertion-error@2.0.1/node_modules/assertion-error/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/ast-v8-to-istanbul@0.3.12/node_modules/ast-v8-to-istanbul/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/ast-v8-to-istanbul@0.3.12/node_modules/ast-v8-to-istanbul/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@1.0.2/node_modules/balanced-match/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/balanced-match@4.0.4/node_modules/balanced-match/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/brace-expansion@2.1.1/node_modules/brace-expansion/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/brace-expansion@2.1.1/node_modules/brace-expansion/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/brace-expansion@5.0.6/node_modules/brace-expansion/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/brace-expansion@5.0.6/node_modules/brace-expansion/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/cac@6.7.14/node_modules/cac/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/cac@6.7.14/node_modules/cac/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/chai@5.3.3/node_modules/chai/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/chai@5.3.3/node_modules/chai/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/check-error@2.1.3/node_modules/check-error/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/check-error@2.1.3/node_modules/check-error/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/color-convert@2.0.1/node_modules/color-convert/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/color-name@1.1.4/node_modules/color-name/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/color-name@1.1.4/node_modules/color-name/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/cross-spawn@7.0.6/node_modules/cross-spawn/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/debug@4.4.3/node_modules/debug/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/debug@4.4.3/node_modules/debug/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/deep-eql@5.0.2/node_modules/deep-eql/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/deep-eql@5.0.2/node_modules/deep-eql/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/eastasianwidth@0.2.0/node_modules/eastasianwidth/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/eastasianwidth@0.2.0/node_modules/eastasianwidth/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/emoji-regex@8.0.0/node_modules/emoji-regex/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/emoji-regex@8.0.0/node_modules/emoji-regex/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/emoji-regex@9.2.2/node_modules/emoji-regex/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/emoji-regex@9.2.2/node_modules/emoji-regex/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/es-module-lexer@1.7.0/node_modules/es-module-lexer/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/es-module-lexer@1.7.0/node_modules/es-module-lexer/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/LICENSE.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/LICENSE.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/estree-walker@3.0.3/node_modules/estree-walker/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/estree-walker@3.0.3/node_modules/estree-walker/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/SECURITY.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/expect-type@1.3.0/node_modules/expect-type/SECURITY.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/fdir@6.5.0_picomatch@4.0.4/node_modules/fdir/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/fdir@6.5.0_picomatch@4.0.4/node_modules/fdir/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/foreground-child@3.3.1/node_modules/foreground-child/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/foreground-child@3.3.1/node_modules/foreground-child/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/glob@10.5.0/node_modules/glob/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/glob@10.5.0/node_modules/glob/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/readme.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/readme.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/html-escaper@2.0.2/node_modules/html-escaper/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/html-escaper@2.0.2/node_modules/html-escaper/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/is-fullwidth-code-point@3.0.0/node_modules/is-fullwidth-code-point/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/is-fullwidth-code-point@3.0.0/node_modules/is-fullwidth-code-point/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/isexe@2.0.0/node_modules/isexe/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-lib-source-maps@5.0.6/node_modules/istanbul-lib-source-maps/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/CHANGELOG.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/CHANGELOG.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/jackspeak@3.4.3/node_modules/jackspeak/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/js-tokens@10.0.0/node_modules/js-tokens/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/js-tokens@10.0.0/node_modules/js-tokens/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/js-tokens@9.0.1/node_modules/js-tokens/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/js-tokens@9.0.1/node_modules/js-tokens/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/loupe@3.2.1/node_modules/loupe/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/loupe@3.2.1/node_modules/loupe/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/lru-cache@10.4.3/node_modules/lru-cache/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/lru-cache@10.4.3/node_modules/lru-cache/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/magic-string@0.30.21/node_modules/magic-string/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/magic-string@0.30.21/node_modules/magic-string/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/magicast@0.3.5/node_modules/magicast/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/magicast@0.3.5/node_modules/magicast/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/make-dir@4.0.0/node_modules/make-dir/readme.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/make-dir@4.0.0/node_modules/make-dir/readme.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/minimatch@10.2.5/node_modules/minimatch/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/minimatch@9.0.9/node_modules/minimatch/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/minimatch@9.0.9/node_modules/minimatch/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/LICENSE.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/LICENSE.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/minipass@7.1.3/node_modules/minipass/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/ms@2.1.3/node_modules/ms/license.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/ms@2.1.3/node_modules/ms/license.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/ms@2.1.3/node_modules/ms/readme.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/ms@2.1.3/node_modules/ms/readme.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/nanoid@3.3.12/node_modules/nanoid/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/nanoid@3.3.12/node_modules/nanoid/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/package-json-from-dist@1.0.1/node_modules/package-json-from-dist/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/path-key@3.1.1/node_modules/path-key/readme.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/path-key@3.1.1/node_modules/path-key/readme.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/path-scurry@1.11.1/node_modules/path-scurry/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/pathe@2.0.3/node_modules/pathe/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/pathe@2.0.3/node_modules/pathe/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/pathval@2.0.1/node_modules/pathval/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/pathval@2.0.1/node_modules/pathval/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/picocolors@1.1.1/node_modules/picocolors/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/picocolors@1.1.1/node_modules/picocolors/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/picomatch@4.0.4/node_modules/picomatch/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/picomatch@4.0.4/node_modules/picomatch/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/postcss@8.5.15/node_modules/postcss/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/postcss@8.5.15/node_modules/postcss/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/LICENSE.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/LICENSE.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/rollup@4.62.0/node_modules/rollup/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/semver@7.8.4/node_modules/semver/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/semver@7.8.4/node_modules/semver/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/shebang-command@2.0.0/node_modules/shebang-command/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/shebang-command@2.0.0/node_modules/shebang-command/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/shebang-regex@3.0.0/node_modules/shebang-regex/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/shebang-regex@3.0.0/node_modules/shebang-regex/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/siginfo@2.0.0/node_modules/siginfo/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/siginfo@2.0.0/node_modules/siginfo/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/signal-exit@4.1.0/node_modules/signal-exit/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/signal-exit@4.1.0/node_modules/signal-exit/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/stackback@0.0.2/node_modules/stackback/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/stackback@0.0.2/node_modules/stackback/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/std-env@3.10.0/node_modules/std-env/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/std-env@3.10.0/node_modules/std-env/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/string-width@4.2.3/node_modules/string-width/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/string-width@4.2.3/node_modules/string-width/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/string-width@5.1.2/node_modules/string-width/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/string-width@5.1.2/node_modules/string-width/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/strip-ansi@6.0.1/node_modules/strip-ansi/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/strip-ansi@6.0.1/node_modules/strip-ansi/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/strip-ansi@7.2.0/node_modules/strip-ansi/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/strip-ansi@7.2.0/node_modules/strip-ansi/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/strip-literal@3.1.0/node_modules/strip-literal/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/strip-literal@3.1.0/node_modules/strip-literal/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/readme.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/readme.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/test-exclude@7.0.2/node_modules/test-exclude/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/test-exclude@7.0.2/node_modules/test-exclude/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/tinybench@2.9.0/node_modules/tinybench/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/tinybench@2.9.0/node_modules/tinybench/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/tinyexec@0.3.2/node_modules/tinyexec/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/tinyexec@0.3.2/node_modules/tinyexec/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/tinyglobby@0.2.17/node_modules/tinyglobby/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/tinyglobby@0.2.17/node_modules/tinyglobby/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/tinyrainbow@2.0.0/node_modules/tinyrainbow/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/tinyrainbow@2.0.0/node_modules/tinyrainbow/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/tinyspy@4.0.4/node_modules/tinyspy/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/SECURITY.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/SECURITY.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/undici-types@7.18.2/node_modules/undici-types/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/undici-types@7.18.2/node_modules/undici-types/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/vite-node@3.2.4_@types+node@24.13.2/node_modules/vite-node/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/vite-node@3.2.4_@types+node@24.13.2/node_modules/vite-node/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/vite@7.3.5_@types+node@24.13.2/node_modules/vite/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/LICENSE.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/LICENSE.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/vitest@3.2.6_@types+node@24.13.2/node_modules/vitest/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/which@2.0.2/node_modules/which/CHANGELOG.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/which@2.0.2/node_modules/which/CHANGELOG.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/which@2.0.2/node_modules/which/README.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/which@2.0.2/node_modules/which/README.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/why-is-node-running@2.3.0/node_modules/why-is-node-running/README.md no warping", () => {
    expect(
      readText(
        "node_modules/.pnpm/why-is-node-running@2.3.0/node_modules/why-is-node-running/README.md",
      ).toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/wrap-ansi@7.0.0/node_modules/wrap-ansi/readme.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/wrap-ansi@7.0.0/node_modules/wrap-ansi/readme.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("node_modules/.pnpm/wrap-ansi@8.1.0/node_modules/wrap-ansi/readme.md no warping", () => {
    expect(
      readText("node_modules/.pnpm/wrap-ansi@8.1.0/node_modules/wrap-ansi/readme.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("packages/core/src/content-contracts/standards/COVERAGE-MAP.md no warping", () => {
    expect(
      readText("packages/core/src/content-contracts/standards/COVERAGE-MAP.md").toLowerCase(),
    ).not.toContain("warping");
  });
  it("patterns/executor-layer-credentials.md no warping", () => {
    expect(readText("patterns/executor-layer-credentials.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("patterns/llm-app.md no warping", () => {
    expect(readText("patterns/llm-app.md").toLowerCase()).not.toContain("warping");
  });
  it("patterns/multi-agent.md no warping", () => {
    expect(readText("patterns/multi-agent.md").toLowerCase()).not.toContain("warping");
  });
  it("patterns/prompt-assembly-layer-ordering.md no warping", () => {
    expect(readText("patterns/prompt-assembly-layer-ordering.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("patterns/role-as-overlay.md no warping", () => {
    expect(readText("patterns/role-as-overlay.md").toLowerCase()).not.toContain("warping");
  });
  it("platforms/2600.md no warping", () => {
    expect(readText("platforms/2600.md").toLowerCase()).not.toContain("warping");
  });
  it("platforms/unity.md no warping", () => {
    expect(readText("platforms/unity.md").toLowerCase()).not.toContain("warping");
  });
  it("references/composer-skill-porting.md no warping", () => {
    expect(readText("references/composer-skill-porting.md").toLowerCase()).not.toContain("warping");
  });
  it("references/cost-models.md no warping", () => {
    expect(readText("references/cost-models.md").toLowerCase()).not.toContain("warping");
  });
  it("references/ip-risk.md no warping", () => {
    expect(readText("references/ip-risk.md").toLowerCase()).not.toContain("warping");
  });
  it("references/plain-english-ux.md no warping", () => {
    expect(readText("references/plain-english-ux.md").toLowerCase()).not.toContain("warping");
  });
  it("resilience/context-pruning.md no warping", () => {
    expect(readText("resilience/context-pruning.md").toLowerCase()).not.toContain("warping");
  });
  it("resilience/continue-here.md no warping", () => {
    expect(readText("resilience/continue-here.md").toLowerCase()).not.toContain("warping");
  });
  it("scm/changelog.md no warping", () => {
    expect(readText("scm/changelog.md").toLowerCase()).not.toContain("warping");
  });
  it("scm/git.md no warping", () => {
    expect(readText("scm/git.md").toLowerCase()).not.toContain("warping");
  });
  it("scm/github.md no warping", () => {
    expect(readText("scm/github.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-build/SKILL.md no warping", () => {
    expect(readText("skills/deft-build/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-article-review/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-article-review/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-build/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-build/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-cost/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-cost/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-debug/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-debug/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-decompose/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-decompose/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-gh-arch/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-gh-arch/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-gh-slice/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-gh-slice/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-glossary/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-glossary/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-interview/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-interview/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-pre-pr/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-pre-pr/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-probe/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-probe/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-refinement/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-refinement/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-release/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-release/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-review-cycle/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-review-cycle/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-setup/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-setup/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-swarm/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-swarm/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-sync/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-sync/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-directive-triage/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-triage/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-directive-write-skill/SKILL.md no warping", () => {
    expect(readText("skills/deft-directive-write-skill/SKILL.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("skills/deft-interview/SKILL.md no warping", () => {
    expect(readText("skills/deft-interview/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-pre-pr/SKILL.md no warping", () => {
    expect(readText("skills/deft-pre-pr/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-review-cycle/SKILL.md no warping", () => {
    expect(readText("skills/deft-review-cycle/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-roadmap-refresh/SKILL.md no warping", () => {
    expect(readText("skills/deft-roadmap-refresh/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-setup/SKILL.md no warping", () => {
    expect(readText("skills/deft-setup/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-swarm/SKILL.md no warping", () => {
    expect(readText("skills/deft-swarm/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("skills/deft-sync/SKILL.md no warping", () => {
    expect(readText("skills/deft-sync/SKILL.md").toLowerCase()).not.toContain("warping");
  });
  it("specs/strategy-chaining/SPECIFICATION.md no warping", () => {
    expect(readText("specs/strategy-chaining/SPECIFICATION.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("specs/testbed/SPECIFICATION.md no warping", () => {
    expect(readText("specs/testbed/SPECIFICATION.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/README.md no warping", () => {
    expect(readText("strategies/README.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/artifact-guards.md no warping", () => {
    expect(readText("strategies/artifact-guards.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/bdd.md no warping", () => {
    expect(readText("strategies/bdd.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/brownfield.md no warping", () => {
    expect(readText("strategies/brownfield.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/discuss.md no warping", () => {
    expect(readText("strategies/discuss.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/emit-hints.md no warping", () => {
    expect(readText("strategies/emit-hints.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/enterprise.md no warping", () => {
    expect(readText("strategies/enterprise.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/interview.md no warping", () => {
    expect(readText("strategies/interview.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/map.md no warping", () => {
    expect(readText("strategies/map.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/probe.md no warping", () => {
    expect(readText("strategies/probe.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/rapid.md no warping", () => {
    expect(readText("strategies/rapid.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/research.md no warping", () => {
    expect(readText("strategies/research.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/roadmap.md no warping", () => {
    expect(readText("strategies/roadmap.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/speckit.md no warping", () => {
    expect(readText("strategies/speckit.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/v0-20-contract.md no warping", () => {
    expect(readText("strategies/v0-20-contract.md").toLowerCase()).not.toContain("warping");
  });
  it("strategies/yolo.md no warping", () => {
    expect(readText("strategies/yolo.md").toLowerCase()).not.toContain("warping");
  });
  it("swarm/swarm.md no warping", () => {
    expect(readText("swarm/swarm.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/COST-ESTIMATE.md no warping", () => {
    expect(readText("templates/COST-ESTIMATE.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/PULL_REQUEST_TEMPLATE.md no warping", () => {
    expect(readText("templates/PULL_REQUEST_TEMPLATE.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/agent-prompt-preamble.md no warping", () => {
    expect(readText("templates/agent-prompt-preamble.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/agents-entry.md no warping", () => {
    expect(readText("templates/agents-entry.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/agents-entry.placeholders.md no warping", () => {
    expect(readText("templates/agents-entry.placeholders.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("templates/make-spec-example.md no warping", () => {
    expect(readText("templates/make-spec-example.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/make-spec.md no warping", () => {
    expect(readText("templates/make-spec.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/specification.md no warping", () => {
    expect(readText("templates/specification.md").toLowerCase()).not.toContain("warping");
  });
  it("templates/swarm-greptile-poller-prompt.md no warping", () => {
    expect(readText("templates/swarm-greptile-poller-prompt.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("tools/RWLDL.md no warping", () => {
    expect(readText("tools/RWLDL.md").toLowerCase()).not.toContain("warping");
  });
  it("tools/greptile.md no warping", () => {
    expect(readText("tools/greptile.md").toLowerCase()).not.toContain("warping");
  });
  it("tools/installer.md no warping", () => {
    expect(readText("tools/installer.md").toLowerCase()).not.toContain("warping");
  });
  it("tools/taskfile-migration.md no warping", () => {
    expect(readText("tools/taskfile-migration.md").toLowerCase()).not.toContain("warping");
  });
  it("tools/taskfile.md no warping", () => {
    expect(readText("tools/taskfile.md").toLowerCase()).not.toContain("warping");
  });
  it("tools/telemetry.md no warping", () => {
    expect(readText("tools/telemetry.md").toLowerCase()).not.toContain("warping");
  });
  it("vbrief/.eval/README.md no warping", () => {
    expect(readText("vbrief/.eval/README.md").toLowerCase()).not.toContain("warping");
  });
  it("vbrief/.eval/_tmp_976_body_after.md no warping", () => {
    expect(readText("vbrief/.eval/_tmp_976_body_after.md").toLowerCase()).not.toContain("warping");
  });
  it("vbrief/.eval/_tmp_976_body_before.md no warping", () => {
    expect(readText("vbrief/.eval/_tmp_976_body_before.md").toLowerCase()).not.toContain("warping");
  });
  it("vbrief/.eval/_tmp_985_body_after_pairing.md no warping", () => {
    expect(readText("vbrief/.eval/_tmp_985_body_after_pairing.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("vbrief/.eval/_tmp_985_body_before_pairing.md no warping", () => {
    expect(readText("vbrief/.eval/_tmp_985_body_before_pairing.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("vbrief/.eval/_tmp_988_body_after_pairing.md no warping", () => {
    expect(readText("vbrief/.eval/_tmp_988_body_after_pairing.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("vbrief/.eval/_tmp_988_body_before_pairing.md no warping", () => {
    expect(readText("vbrief/.eval/_tmp_988_body_before_pairing.md").toLowerCase()).not.toContain(
      "warping",
    );
  });
  it("vbrief/vbrief.md no warping", () => {
    expect(readText("vbrief/vbrief.md").toLowerCase()).not.toContain("warping");
  });
  it("verification/integration.md no warping", () => {
    expect(readText("verification/integration.md").toLowerCase()).not.toContain("warping");
  });
  it("verification/plan-checking.md no warping", () => {
    expect(readText("verification/plan-checking.md").toLowerCase()).not.toContain("warping");
  });
  it("verification/uat.md no warping", () => {
    expect(readText("verification/uat.md").toLowerCase()).not.toContain("warping");
  });
  it("verification/verification.md no warping", () => {
    expect(readText("verification/verification.md").toLowerCase()).not.toContain("warping");
  });
  it("body_file_os_temp_dir_guidance", () => {
    const text = readText("scm/github.md");
    expect(text).toContain("GetTempFileName");
    expect(text).toContain("mktemp");
  });
});
