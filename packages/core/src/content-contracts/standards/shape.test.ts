import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";
import {
  INTERFACE_SHAPE,
  LANGUAGE_SHAPE,
  STRATEGY_SHAPE,
  TOOL_SHAPE,
  validateShape,
} from "./_shapes.js";

const SHAPES = {
  language: LANGUAGE_SHAPE,
  strategy: STRATEGY_SHAPE,
  interface: INTERFACE_SHAPE,
  tool: TOOL_SHAPE,
} as const;

describe("test_shape.language_file_shape", () => {
  it("languages/6502-DASM.md", () => {
    const v = validateShape(readText("languages/6502-DASM.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/c.md", () => {
    const v = validateShape(readText("languages/c.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/cpp.md", () => {
    const v = validateShape(readText("languages/cpp.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/csharp.md", () => {
    const v = validateShape(readText("languages/csharp.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/dart.md", () => {
    const v = validateShape(readText("languages/dart.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/delphi.md", () => {
    const v = validateShape(readText("languages/delphi.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/elixir.md", () => {
    const v = validateShape(readText("languages/elixir.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/go.md", () => {
    const v = validateShape(readText("languages/go.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/java.md", () => {
    const v = validateShape(readText("languages/java.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/javascript.md", () => {
    const v = validateShape(readText("languages/javascript.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/julia.md", () => {
    const v = validateShape(readText("languages/julia.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/kotlin.md", () => {
    const v = validateShape(readText("languages/kotlin.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/markdown.md", () => {
    const v = validateShape(readText("languages/markdown.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/mermaid.md", () => {
    const v = validateShape(readText("languages/mermaid.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/officejs.md", () => {
    const v = validateShape(readText("languages/officejs.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/python.md", () => {
    const v = validateShape(readText("languages/python.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/r.md", () => {
    const v = validateShape(readText("languages/r.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/rust.md", () => {
    const v = validateShape(readText("languages/rust.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/sql.md", () => {
    const v = validateShape(readText("languages/sql.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/swift.md", () => {
    const v = validateShape(readText("languages/swift.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/typescript.md", () => {
    const v = validateShape(readText("languages/typescript.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/vba.md", () => {
    const v = validateShape(readText("languages/vba.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/vhdl.md", () => {
    const v = validateShape(readText("languages/vhdl.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/visual-basic.md", () => {
    const v = validateShape(readText("languages/visual-basic.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
  it("languages/zig.md", () => {
    const v = validateShape(readText("languages/zig.md"), SHAPES.language);
    expect(v).toEqual([]);
  });
});
describe("test_shape.strategy_file_shape", () => {
  it("strategies/artifact-guards.md", () => {
    const v = validateShape(readText("strategies/artifact-guards.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/bdd.md", () => {
    const v = validateShape(readText("strategies/bdd.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/discuss.md", () => {
    const v = validateShape(readText("strategies/discuss.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/emit-hints.md", () => {
    const v = validateShape(readText("strategies/emit-hints.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/enterprise.md", () => {
    const v = validateShape(readText("strategies/enterprise.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/interview.md", () => {
    const v = validateShape(readText("strategies/interview.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/map.md", () => {
    const v = validateShape(readText("strategies/map.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/probe.md", () => {
    const v = validateShape(readText("strategies/probe.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/rapid.md", () => {
    const v = validateShape(readText("strategies/rapid.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/research.md", () => {
    const v = validateShape(readText("strategies/research.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/speckit.md", () => {
    const v = validateShape(readText("strategies/speckit.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/v0-20-contract.md", () => {
    const v = validateShape(readText("strategies/v0-20-contract.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
  it("strategies/yolo.md", () => {
    const v = validateShape(readText("strategies/yolo.md"), SHAPES.strategy);
    expect(v).toEqual([]);
  });
});
describe("test_shape.interface_file_shape", () => {
  it("interfaces/cli.md", () => {
    const v = validateShape(readText("interfaces/cli.md"), SHAPES.interface);
    expect(v).toEqual([]);
  });
  it("interfaces/rest.md", () => {
    const v = validateShape(readText("interfaces/rest.md"), SHAPES.interface);
    expect(v).toEqual([]);
  });
  it("interfaces/tui.md", () => {
    const v = validateShape(readText("interfaces/tui.md"), SHAPES.interface);
    expect(v).toEqual([]);
  });
  it("interfaces/web.md", () => {
    const v = validateShape(readText("interfaces/web.md"), SHAPES.interface);
    expect(v).toEqual([]);
  });
});
describe("test_shape.tool_file_shape", () => {
  it("tools/RWLDL.md", () => {
    const v = validateShape(readText("tools/RWLDL.md"), SHAPES.tool);
    expect(v).toEqual([]);
  });
  it("tools/greptile.md", () => {
    const v = validateShape(readText("tools/greptile.md"), SHAPES.tool);
    expect(v).toEqual([]);
  });
  it("tools/installer.md", () => {
    const v = validateShape(readText("tools/installer.md"), SHAPES.tool);
    expect(v).toEqual([]);
  });
  it("tools/taskfile-migration.md", () => {
    const v = validateShape(readText("tools/taskfile-migration.md"), SHAPES.tool);
    expect(v).toEqual([]);
  });
  it("tools/taskfile.md", () => {
    const v = validateShape(readText("tools/taskfile.md"), SHAPES.tool);
    expect(v).toEqual([]);
  });
  it("tools/telemetry.md", () => {
    const v = validateShape(readText("tools/telemetry.md"), SHAPES.tool);
    expect(v).toEqual([]);
  });
});
