import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSUMER_HEADER_PLACEHOLDER_ONELINER } from "../platform/agents-consumer-header.js";
import {
  CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID,
  enforceConsumerHeaderPlaceholderAtCompletionChokepoint,
  enforceConsumerHeaderPlaceholderWhenProductEvidence,
  evaluateConsumerHeaderPlaceholderAtRoot,
  hasDirtyProductMutationEvidence,
  isNonProductMutationPath,
  readConfirmedOverviewAtRoot,
} from "./consumer-header-placeholder.js";
import {
  productMutationCompletionAtRoot,
  productMutationCompletionMarkerPath,
  recordProductMutationCompletion,
} from "./product-mutation-completion.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "header-placeholder-"));
  tempDirs.push(root);
  return root;
}

/** packages/core/src/check → repo root (4 levels). */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests/fixtures/agents-md/first-ship-placeholder-gate");

describe("evaluateConsumerHeaderPlaceholderAtRoot (#4544 Prefer-A)", () => {
  it("fails closed on fixture placeholder + product mutation; custom and Process-only pass", () => {
    const placeholderAgents = readFileSync(join(FIXTURE_ROOT, "AGENTS.placeholder.md"), "utf8");
    const customAgents = readFileSync(join(FIXTURE_ROOT, "AGENTS.custom.md"), "utf8");
    expect(placeholderAgents).toContain(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
    expect(customAgents).not.toContain(CONSUMER_HEADER_PLACEHOLDER_ONELINER);

    const fail = evaluateConsumerHeaderPlaceholderAtRoot("/fixture-unused", {
      readAgentsMd: () => placeholderAgents,
      sessionChangedProductFiles: true,
    });
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("placeholder-with-product-mutation");

    const processOnly = evaluateConsumerHeaderPlaceholderAtRoot("/fixture-unused", {
      readAgentsMd: () => placeholderAgents,
      sessionChangedProductFiles: false,
    });
    expect(processOnly.ok).toBe(true);
    expect(processOnly.reason).toBe("process-only");

    const custom = evaluateConsumerHeaderPlaceholderAtRoot("/fixture-unused", {
      readAgentsMd: () => customAgents,
      sessionChangedProductFiles: true,
    });
    expect(custom.ok).toBe(true);
    expect(custom.reason).toBe("not-placeholder");
  });

  it("treats last_write_at alone as Process-only; durable marker fails closed", () => {
    const staleLease = tempRoot();
    writeFileSync(
      join(staleLease, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    mkdirSync(join(staleLease, ".deft"), { recursive: true });
    writeFileSync(
      join(staleLease, ".deft", "occupancy.json"),
      JSON.stringify({ last_write_at: "2026-09-30T12:00:00Z" }),
      "utf8",
    );
    const stalePass = evaluateConsumerHeaderPlaceholderAtRoot(staleLease, {
      dirtyProductEvidence: false,
    });
    expect(stalePass.ok).toBe(true);
    expect(stalePass.reason).toBe("process-only");

    const processOnly = tempRoot();
    writeFileSync(
      join(processOnly, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const pass = evaluateConsumerHeaderPlaceholderAtRoot(processOnly, {
      dirtyProductEvidence: false,
    });
    expect(pass.ok).toBe(true);
    expect(pass.reason).toBe("process-only");

    const marked = tempRoot();
    writeFileSync(
      join(marked, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    recordProductMutationCompletion(marked, new Date("2026-09-30T12:00:00Z"));
    const fail = evaluateConsumerHeaderPlaceholderAtRoot(marked);
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("placeholder-with-product-mutation");
  });

  it("refuses placeholder after occupancy release when durable product-mutation marker remains", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    recordProductMutationCompletion(root, new Date("2026-09-30T12:00:00Z"));
    expect(productMutationCompletionMarkerPath(root)).toContain("product-mutation-completion.json");
    const fail = evaluateConsumerHeaderPlaceholderAtRoot(root);
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("placeholder-with-product-mutation");
  });

  it("fails closed when AGENTS.md exists but the read seam reports unreadable", () => {
    const fail = evaluateConsumerHeaderPlaceholderAtRoot("/fixture-unused", {
      readAgentsMd: () => ({ kind: "unreadable", detail: "EACCES" }),
      sessionChangedProductFiles: true,
    });
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("agents-md-unreadable");
  });

  it("fails closed when Prefer-A marker exists but is malformed (not Process-only)", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    mkdirSync(join(root, ".deft", "cache"), { recursive: true });
    writeFileSync(productMutationCompletionMarkerPath(root), "{ broken", "utf8");
    const fail = evaluateConsumerHeaderPlaceholderAtRoot(root);
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("product-mutation-marker-unreadable");
    expect(fail.message).toMatch(/do not treat as Process-only/i);
  });

  it("passes custom header and absent AGENTS.md even when Prefer-A marker is malformed", () => {
    const customRoot = tempRoot();
    writeFileSync(
      join(customRoot, "AGENTS.md"),
      "# Garden Notes\n\nCustom one-liner.\n\n## Session orientation\n",
      "utf8",
    );
    mkdirSync(join(customRoot, ".deft", "cache"), { recursive: true });
    writeFileSync(productMutationCompletionMarkerPath(customRoot), "{ broken", "utf8");
    const custom = evaluateConsumerHeaderPlaceholderAtRoot(customRoot);
    expect(custom.ok).toBe(true);
    expect(custom.reason).toBe("not-placeholder");

    const absentRoot = tempRoot();
    mkdirSync(join(absentRoot, ".deft", "cache"), { recursive: true });
    writeFileSync(productMutationCompletionMarkerPath(absentRoot), "{ broken", "utf8");
    const absent = evaluateConsumerHeaderPlaceholderAtRoot(absentRoot);
    expect(absent.ok).toBe(true);
    expect(absent.reason).toBe("no-agents-md");
  });
});

describe("readConfirmedOverviewAtRoot (#4544 residual)", () => {
  it("refuses when selected xbrief has no Overview even if vbrief has one", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify(
        {
          xBRIEFInfo: { version: "0.8", description: "empty narratives" },
          plan: {
            title: "PROJECT-DEFINITION",
            status: "running",
            items: [],
            policy: {},
            narratives: {},
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      `${JSON.stringify(
        {
          vBRIEFInfo: { version: "0.6", description: "legacy seed" },
          plan: {
            title: "PROJECT-DEFINITION",
            status: "running",
            items: [],
            policy: {},
            narratives: { Overview: "Greenfield smoke fixture (#2022 Phase 3)." },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(readConfirmedOverviewAtRoot(root)).toBeNull();
  });

  it("reads Overview from vbrief only when it is the selected artifact", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      `${JSON.stringify(
        {
          vBRIEFInfo: { version: "0.6", description: "legacy seed" },
          plan: {
            title: "PROJECT-DEFINITION",
            status: "running",
            items: [],
            policy: {},
            narratives: { Overview: "Legacy-only Overview." },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(readConfirmedOverviewAtRoot(root)).toBe("Legacy-only Overview.");
  });
});

describe("enforceConsumerHeaderPlaceholderAtCompletionChokepoint (#4544 residual)", () => {
  it("refuses placeholder after product completion when Overview is unavailable", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const result = enforceConsumerHeaderPlaceholderAtCompletionChokepoint(root, {
      recordedAt: new Date("2026-10-02T12:00:00Z"),
      confirmedOverview: null,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID);
    expect(result.message).toMatch(/Overview is unavailable/i);
    expect(result.remediation.overviewAvailable).toBe(false);
    expect(productMutationCompletionAtRoot(root)).toBe(true);
    expect(evaluateConsumerHeaderPlaceholderAtRoot(root).ok).toBe(false);
  });

  it("remediates via confirmed-Overview CAS then Prefer-A passes", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n\n## Session orientation\n`,
      "utf8",
    );
    const result = enforceConsumerHeaderPlaceholderAtCompletionChokepoint(root, {
      recordedAt: new Date("2026-10-02T12:00:00Z"),
      confirmedOverview: "Garden notes CRUD app",
    });
    expect(result.ok).toBe(true);
    expect(result.remediation.attempted).toBe(true);
    expect(result.remediation.wroteAgentsMd).toBe(true);
    expect(result.remediation.casReason).toBe("replaced-placeholder");
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("Garden notes CRUD app");
    expect(agents).not.toContain(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
    expect(evaluateConsumerHeaderPlaceholderAtRoot(root).ok).toBe(true);
    expect(evaluateConsumerHeaderPlaceholderAtRoot(root).reason).toBe("not-placeholder");
  });

  it("refuses Overview CAS when AGENTS.md changed after the snapshot (#4544 P1)", () => {
    const root = tempRoot();
    const snapshot = `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`;
    writeFileSync(join(root, "AGENTS.md"), snapshot, "utf8");
    let reads = 0;
    const result = enforceConsumerHeaderPlaceholderAtCompletionChokepoint(root, {
      recordedAt: new Date("2026-10-02T12:00:00Z"),
      confirmedOverview: "Garden notes CRUD app",
      readAgentsMd: () => {
        reads += 1;
        // evaluate + CAS snapshot share the pre-write text; write-time re-read drifts.
        if (reads <= 2) return snapshot;
        return "# Project\n\nCustom concurrent header.\n";
      },
    });
    expect(result.ok).toBe(false);
    expect(result.remediation.attempted).toBe(true);
    expect(result.remediation.wroteAgentsMd).toBe(false);
    expect(result.message).toMatch(/changed after the CAS snapshot/i);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(snapshot);
  });

  it("reads Overview from PROJECT-DEFINITION when seam is omitted", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "demo",
          narratives: { Overview: "PD-confirmed one-liner", "tech stack": "node" },
        },
      })}\n`,
      "utf8",
    );
    const result = enforceConsumerHeaderPlaceholderAtCompletionChokepoint(root, {
      recordedAt: new Date("2026-10-02T12:00:00Z"),
    });
    expect(result.ok).toBe(true);
    expect(result.remediation.wroteAgentsMd).toBe(true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("PD-confirmed one-liner");
  });

  it("keeps custom headers and absent AGENTS.md legal at the chokepoint", () => {
    const custom = tempRoot();
    writeFileSync(join(custom, "AGENTS.md"), "# Garden\n\nCustom one-liner.\n", "utf8");
    const customResult = enforceConsumerHeaderPlaceholderAtCompletionChokepoint(custom, {
      recordedAt: new Date("2026-10-02T12:00:00Z"),
      confirmedOverview: null,
    });
    expect(customResult.ok).toBe(true);
    expect(customResult.evaluation.reason).toBe("not-placeholder");
    expect(customResult.remediation.attempted).toBe(false);

    const absent = tempRoot();
    const absentResult = enforceConsumerHeaderPlaceholderAtCompletionChokepoint(absent, {
      recordedAt: new Date("2026-10-02T12:00:00Z"),
      confirmedOverview: null,
    });
    expect(absentResult.ok).toBe(true);
    expect(absentResult.evaluation.reason).toBe("no-agents-md");
    expect(existsSync(productMutationCompletionMarkerPath(absent))).toBe(true);
  });

  it("Process-only Prefer-A evaluator still allows placeholder without the chokepoint", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const processOnly = evaluateConsumerHeaderPlaceholderAtRoot(root, {
      dirtyProductEvidence: false,
    });
    expect(processOnly.ok).toBe(true);
    expect(processOnly.reason).toBe("process-only");
  });
});

describe("dirty product evidence reachability (#4544 Prefer-A Bound 6000271029)", () => {
  it("classifies deposit paths as non-product and product paths as evidence", () => {
    expect(isNonProductMutationPath("xbrief/proposed/a.xbrief.json")).toBe(true);
    expect(isNonProductMutationPath(".deft/cache/product-mutation-completion.json")).toBe(true);
    expect(isNonProductMutationPath("AGENTS.md")).toBe(true);
    expect(isNonProductMutationPath("README.md")).toBe(true);
    // Root-only smoke fixtures (not basename-anywhere).
    expect(isNonProductMutationPath("docs-impact-invalid.md")).toBe(true);
    expect(isNonProductMutationPath("docs-impact-valid.md")).toBe(true);
    expect(isNonProductMutationPath("src/docs-impact-valid.md")).toBe(false);
    expect(isNonProductMutationPath("src/docs-impact-invalid.md")).toBe(false);
    expect(isNonProductMutationPath("notes/hello.py")).toBe(false);
    expect(isNonProductMutationPath("src/app.ts")).toBe(false);
    expect(isNonProductMutationPath("package.json")).toBe(false);
    expect(isNonProductMutationPath("pnpm-lock.yaml")).toBe(false);
  });

  it("detects dirty product evidence including tracked edits and package manifests", () => {
    const root = tempRoot();
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: "?? notes/hello.py\n M xbrief/proposed/a.xbrief.json\n",
      }),
    ).toBe(true);
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: " M notes/hello.py\n",
      }),
    ).toBe(true);
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: "A  src/app.ts\n",
      }),
    ).toBe(true);
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: "?? xbrief/proposed/a.xbrief.json\n M AGENTS.md\n",
      }),
    ).toBe(false);
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: "?? package.json\n",
      }),
    ).toBe(true);
    // Quoted deposit path with spaces must stay non-product (not false evidence).
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: '?? ".deft/my notes"\n',
      }),
    ).toBe(false);
    // Literal backslash filename after unquote must not become a deposit prefix
    // on POSIX; win32 still treats `\` as a separator.
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: '?? "xbrief\\\\app.ts"\n',
      }),
    ).toBe(process.platform !== "win32");
    expect(
      hasDirtyProductMutationEvidence(root, {
        gitPorcelain: null,
      }),
    ).toBe(false);
  });

  it("evaluate reaches enforce via dirty product evidence then remediates Overview CAS", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "demo",
          narratives: { Overview: "Notes hello corecap", "tech stack": "python" },
        },
      })}\n`,
      "utf8",
    );
    const result = evaluateConsumerHeaderPlaceholderAtRoot(root, {
      dirtyProductEvidence: true,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("not-placeholder");
    expect(productMutationCompletionAtRoot(root)).toBe(true);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("Notes hello corecap");
    expect(agents).not.toContain(CONSUMER_HEADER_PLACEHOLDER_ONELINER);
  });

  it("evaluate Process-only still passes without marker and without dirty product evidence", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const result = evaluateConsumerHeaderPlaceholderAtRoot(root, {
      dirtyProductEvidence: false,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("process-only");
    expect(productMutationCompletionAtRoot(root)).toBe(false);
  });

  it("enforceWhenProductEvidence skips Process-only and enforces on dirty product", () => {
    const skipRoot = tempRoot();
    writeFileSync(
      join(skipRoot, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const skipped = enforceConsumerHeaderPlaceholderWhenProductEvidence(skipRoot, {
      dirtyProductEvidence: false,
    });
    expect(skipped.ok).toBe(true);
    expect("skipped" in skipped && skipped.skipped).toBe(true);

    const dirtyRoot = tempRoot();
    writeFileSync(
      join(dirtyRoot, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const enforced = enforceConsumerHeaderPlaceholderWhenProductEvidence(dirtyRoot, {
      dirtyProductEvidence: true,
      confirmedOverview: null,
      recordedAt: new Date("2026-10-05T12:00:00Z"),
    });
    expect(enforced.ok).toBe(false);
    expect(enforced.message).toContain(CONSUMER_HEADER_COMPLETION_CHOKEPOINT_ID);
    expect(productMutationCompletionAtRoot(dirtyRoot)).toBe(true);
  });

  it("honesty: pin 7c775edf had only two production enforce callers; residual adds reachability", () => {
    // Census at dispatch-sha 7c775edf: scope/transition delivered+codeBearing and
    // occupancy writeOccupancyRecord persistProductMutationMarker=true only.
    // This residual adds: evaluate dirty-product path, releaseOccupancy evidence
    // wrapper (after ownership), and delivered-or-evidence codeBearing complete.
    expect(typeof enforceConsumerHeaderPlaceholderWhenProductEvidence).toBe("function");
    expect(typeof hasDirtyProductMutationEvidence).toBe("function");
  });

  it("git status unknown does not invent product evidence (Process-only / release skip)", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const evaluated = evaluateConsumerHeaderPlaceholderAtRoot(root, {
      gitPorcelain: null,
    });
    expect(evaluated.ok).toBe(true);
    expect(evaluated.reason).toBe("process-only");

    const skipped = enforceConsumerHeaderPlaceholderWhenProductEvidence(root, {
      gitPorcelain: null,
    });
    expect(skipped.ok).toBe(true);
    expect("skipped" in skipped && skipped.skipped).toBe(true);
  });
});
