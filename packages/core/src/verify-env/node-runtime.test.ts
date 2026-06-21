import { describe, expect, it } from "vitest";
import { NODE_RUNTIME_REMEDIATION, nodeRuntimeRemediationLines } from "./node-runtime.js";

describe("nodeRuntimeRemediationLines", () => {
  it("returns remediation when node is missing", () => {
    const lines = nodeRuntimeRemediationLines(["node", "go"]);
    expect(lines).toEqual([NODE_RUNTIME_REMEDIATION]);
  });

  it("returns remediation when pnpm is missing", () => {
    const lines = nodeRuntimeRemediationLines(["pnpm"]);
    expect(lines).toEqual([NODE_RUNTIME_REMEDIATION]);
  });

  it("returns empty when node runtime tools are present", () => {
    expect(nodeRuntimeRemediationLines(["go", "uv"])).toEqual([]);
    expect(nodeRuntimeRemediationLines([])).toEqual([]);
  });
});
