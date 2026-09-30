import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  lookupProductMutationCompletion,
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
  const root = mkdtempSync(join(tmpdir(), "product-mutation-"));
  tempDirs.push(root);
  return root;
}

describe("productMutationCompletion (#4544 Prefer-A)", () => {
  it("records a durable marker that survives without occupancy.json", () => {
    const root = tempRoot();
    expect(productMutationCompletionAtRoot(root)).toBe(false);
    expect(lookupProductMutationCompletion(root).kind).toBe("absent");
    const recorded = recordProductMutationCompletion(root, new Date("2026-09-30T12:00:00Z"));
    expect(recorded.ok).toBe(true);
    const markerPath = productMutationCompletionMarkerPath(root);
    expect(existsSync(markerPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as { recordedAt: string };
    expect(parsed.recordedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(productMutationCompletionAtRoot(root)).toBe(true);
    expect(lookupProductMutationCompletion(root)).toEqual({
      kind: "present",
      recordedAt: "2026-09-30T12:00:00.000Z",
    });
  });

  it("does not treat occupancy last_write_at alone as product-mutation completion", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "occupancy.json"),
      JSON.stringify({ last_write_at: "2026-09-30T12:00:00Z" }),
      "utf8",
    );
    expect(productMutationCompletionAtRoot(root)).toBe(false);
    expect(lookupProductMutationCompletion(root).kind).toBe("absent");
  });

  it("reports unreadable/malformed marker instead of absent Process-only (#4544)", () => {
    const malformed = tempRoot();
    mkdirSync(join(malformed, ".deft", "cache"), { recursive: true });
    writeFileSync(productMutationCompletionMarkerPath(malformed), "{ not-json", "utf8");
    const badJson = lookupProductMutationCompletion(malformed);
    expect(badJson.kind).toBe("unreadable");
    expect(productMutationCompletionAtRoot(malformed)).toBe(false);

    const emptyAt = tempRoot();
    mkdirSync(join(emptyAt, ".deft", "cache"), { recursive: true });
    writeFileSync(
      productMutationCompletionMarkerPath(emptyAt),
      JSON.stringify({ recordedAt: "   " }),
      "utf8",
    );
    const empty = lookupProductMutationCompletion(emptyAt);
    expect(empty.kind).toBe("unreadable");
    if (empty.kind === "unreadable") {
      expect(empty.detail).toMatch(/recordedAt/i);
    }
  });
});
