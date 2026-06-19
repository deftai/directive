import { describe, expect, it, vi } from "vitest";
import { mainEntry } from "./cli.js";
import { lifecycleMain } from "./main.js";

describe("scope cli module", () => {
  it("lifecycleMain is callable from cli entry path", () => {
    expect(lifecycleMain([])).toBe(2);
  });

  it("mainEntry delegates to lifecycleMain", () => {
    expect(mainEntry([])).toBe(2);
  });

  it("mainEntry accepts explicit argv", () => {
    const spy = vi.spyOn(process, "stderr", "get").mockReturnValue({
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream);
    expect(mainEntry(["notreal", "x", "--project-root", "/tmp"])).toBe(2);
    spy.mockRestore();
  });
});
