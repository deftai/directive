import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@deftai/directive-core/dist/doctor/main.js", () => ({
  cmdDoctor: vi.fn(() => 0),
}));

import { cmdDoctor } from "@deftai/directive-core/dist/doctor/main.js";
import { renderStrayPackagesAdvisoryLine, run } from "./doctor.js";

const LIFECYCLE_FOLDERS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

function makeLifecycleDirs(
  projectRoot: string,
  folders: readonly string[] = LIFECYCLE_FOLDERS,
): void {
  for (const folder of folders) {
    mkdirSync(join(projectRoot, "vbrief", folder), { recursive: true });
  }
}

const createdRoots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

function captureStdout(fn: () => void): string {
  let captured = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return captured;
}

afterEach(() => {
  vi.clearAllMocks();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("doctor CLI", () => {
  it("delegates argv to cmdDoctor", () => {
    captureStdout(() => {
      expect(run(["--full", "--json"])).toBe(0);
    });
    expect(cmdDoctor).toHaveBeenCalledWith(["--full", "--json"]);
  });

  it("suppresses the precutover line under --json so JSON output stays valid", () => {
    const root = makeRoot("doctor-json-");
    makeLifecycleDirs(root);
    const out = captureStdout(() => {
      expect(run(["--json", "--project-root", root])).toBe(0);
    });
    expect(out).toBe("");
    expect(cmdDoctor).toHaveBeenCalledWith(["--json", "--project-root", root]);
  });

  it("suppresses the precutover line for an invalid invocation (unknown flag)", () => {
    const out = captureStdout(() => {
      run(["--not-a-real-flag"]);
    });
    expect(out).toBe("");
    expect(cmdDoctor).toHaveBeenCalledWith(["--not-a-real-flag"]);
  });

  it("suppresses the precutover line for --help", () => {
    const out = captureStdout(() => {
      run(["--help"]);
    });
    expect(out).toBe("");
    expect(cmdDoctor).toHaveBeenCalledWith(["--help"]);
  });

  it("flags the migration-needed state for a pre-cutover project fixture", () => {
    const root = makeRoot("doctor-precut-");
    makeLifecycleDirs(root);
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "# Project Specification\n\nHand-authored legacy spec.\n",
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Pre-cutover: migration needed");
    expect(out).toContain("SPECIFICATION.md");
    expect(out).toContain("v0.59.0");
  });

  it("reports a clean non-pre-cutover state for a current-layout project fixture", () => {
    const root = makeRoot("doctor-current-");
    for (const folder of LIFECYCLE_FOLDERS) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Current", status: "running", items: [] },
      }),
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Pre-cutover: none");
    expect(out).toContain("current vBRIEF document model");
    expect(out).not.toContain("migration needed");
    expect(out).toContain("xBrief migration: none");
  });

  it("flags a pre-cutover PROJECT.md and missing lifecycle folders", () => {
    const root = makeRoot("doctor-project-md-");
    // Only a subset of lifecycle folders -> missing-folder reason fires.
    makeLifecycleDirs(root, ["proposed", "active"]);
    writeFileSync(join(root, "PROJECT.md"), "# Project\n\nLegacy project doc.\n", "utf8");
    const out = captureStdout(() => {
      run([`--project-root=${root}`]);
    });
    expect(out).toContain("Pre-cutover: migration needed");
    expect(out).toContain("PROJECT.md");
    expect(out).toContain("missing lifecycle folder");
  });

  it("treats deprecation-redirect root docs as already migrated", () => {
    const root = makeRoot("doctor-redirect-");
    makeLifecycleDirs(root);
    const redirect = "<!-- deft:deprecated-redirect -->\n# Deprecated\n";
    writeFileSync(join(root, "SPECIFICATION.md"), redirect, "utf8");
    writeFileSync(join(root, "PROJECT.md"), redirect, "utf8");
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Pre-cutover: none");
  });

  it("treats a current generated SPECIFICATION export as already migrated", () => {
    const root = makeRoot("doctor-generated-");
    makeLifecycleDirs(root);
    writeFileSync(
      join(root, "vbrief", "specification.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { title: "Spec", items: [] } }),
      "utf8",
    );
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\n# Spec\n",
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Pre-cutover: none");
  });

  it("flags legacy vbrief layout with migrate:xbrief guidance (#2110)", () => {
    const root = makeRoot("doctor-xbrief-legacy-");
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "story.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6", description: "fixture" },
        plan: { title: "Legacy", status: "running", items: [] },
      }),
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("xBrief migration: legacy vbrief layout detected");
    expect(out).toContain("migrate:xbrief");
  });

  it("signposts a half-migrated AGENTS.md header (xbrief tree + vbrief header) (#2154)", () => {
    const root = makeRoot("doctor-header-drift-");
    for (const folder of LIFECYCLE_FOLDERS) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        "# Consumer",
        "## Lifecycle",
        "- `task vbrief:preflight -- vbrief/active/foo.vbrief.json`",
        "",
        "<!-- deft:managed-section v3 -->",
        "managed body",
        "<!-- /deft:managed-section -->",
        "",
      ].join("\n"),
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("AGENTS.md header drift:");
    expect(out).toContain("migrate:xbrief");
    expect(out).toContain("vbrief/");
  });

  it("reports no AGENTS.md header drift for a clean xbrief header (#2154)", () => {
    const root = makeRoot("doctor-header-clean-");
    for (const folder of LIFECYCLE_FOLDERS) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(join(root, "AGENTS.md"), "# Consumer\nAll on xbrief/ now.\n", "utf8");
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("AGENTS.md header drift: none");
  });

  it("reports clean deposit hygiene when .deft/core has no packages/ (#2142)", () => {
    const root = makeRoot("doctor-deposit-clean-");
    makeLifecycleDirs(root);
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Deposit hygiene: none");
    expect(renderStrayPackagesAdvisoryLine(root)).toContain("Deposit hygiene: none");
  });

  it("flags stray packages/ under .deft/core (#2142)", () => {
    const root = makeRoot("doctor-stray-packages-");
    makeLifecycleDirs(root);
    mkdirSync(join(root, ".deft", "core", "packages", "cli"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "packages", "cli", "package.json"), "{}\n", "utf8");
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Deposit hygiene: advisory");
    expect(out).toContain(".deft/core/packages/");
    expect(renderStrayPackagesAdvisoryLine(root)).toContain("advisory");
  });

  it("defaults projectRoot to process.cwd() when --project-root is omitted", () => {
    // Exercises the `flags.projectRoot ?? process.cwd()` false branch in doctor.ts.
    const out = captureStdout(() => {
      run([]);
    });
    // The pre-cutover and migration lines are rendered using process.cwd().
    // We only assert that both lines were emitted (not their exact content,
    // since process.cwd() varies by environment).
    expect(out).toContain("Pre-cutover:");
    expect(out).toContain("xBrief migration:");
    expect(out).toContain("Deposit hygiene:");
  });
});
