/**
 * False-deny audit for widening assertWriteTargetSafe (#3953).
 *
 * The unified primitive refuses in-tree parent-directory symlinks. Every
 * current caller is a product write gate; none require following an in-tree
 * parent link. Adding a caller that must follow such a link is a new product
 * decision — update this inventory in the same PR.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Product modules that call assertWriteTargetSafe (excludes this package's definition). */
const WRITE_TARGET_SAFE_CALLERS: readonly string[] = [
  "authz/store.ts",
  "cache/io.ts",
  "delivery-attempt/ledger.ts",
  "escalation/store.ts",
  "eval-health-relocation/evaluate.ts",
  "fs/contained-write.ts",
  "hooks/dispatcher.ts",
  "init-deposit/gitignore.ts",
  "intake/issue-emit.ts",
  "intake/issue-ingest.ts",
  "intake/reconcile-issues.ts",
  "issue-sync/sync-from-xbrief.ts",
  "orchestration/probe-session.ts",
  "orchestration/verify-judgment-gates.ts",
  "platform/changelog-cli.ts",
  "policy/no-deft-directive.ts",
  "render/roadmap-render.ts",
  "render/rule-map.ts",
  "run-summary/emit.ts",
  "scope/demote.ts",
  "scope/undo.ts",
  "session/occupancy.ts",
  "session/ritual-sentinel.ts",
  "slice/lock.ts",
  "swarm/routing.ts",
  "triage/scope/coverage.ts",
  "vbrief-build/project-definition-mutation.ts",
  "xbrief-migrate/migrate-project.ts",
];

function walkTs(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTs(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    acc.push(full);
  }
}

describe("assertWriteTargetSafe false-deny audit (#3953)", () => {
  it("every direct caller is a listed product write gate", () => {
    const files: string[] = [];
    walkTs(SRC_ROOT, files);
    const found = files
      .filter((abs) => {
        const rel = relative(SRC_ROOT, abs).replaceAll("\\", "/");
        if (rel === "fs/projection-containment.ts") return false;
        const text = readFileSync(abs, "utf8");
        return /\bassertWriteTargetSafe\s*\(/.test(text);
      })
      .map((abs) => relative(SRC_ROOT, abs).replaceAll("\\", "/"))
      .sort();
    expect(found).toEqual([...WRITE_TARGET_SAFE_CALLERS].sort());
  });
});
