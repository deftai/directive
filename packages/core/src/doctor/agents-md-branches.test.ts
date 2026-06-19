import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "deadbeef1234\n" })),
}));

import { agentsRefreshPlan } from "./agents-md.js";
import { checkInstallPathConsistency } from "./checks.js";
import { includesBlockHasDeftTaskfile } from "./taskfile.js";

describe("agents-md git integration", () => {
  it("resolves framework sha via git by default", () => {
    const rendered = "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->";
    const plan = agentsRefreshPlan("/tmp", {
      readTemplate: () => rendered,
      readAgents: () => null,
      nowIso: () => "2026-01-01T00:00:00Z",
      newSession: () => "abcd1234efgh",
    });
    expect(plan.state).toBe("absent");
    expect(plan.sha).toBe("deadbeef1234");
  });
});

describe("taskfile re-entry", () => {
  it("finds include after closing prior block", () => {
    const yaml =
      "includes:\n  other:\n    taskfile: ./other.yml\n\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n    optional: true\n";
    expect(includesBlockHasDeftTaskfile(yaml)).toBe(true);
  });
});

describe("install path manifest root", () => {
  it("prefers manifest install_root field", () => {
    const result = checkInstallPathConsistency("/tmp", ".deft/core", {
      isDir: (p) => p.endsWith("custom/core"),
      readText: () => "install_root: custom/core\n",
    });
    expect(result.status).toBe("pass");
    expect(result.data?.effective_install_root_source).toBe("manifest");
  });
});
