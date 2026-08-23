import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@deftai/directive-core/dist/doctor/main.js", () => ({
  cmdDoctor: vi.fn(() => 0),
}));

import { cmdDoctor } from "@deftai/directive-core/dist/doctor/main.js";
import { evaluateDepositFileSetHygiene, renderDepositFileSetHygieneLine, run } from "./doctor.js";

const LIFECYCLE_FOLDERS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

function makeLifecycleDirs(
  projectRoot: string,
  folders: readonly string[] = LIFECYCLE_FOLDERS,
): void {
  for (const folder of folders) {
    mkdirSync(join(projectRoot, "xbrief", folder), { recursive: true });
  }
  // Seed a minimal .xbrief.json so resolveLifecycleLayout can resolve the tree (#2112).
  writeFileSync(
    join(projectRoot, "xbrief", "active", "seed.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "seed" },
      plan: { title: "Seed", status: "running", items: [] },
    }),
    "utf8",
  );
}

const createdRoots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

function seedContentPackage(
  projectRoot: string,
  files: Record<string, string> = { "main.md": "# Deft\n" },
): string {
  const contentRoot = join(projectRoot, "node_modules", "@deftai", "directive-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(
    join(contentRoot, "package.json"),
    JSON.stringify({ name: "@deftai/directive-content", version: "0.84.0" }),
    "utf8",
  );
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(contentRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return contentRoot;
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
    // Only vbrief dirs, no xbrief layout -- resolver throws, doctor reports layout missing.
    mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "PROJECT.md"), "# Project\n\nLegacy project doc.\n", "utf8");
    const out = captureStdout(() => {
      run([`--project-root=${root}`]);
    });
    expect(out).toContain("Pre-cutover: migration needed");
    expect(out).toContain("PROJECT.md");
    expect(out).toContain("xbrief/ lifecycle layout not found");
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

  it("treats a current generated xbrief SPECIFICATION export as already migrated (#2112)", () => {
    const root = makeRoot("doctor-generated-");
    for (const folder of LIFECYCLE_FOLDERS) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "Spec", status: "running", items: [] },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: xbrief/specification.xbrief.json -->\n# Spec\n",
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Pre-cutover: none");
  });

  it("treats an xbrief generated SPECIFICATION export as already migrated (#2205)", () => {
    const root = makeRoot("doctor-xbrief-generated-");
    for (const folder of LIFECYCLE_FOLDERS) {
      mkdirSync(join(root, "xbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "xbrief", "specification.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "Spec", status: "running", items: [] },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "Project", status: "running", items: [] },
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- AUTO-GENERATED by task spec:render -->\n" +
        "<!-- Purpose: rendered specification -->\n" +
        "<!-- Source of truth: xbrief/specification.xbrief.json -->\n# Spec\n",
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Pre-cutover: none");
    expect(out).not.toContain("migration needed");
    expect(out).toContain("xBrief migration: none");
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
    expect(out).toContain("xBrief migration: migrate required");
    expect(out).toContain("only vbrief/ found");
    expect(out).toContain("migrate:xbrief");
  });

  it("signposts a half-migrated AGENTS.md header (xbrief tree + vbrief header) (#2154)", () => {
    const root = makeRoot("doctor-header-drift-");
    makeLifecycleDirs(root);
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
    expect(out).toMatch(/hand-edit/i);
    expect(out).not.toContain("migrate:xbrief");
    expect(out).toContain("vbrief/");
  });

  it("allows unmanaged prose `vbrief/` on an already-xbrief tree (#3637)", () => {
    const root = makeRoot("doctor-header-bare-vbrief-");
    makeLifecycleDirs(root);
    writeFileSync(
      join(root, "AGENTS.md"),
      ["# Consumer", "Scoped work items live in `vbrief/`.", ""].join("\n"),
      "utf8",
    );
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("AGENTS.md header drift: none");
  });

  it("reports no AGENTS.md header drift for a clean xbrief header (#2154)", () => {
    const root = makeRoot("doctor-header-clean-");
    makeLifecycleDirs(root);
    writeFileSync(join(root, "AGENTS.md"), "# Consumer\nAll on xbrief/ now.\n", "utf8");
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("AGENTS.md header drift: none");
  });

  it("reports clean deposit hygiene when .deft/core matches the content package (#2804)", () => {
    const root = makeRoot("doctor-deposit-clean-");
    makeLifecycleDirs(root);
    seedContentPackage(root);
    const deftDir = join(root, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(join(deftDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(join(deftDir, "VERSION"), "v0.84.0\n", "utf8");
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Deposit hygiene: none");
    expect(out).toContain("matches @deftai/directive-content");
    expect(renderDepositFileSetHygieneLine(root)).toContain("Deposit hygiene: none");
  });

  it("flags package-absent bridge leftovers under .deft/core (#2804)", () => {
    const root = makeRoot("doctor-package-absent-");
    makeLifecycleDirs(root);
    seedContentPackage(root);
    mkdirSync(join(root, ".deft", "core", "cmd", "deft-install"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "cmd", "deft-install", "main.go"),
      "package main\n",
      "utf8",
    );
    writeFileSync(join(root, ".deft", "core", "main.md"), "# Deft\n", "utf8");
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Deposit hygiene: fail");
    expect(out).toContain("cmd/deft-install/main.go");
    expect(renderDepositFileSetHygieneLine(root)).toContain("directive update");
    expect(renderDepositFileSetHygieneLine(root)).toContain("#2804");
  });

  it("returns exit 1 on --full when package-absent deposit files remain (#2804)", () => {
    const root = makeRoot("doctor-full-fail-");
    makeLifecycleDirs(root);
    seedContentPackage(root);
    mkdirSync(join(root, ".deft", "core", "cmd", "deft-install"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "core", "cmd", "deft-install", "main.go"),
      "package main\n",
      "utf8",
    );
    captureStdout(() => {
      expect(run(["--full", "--project-root", root])).toBe(1);
    });
  });

  it("flags stray packages/ under .deft/core (#2142 / #2804)", () => {
    const root = makeRoot("doctor-stray-packages-");
    makeLifecycleDirs(root);
    seedContentPackage(root);
    mkdirSync(join(root, ".deft", "core", "packages", "cli"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "packages", "cli", "package.json"), "{}\n", "utf8");
    const out = captureStdout(() => {
      run(["--project-root", root]);
    });
    expect(out).toContain("Deposit hygiene: fail");
    expect(out).toContain("packages/cli/package.json");
    expect(renderDepositFileSetHygieneLine(root)).toContain("fail");
  });

  it("names `directive update` as the remediation for package-absent deposit files (#2804)", () => {
    const root = makeRoot("doctor-stray-remediation-");
    makeLifecycleDirs(root);
    seedContentPackage(root);
    mkdirSync(join(root, ".deft", "core", "packages"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "packages", "stale.txt"), "stale\n", "utf8");
    const advisory = renderDepositFileSetHygieneLine(root);
    expect(advisory).toContain("directive update");
    expect(advisory).toContain("#2804");
  });

  it("evaluates package-absent deposit files against an explicit content root in tests", () => {
    const root = makeRoot("doctor-eval-explicit-");
    const contentRoot = join(root, "content-pkg");
    const deftDir = join(root, ".deft", "core");
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, "main.md"), "# Deft\n", "utf8");
    mkdirSync(join(deftDir, "legacy", "vbrief"), { recursive: true });
    writeFileSync(join(deftDir, "legacy", "vbrief", "old.md"), "stale\n", "utf8");
    writeFileSync(join(deftDir, "VERSION"), "v0.84.0\n", "utf8");

    const result = evaluateDepositFileSetHygiene(root, { contentRoot });
    expect(result.absent).toEqual(["legacy/vbrief/old.md"]);
    expect(renderDepositFileSetHygieneLine(root, result)).toContain("legacy/vbrief/old.md");
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
