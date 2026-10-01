import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseIfWslOwnershipBlocked } from "./wsl-ownership-guard.js";

describe("refuseIfWslOwnershipBlocked (#1617)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null on native Windows/macOS hosts", () => {
    const writes: string[] = [];
    const code = refuseIfWslOwnershipBlocked(process.cwd(), (text) => {
      writes.push(text);
    });
    expect(code).toBeNull();
    expect(writes).toEqual([]);
  });

  it("uses process.stderr when no writer is supplied", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(refuseIfWslOwnershipBlocked(process.cwd())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
