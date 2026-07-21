import { describe, expect, it } from "vitest";
import type { SubmitAdapter } from "./submit-adapter.js";

describe("SubmitAdapter seam", () => {
  it("accepts minimal adapter implementation", async () => {
    const adapter: SubmitAdapter = {
      id: "test",
      submit: async () => ({ outcome: "dry-run", message: "ok" }),
    };
    expect(adapter.id).toBe("test");
    await expect(adapter.submit({} as never)).resolves.toMatchObject({ outcome: "dry-run" });
  });
});
