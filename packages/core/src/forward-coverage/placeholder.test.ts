import { describe, expect, it } from "vitest";
import { placeholderReason } from "./placeholder.js";

function reason(source: string, testPath: string, basename: string): string | null {
  return placeholderReason(source, testPath, basename);
}

describe("placeholderReason function-only", () => {
  it("fails typeof, toBeDefined, toBeTypeOf, and expect.any(Function)", () => {
    expect(
      reason('expect(typeof Shell).toBe("function");\n', "src/shell.test.ts", "shell.ts"),
    ).toBe("function-only");
    expect(reason("expect(Shell).toBeDefined();\n", "src/shell.test.ts", "shell.ts")).toBe(
      "function-only",
    );
    expect(reason('expect(Shell).toBeTypeOf("function");\n', "src/shell.test.ts", "shell.ts")).toBe(
      "function-only",
    );
    expect(
      reason("expect(Shell).toEqual(expect.any(Function));\n", "src/shell.test.ts", "shell.ts"),
    ).toBe("function-only");
    expect(reason("expect(Shell).not.toBeUndefined();\n", "src/shell.test.ts", "shell.ts")).toBe(
      "function-only",
    );
    expect(
      reason(
        'import assert from "node:assert/strict";\nassert.equal(typeof Shell, "function");\n',
        "src/shell.test.ts",
        "shell.ts",
      ),
    ).toBe("function-only");
  });

  it("fails callable and inspect.isfunction", () => {
    expect(reason("assert callable(build)\n", "scripts/test_store.py", "store.py")).toBe(
      "function-only",
    );
    expect(
      reason(
        "import inspect\nassert inspect.isfunction(build)\n",
        "scripts/test_store.py",
        "store.py",
      ),
    ).toBe("function-only");
    expect(
      reason(
        "import types\nassert isinstance(build, types.FunctionType)\n",
        "scripts/test_store.py",
        "store.py",
      ),
    ).toBe("function-only");
  });

  it("fails a Go reflect.Func check", () => {
    const src = `package widget
import "reflect"
import "testing"
func TestWidget(t *testing.T) {
  if reflect.TypeOf(Widget).Kind() != reflect.Func {
    t.Fatal("not func")
  }
}
`;
    expect(reason(src, "cmd/widget_test.go", "widget.go")).toBe("function-only");
  });

  it("passes a call, an empty file, and a file with no import", () => {
    expect(reason("", "src/page.test.ts", "page.tsx")).toBeNull();
    expect(reason('import { foo } from "./foo";\n', "src/foo.test.ts", "foo.ts")).toBeNull();
    expect(reason("expect(Shell()).toBe(1);\n", "src/shell.test.ts", "shell.ts")).toBeNull();
    expect(
      reason(
        'expect(typeof Shell).toBe("function");\nexpect(Shell()).toBe(1);\n',
        "src/shell.test.ts",
        "shell.ts",
      ),
    ).toBeNull();
    expect(reason("assert build() == 1\n", "scripts/test_store.py", "store.py")).toBeNull();
  });
});

describe("placeholderReason source text", () => {
  it("fails a text read through more than one API", () => {
    const sync = `import { readFileSync } from "node:fs";
import { join } from "node:path";
const source = readFileSync(join(__dirname, "page.tsx"), "utf8");
expect(source).toContain("deleteVehicleAction");
`;
    const promises = `const source = await fs.promises.readFile(join(dir, "page.tsx"), "utf8");
expect(source).toContain("deleteVehicleAction");
`;
    const invented = `const source = slurp("page.tsx");
expect(source).toContain("deleteVehicleAction");
`;
    const raw = `import src from "./page.tsx?raw";
expect(src).toContain("deleteVehicleAction");
`;
    expect(reason(sync, "src/page.test.ts", "page.tsx")).toBe("source-text");
    expect(reason(promises, "src/page.test.ts", "page.tsx")).toBe("source-text");
    expect(reason(invented, "src/page.test.ts", "page.tsx")).toBe("source-text");
    expect(reason(raw, "src/page.test.ts", "page.tsx")).toBe("source-text");
  });

  it("still fails when a real call sits beside the text read", () => {
    const src = `import { readFileSync } from "node:fs";
const source = readFileSync("page.tsx", "utf8");
expect(source).toContain("deleteVehicleAction");
expect(deleteVehicleAction()).toBe(1);
`;
    expect(reason(src, "src/page.test.ts", "page.tsx")).toBe("source-text");
  });

  it("fails Go and Python reads through more than one API", () => {
    const readFile = `package widget
import ("os"; "strings"; "testing")
func TestWidget(t *testing.T) {
  b, _ := os.ReadFile("widget.go")
  if !strings.Contains(string(b), "func Widget") { t.Fatal("missing") }
}
`;
    const open = `package widget
import ("io"; "os"; "strings"; "testing")
func TestWidget(t *testing.T) {
  f, _ := os.Open("widget.go")
  b, _ := io.ReadAll(f)
  if !strings.Contains(string(b), "func Widget") { t.Fatal("missing") }
}
`;
    const pyOpen = `source = open("store.py").read()
assert "def build" in source
`;
    const pyPath = `source = Path("store.py").read_text()
assert "def build" in source
`;
    expect(reason(readFile, "cmd/widget_test.go", "widget.go")).toBe("source-text");
    expect(reason(open, "cmd/widget_test.go", "widget.go")).toBe("source-text");
    expect(reason(pyOpen, "scripts/test_store.py", "store.py")).toBe("source-text");
    expect(reason(pyPath, "scripts/test_store.py", "store.py")).toBe("source-text");
  });

  it("passes a normal import that expects a string and a read that does not", () => {
    const imported = `import { title } from "./page.tsx";
expect(title()).toContain("Hello");
`;
    const numeric = `readFileSync("page.tsx");
expect(deleteVehicleAction()).toBe(1);
`;
    expect(reason(imported, "src/page.test.ts", "page.tsx")).toBeNull();
    expect(reason(numeric, "src/page.test.ts", "page.tsx")).toBeNull();
  });
});
