import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdDoctor } from "./main.js";
import { ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE } from "./root-check-invoke.js";

const READY = "Gates-surface ready: root Taskfile.yml includes the deft framework";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "root-check-doctor-"));
  temps.push(root);
  return root;
}

function consumerSeams() {
  return {
    whichFn: () => "/bin/x",
    runChecks: () => ({ checks: [], errors: [] }),
  };
}

function capture(run: () => number): { code: number; output: string } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = run();
    return { code, output: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

const INCLUDE = `version: '3'

includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
`;

describe("doctor gates-surface root check (#4947)", () => {
  it("emits Gates-surface ready when the root check task is absent", () => {
    const root = tempRoot();
    writeFileSync(join(root, "Taskfile.yml"), INCLUDE, "utf8");
    const plain = capture(() => cmdDoctor(["--full", "--project-root", root], consumerSeams()));
    expect(plain.code).toBe(0);
    expect(plain.output).toContain(READY);
    expect(plain.output).not.toContain(ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE);
  });

  it("warns and withholds the ready line when check does not invoke Directive", () => {
    const root = tempRoot();
    const text = `${INCLUDE}
tasks:
  check:
    cmds:
      - echo consumer-only
`;
    writeFileSync(join(root, "Taskfile.yml"), text, "utf8");
    const writes: string[] = [];
    const plain = capture(() =>
      cmdDoctor(["--full", "--fix", "--project-root", root], {
        ...consumerSeams(),
        isTty: () => true,
        readYn: () => true,
        writeText: (path) => {
          writes.push(path);
        },
      }),
    );
    expect(plain.code).toBe(0);
    expect(plain.output).toContain(ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE);
    expect(plain.output).not.toContain(READY);
    expect(plain.output).toContain("System check completed with");
    expect(writes.some((path) => path.replace(/\\/g, "/").endsWith("Taskfile.yml"))).toBe(false);
    expect(readFileSync(join(root, "Taskfile.yml"), "utf8")).toBe(text);

    const json = capture(() =>
      cmdDoctor(["--full", "--json", "--project-root", root], consumerSeams()),
    );
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.output) as {
      ok: boolean;
      findings: Array<{ severity: string; check?: string; message: string }>;
    };
    expect(payload.ok).toBe(true);
    const finding = payload.findings.find((row) => row.check === "root-check-invoke");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toBe(ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE);
    expect(json.output).not.toContain(READY);
  });

  it("emits Gates-surface ready when the root check task invokes Directive", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "Taskfile.yml"),
      `${INCLUDE}
tasks:
  check:
    cmds:
      - deft check
`,
      "utf8",
    );
    const plain = capture(() => cmdDoctor(["--full", "--project-root", root], consumerSeams()));
    expect(plain.code).toBe(0);
    expect(plain.output).toContain(READY);
    expect(plain.output).not.toContain(ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE);
  });

  it("reads Taskfile.yaml when that is the file resolveConsumerTaskfile selects", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "Taskfile.yaml"),
      `${INCLUDE}
tasks:
  check:
    cmds:
      - task check
`,
      "utf8",
    );
    const plain = capture(() => cmdDoctor(["--full", "--project-root", root], consumerSeams()));
    expect(plain.code).toBe(0);
    expect(plain.output).toContain(ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE);
    expect(plain.output).not.toContain(READY);
  });

  it("still skips the include check inside the framework repo", () => {
    const root = tempRoot();
    mkdirSync(join(root, "content", "templates"), { recursive: true });
    mkdirSync(join(root, "content", "skills", "deft-directive-build"), { recursive: true });
    writeFileSync(join(root, "main.md"), "# deft\n", "utf8");
    writeFileSync(join(root, "content", "templates", "agents-entry.md"), "# t\n", "utf8");
    writeFileSync(
      join(root, "content", "skills", "deft-directive-build", "SKILL.md"),
      "# s\n",
      "utf8",
    );
    writeFileSync(
      join(root, "Taskfile.yml"),
      `${INCLUDE}
tasks:
  check:
    cmds:
      - echo consumer-only
`,
      "utf8",
    );
    const plain = capture(() =>
      cmdDoctor(["--full", "--project-root", root], { whichFn: () => "/bin/x" }),
    );
    expect(plain.output).toContain("Skipping Taskfile include check");
    expect(plain.output).not.toContain(ROOT_CHECK_DOES_NOT_INVOKE_MESSAGE);
    expect(plain.output).not.toContain(READY);
  });
});
