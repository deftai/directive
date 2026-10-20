import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateVbriefSchema } from "@deftai/directive-core/vbrief-validate";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resolveCanonicalVerb } from "../dispatch.js";
import { runDispatch } from "./helpers.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writePendingVbrief(root: string, status = "pending"): string {
  const dir = join(root, "xbrief", "pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "2026-06-21-story.xbrief.json");
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", updated: "2026-06-01T00:00:00Z" },
      plan: { title: "Story", status, items: [] },
    }),
    "utf8",
  );
  return path;
}

describe("deft-ts vbrief lifecycle verbs (#1838 s3)", () => {
  it("resolves task-style vbrief aliases to canonical verbs", () => {
    expect(resolveCanonicalVerb("vbrief:preflight")).toBe("vbrief-preflight");
    expect(resolveCanonicalVerb("xbrief:preflight")).toBe("vbrief-preflight");
    expect(resolveCanonicalVerb("vbrief:validate")).toBe("vbrief-validate");
    expect(resolveCanonicalVerb("vbrief:activate")).toBe("vbrief-activate");
  });

  it("vbrief-preflight rejects missing --vbrief-path with exit 2", async () => {
    const result = await runDispatch(["vbrief-preflight"]);
    expect(result.exitCode).toBe(2);
  });

  it("vbrief-preflight alias vbrief:preflight matches canonical exit code", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lc-pf-"));
    temps.push(root);
    const path = writePendingVbrief(root);
    const canonical = await runDispatch(["vbrief-preflight", "--vbrief-path", path]);
    const alias = await runDispatch(["vbrief:preflight", "--vbrief-path", path]);
    expect(alias.exitCode).toBe(canonical.exitCode);
    expect(canonical.exitCode).toBe(1);
  });

  it("xbrief:preflight alias resolves and matches vbrief:preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lc-xpf-"));
    temps.push(root);
    const path = writePendingVbrief(root);
    const legacy = await runDispatch(["vbrief:preflight", "--vbrief-path", path]);
    const canonical = await runDispatch(["xbrief:preflight", "--vbrief-path", path]);
    expect(canonical.exitCode).toBe(legacy.exitCode);
  });

  it("vbrief-activate requires a positional vbrief path", async () => {
    const result = await runDispatch(["vbrief-activate"]);
    expect(result.exitCode).toBe(2);
  });

  it("vbrief-activate promotes pending vBRIEF via dispatcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lc-act-"));
    temps.push(root);
    const src = writePendingVbrief(root);
    const result = await runDispatch(["vbrief-activate", src]);
    expect(result.exitCode).toBe(0);
    const dest = join(root, "xbrief", "active", "2026-06-21-story.xbrief.json");
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(src)).toBe(false);
  });

  it("vbrief-validate --help exits 0 through dispatcher", async () => {
    const result = await runDispatch(["vbrief-validate", "--help"]);
    expect(result.exitCode).toBe(0);
  });

  it("vbrief-validate skips missing vbrief dir with exit 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lc-val-"));
    temps.push(root);
    const result = await runDispatch([
      "vbrief-validate",
      "--vbrief-dir",
      join(root, "missing-vbrief"),
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("vbrief-validation rejects unknown flags with exit 2", async () => {
    const result = await runDispatch(["vbrief-validation", "--not-a-flag"]);
    expect(result.exitCode).toBe(2);
  });

  it("vbrief-reconcile requires --project-root", async () => {
    const result = await runDispatch(["vbrief-reconcile"]);
    expect(result.exitCode).toBe(2);
  });
});

/**
 * #3933 criteria 1, 2 and 4 at the alias surface. `xbrief:activate` and
 * `vbrief:activate` are the only verbs that reach vbrief-activate/activate.ts;
 * canonical `scope:activate` routes through scope-lifecycle -> runTransition
 * and is covered in packages/core/src/scope/transition.test.ts.
 */
describe("activate aliases preserve the document envelope (#3933)", () => {
  function writeBrief(root: string, payload: Record<string, unknown>): string {
    const dir = join(root, "xbrief", "pending");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "2026-08-29-story.xbrief.json");
    writeFileSync(path, JSON.stringify(payload), "utf8");
    return path;
  }

  function tempRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    temps.push(root);
    return root;
  }

  for (const verb of ["xbrief:activate", "vbrief:activate"] as const) {
    it(`${verb} leaves exactly one envelope on a v0.8 brief and the result validates`, async () => {
      const root = tempRoot("deft-3933-v08-");
      const src = writeBrief(root, {
        xBRIEFInfo: { version: "0.8", updated: "2026-06-01T00:00:00Z" },
        plan: { title: "Story", status: "pending", items: [] },
      });

      const result = await runDispatch([verb, src]);
      expect(result.exitCode).toBe(0);

      const dest = join(root, "xbrief", "active", "2026-08-29-story.xbrief.json");
      const payload = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(["xBRIEFInfo", "plan"]);
      expect(validateVbriefSchema(payload, dest)).toEqual([]);
    });

    it(`${verb} refuses a brief carrying neither envelope before the move`, async () => {
      const root = tempRoot("deft-3933-none-");
      const src = writeBrief(root, { plan: { title: "Story", status: "pending", items: [] } });

      // The activator writes its refusal straight to process.stderr (#1782 argv
      // parity), not through the dispatcher io seam.
      const written: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
      let result: Awaited<ReturnType<typeof runDispatch>>;
      try {
        result = await runDispatch([verb, src]);
      } finally {
        stderr.mockRestore();
      }
      expect(result.exitCode).toBe(1);
      expect(written.join("")).toContain(
        "carries neither `xBRIEFInfo` (v0.8) nor `vBRIEFInfo` (v0.6)",
      );
      expect(existsSync(src)).toBe(true);
      expect(existsSync(join(root, "xbrief", "active", "2026-08-29-story.xbrief.json"))).toBe(
        false,
      );
    });
  }
});
