import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_UNMANAGED_SOFT_MAX_LINES,
  FIELD_AGENTS_MD_ADVISORY_UNMANAGED_SOFT_MAX_LINES,
  resolveAgentsMdAdvisory,
} from "./agents-md-advisory.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(plan?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-advisory-policy-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief"), { recursive: true });
  if (plan !== undefined) {
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [], ...plan },
      }),
      "utf8",
    );
  }
  return root;
}

describe("resolveAgentsMdAdvisory", () => {
  it("returns the generous default when no PROJECT-DEFINITION exists", () => {
    const root = makeRepo();
    const result = resolveAgentsMdAdvisory(root);
    expect(result.config.unmanagedSoftMaxLines).toBe(DEFAULT_UNMANAGED_SOFT_MAX_LINES);
    expect(result.source).toBe("default-on-error");
    expect(result.error).not.toBeNull();
  });

  it("returns the generous default when the advisory field is unset", () => {
    const root = makeRepo({ policy: { wipCap: 10 } });
    const result = resolveAgentsMdAdvisory(root);
    expect(result.config.unmanagedSoftMaxLines).toBe(DEFAULT_UNMANAGED_SOFT_MAX_LINES);
    expect(result.source).toBe("default");
    expect(result.error).toBeNull();
  });

  it("reads the typed soft budget when configured", () => {
    const root = makeRepo({ policy: { agentsMdAdvisory: { unmanagedSoftMaxLines: 42 } } });
    const result = resolveAgentsMdAdvisory(root);
    expect(result.config.unmanagedSoftMaxLines).toBe(42);
    expect(result.source).toBe("typed");
  });

  it("degrades to the default when agentsMdAdvisory is not an object", () => {
    const root = makeRepo({ policy: { agentsMdAdvisory: 99 } });
    const result = resolveAgentsMdAdvisory(root);
    expect(result.config.unmanagedSoftMaxLines).toBe(DEFAULT_UNMANAGED_SOFT_MAX_LINES);
    expect(result.source).toBe("default-on-error");
  });

  it("treats an advisory object without the field as unset (default, no error)", () => {
    const root = makeRepo({ policy: { agentsMdAdvisory: {} } });
    const result = resolveAgentsMdAdvisory(root);
    expect(result.config.unmanagedSoftMaxLines).toBe(DEFAULT_UNMANAGED_SOFT_MAX_LINES);
    expect(result.source).toBe("default");
    expect(result.error).toBeNull();
  });

  it("degrades to the default (never throws) on a non-integer soft budget", () => {
    const root = makeRepo({ policy: { agentsMdAdvisory: { unmanagedSoftMaxLines: -1 } } });
    const result = resolveAgentsMdAdvisory(root);
    expect(result.config.unmanagedSoftMaxLines).toBe(DEFAULT_UNMANAGED_SOFT_MAX_LINES);
    expect(result.source).toBe("default-on-error");
    expect(result.error).toContain(FIELD_AGENTS_MD_ADVISORY_UNMANAGED_SOFT_MAX_LINES);
  });

  it("accepts zero as a valid (tightest) soft budget", () => {
    const root = makeRepo({ policy: { agentsMdAdvisory: { unmanagedSoftMaxLines: 0 } } });
    const result = resolveAgentsMdAdvisory(root);
    expect(result.config.unmanagedSoftMaxLines).toBe(0);
    expect(result.source).toBe("typed");
  });
});
