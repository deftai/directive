import { describe, expect, it, vi } from "vitest";

const cmdPrWatch = vi.fn((_argv: string[]) => 0);

vi.mock("@deftai/directive-core/dist/pr-watch/main.js", () => ({
  cmdPrWatch: (argv: string[]) => cmdPrWatch(argv),
}));

const { run } = await import("./pr-watch.js");

describe("pr-watch CLI wrapper", () => {
  it("delegates argv to cmdPrWatch and returns its exit code", () => {
    cmdPrWatch.mockReturnValueOnce(1);
    const code = run(["1056", "--one-shot", "--json"]);
    expect(code).toBe(1);
    expect(cmdPrWatch).toHaveBeenCalledWith(["1056", "--one-shot", "--json"]);
  });
});
