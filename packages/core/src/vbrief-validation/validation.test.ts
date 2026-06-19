import { describe, expect, it } from "vitest";
import {
  HASH_SUFFIX_LENGTH,
  ID_MAX_LENGTH,
  slugFallbackId,
  slugifyId,
  validateMigrationOutput,
} from "./validation.js";

describe("validation", () => {
  it("slugifyId matches schema rules", () => {
    expect(slugifyId("hello world")).toBe("hello-world");
    expect(slugifyId("")).toBe("untitled");
    expect(slugifyId("a".repeat(200)).length).toBeLessThanOrEqual(ID_MAX_LENGTH);
  });

  it("slugifyId collision suffix is stable", () => {
    const existing = new Set<string>(["hello"]);
    const second = slugifyId("hello", existing);
    expect(second.startsWith("hello-")).toBe(true);
    expect(second.slice(-HASH_SUFFIX_LENGTH)).toMatch(/^[0-9a-f]{6}$/);
    const seed = "collision-seed-value";
    existing.clear();
    existing.add("collision-seed-value");
    const baseMax = ID_MAX_LENGTH - 1 - HASH_SUFFIX_LENGTH;
    const base =
      "collision-seed-value".slice(0, baseMax).replace(/-+$/, "") ||
      "collision-seed-value".slice(0, baseMax) ||
      "id";
    existing.add(`${base}-aaaaaa`);
    const third = slugifyId(seed, existing);
    expect(third).not.toBe(`${base}-aaaaaa`);
  });

  it("slugFallbackId preference order", () => {
    expect(slugFallbackId({ number: "42", task_id: "1.1" })).toBe("42");
    expect(slugFallbackId({ task_id: "1.1.2" })).toBe("1.1.2");
    expect(slugFallbackId({})).toBe("untitled");
  });

  it("validateMigrationOutput missing dir", () => {
    const [errors, warnings] = validateMigrationOutput("/no/such/vbrief-dir", () => [[], []]);
    expect(errors[0]).toContain("expected vbrief directory does not exist");
    expect(warnings).toEqual([]);
  });
});
