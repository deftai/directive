import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSUMER_HEADER_PLACEHOLDER_ONELINER } from "../platform/agents-consumer-header.js";
import { evaluateConsumerHeaderPlaceholderAtRoot } from "./consumer-header-placeholder.js";
import {
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
    const stalePass = evaluateConsumerHeaderPlaceholderAtRoot(staleLease);
    expect(stalePass.ok).toBe(true);
    expect(stalePass.reason).toBe("process-only");

    const processOnly = tempRoot();
    writeFileSync(
      join(processOnly, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const pass = evaluateConsumerHeaderPlaceholderAtRoot(processOnly);
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
