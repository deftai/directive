/**
 * Remedies run as written (#6281 item 5).
 *
 * One parameterized test walks the declaration table. For each row it starts
 * from the refusal state, runs the printed remedy exactly as printed (parsed
 * from the printed line and dispatched in process), and retries the refused
 * operation. A row with no refusal-state case fails the test by name.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "../../../cli/src/bookends.js";
import { readProjectInstallState } from "../../../cli/src/pin.js";
import { ensureGitHooks } from "../../../runtime/src/setup-wiring.js";
import { runLiteralAcceptanceCommands } from "../literal-acceptance/run.js";
import {
  evaluatePrePush,
  prePrPushGateRefusal,
  prePrPushGateRefusalLine,
} from "../preflight-gh/pre-push.js";
import {
  formatAcceptanceActivationWarnings,
  formatAcceptanceCwdWarningLine,
  resolveAcceptanceCommandRecords,
} from "../product-first-done-gate/evaluate.js";
import { declarationHidesAxisLines } from "../scope-provenance/declaration-hides-axis.js";
import {
  assessExtraPaths,
  declaredExtraPathRefusal,
} from "../scope-provenance/extra-path-admission.js";
import { evaluate as evaluateHooksInstalled } from "../verify-env/verify-hooks-installed.js";
import { formatDeclaredRefusal, parsePrintedRemedy } from "./print.js";
import { loadRefusalDeclarations, rowsWithoutRemedyCase } from "./table.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const PIN = "9.9.9";
/** Published npm latest, older than the pin: the #5977 downgrade case. */
const OLDER_LATEST = "0.0.1";
const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

/** A consumer project with an exact pin and an installed runtime (no .githooks yet). */
function freshInstall(): string {
  const root = mkdtempSync(join(tmpdir(), "remedy-6281-"));
  TEMPS.push(root);
  execFileSync("git", ["init", "-q", root]);
  const pkg = {
    name: "t",
    version: "0.0.0",
    private: true,
    devDependencies: { "@deftai/directive-runtime": PIN },
  };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "t", devDependencies: { "@deftai/directive-runtime": PIN } },
          "node_modules/@deftai/directive-runtime": { version: PIN },
        },
      },
      null,
      2,
    )}\n`,
  );
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-runtime", version: PIN, directive: { contract: 1 } })}\n`,
  );
  writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  return root;
}

interface RanCommand {
  readonly code: number;
  readonly stderr: string;
}

/**
 * Run one printed command in process. The `directive install` bookend runs for
 * real; its hand-off to the runtime `setup --operation repair` deposits the
 * managed git hooks the way runtime setup does, and npm latest resolves older
 * than the pin.
 */
function runPrinted(root: string, command: string): RanCommand {
  const argv = command.split(" ");
  expect(argv.slice(0, 2), `unsupported remedy command: ${command}`).toEqual([
    "directive",
    "install",
  ]);
  const err: string[] = [];
  let setupOperation: string | null = null;
  const code = runInstall(
    root,
    readProjectInstallState(root),
    argv.slice(2),
    PIN,
    { writeOut: () => {}, writeErr: (t) => err.push(t) },
    {
      stdinIsTTY: false,
      resolveLatest: () => ({ ok: true, version: OLDER_LATEST }),
      runPmAdd: () => ({ ok: true }),
      invokeSetup: (setupArgv) => {
        const at = setupArgv.indexOf("--operation");
        setupOperation = at >= 0 ? (setupArgv[at + 1] ?? null) : null;
        const hooks = ensureGitHooks(root);
        return {
          exitCode: hooks.conflicts.length > 0 ? 1 : 0,
          stdout: JSON.stringify({
            contract: 1,
            entry: "setup",
            created: hooks.created,
            modified: hooks.modified,
            removed: [],
            conflicts: hooks.conflicts,
          }),
          stderr: "",
          spawned: true,
          message: null,
        };
      },
    },
  );
  expect(setupOperation).toBe("repair");
  return { code, stderr: err.join("") };
}

/** The setup task's hook-file loop and refusal line, read from the shipped Taskfile.yml. */
function taskfileSetupCheck(): { readonly files: readonly string[]; readonly line: string } {
  const text = readFileSync(join(REPO_ROOT, "Taskfile.yml"), "utf8");
  const loop = /for f in ([^;]+); do\s+if \[ ! -f "\.githooks\/\$f" \]/.exec(text);
  const echo = /echo '(❌ deft gate setup-hook-files [^']*)'/.exec(text);
  expect(loop, "setup hook-file loop in Taskfile.yml").not.toBeNull();
  expect(echo, "setup-hook-files refusal line in Taskfile.yml").not.toBeNull();
  return { files: (loop?.[1] ?? "").trim().split(/\s+/), line: echo?.[1] ?? "" };
}

/** The setup task's check, as the shell loop runs it: the refusal line, or null to proceed. */
function runSetupCheck(root: string): string | null {
  const { files, line } = taskfileSetupCheck();
  return files.every((f) => existsSync(join(root, ".githooks", f))) ? null : line;
}

interface RemedyCase {
  /** Put the project in the refused state and return the printed refusal line. */
  readonly refuse: (root: string) => string;
  /**
   * Retry the refused operation; true when it no longer refuses. Null only for
   * a row whose table entry is `deferred`: its line must say it is not
   * runnable as printed and name the owning issue.
   */
  readonly retry: ((root: string) => boolean) | null;
}

const CASES: Readonly<Record<string, RemedyCase>> = {
  // AC 20 deferred to #5933 by operator ruling on #6281 (2026-11-17): the
  // controller run needs review evidence, so no printed form can stand in.
  "pre-pr-push-gate": {
    refuse: (root) => {
      const [code, message] = evaluatePrePush([], { projectRoot: root, enrolledBoundPrePr: true });
      expect(code).toBe(1);
      return message;
    },
    retry: null,
  },
  // #6221: both budget rows warn for one release; the fix is a brief edit, so
  // the row is deferred to #6221 and the line says so.
  "extra-path-not-admitted": {
    refuse: () => {
      const assessment = assessExtraPaths({
        allowlist: ["packages/core/src/a.ts"],
        authority: "concrete",
        changedPaths: ["packages/core/src/new.test.ts"],
        changeKind: () => "add",
        otherClass: "refuse",
      });
      expect(assessment.refused).toEqual(["packages/core/src/new.test.ts"]);
      return declaredExtraPathRefusal(assessment, "not-admitted", "a test add.").line;
    },
    retry: null,
  },
  "extra-paths-over-budget": {
    refuse: () => {
      const assessment = assessExtraPaths({
        allowlist: ["packages/core/src/a.ts"],
        authority: "concrete",
        changedPaths: [
          "packages/core/src/x.ts",
          "packages/core/src/y.ts",
          "packages/core/src/z.ts",
        ],
        otherClass: "refuse",
      });
      expect(assessment.overflow.length).toBeGreaterThan(0);
      return declaredExtraPathRefusal(assessment, "over-budget", "three extras.").line;
    },
    retry: null,
  },
  // #6591: warns only; the fix is a brief edit in the same change, so the row
  // is deferred to #6591 and the line says so.
  "declaration-hides-axis": {
    refuse: () => {
      const rel = "xbrief/active/story.xbrief.json";
      const brief = (item: Record<string, unknown>): string =>
        JSON.stringify({
          plan: { items: [{ id: "clause.1", title: "Deploy to staging", ...item }] },
        });
      const lines = declarationHidesAxisLines({
        headRel: rel,
        headPayload: JSON.parse(brief({ "x-directive/requires": "merge" })) as unknown,
        baseRel: rel,
        baseRead: { kind: "text", text: brief({}) },
      });
      expect(lines).toHaveLength(1);
      return lines[0] ?? "";
    },
    retry: null,
  },
  // #6886: activation warns only; the fix is a brief edit, so the row is
  // deferred to #6886 and the line says so.
  "acceptance-record-activate": {
    refuse: () => {
      const records = resolveAcceptanceCommandRecords({
        metadata: {
          literal_acceptance_commands: [{ command: "task web:deploy", source: "explicit" }],
        },
      });
      const lines = formatAcceptanceActivationWarnings(records);
      expect(lines).toHaveLength(1);
      return lines[0] ?? "";
    },
    retry: null,
  },
  "acceptance-cwd-grammar": {
    refuse: () => {
      const records = resolveAcceptanceCommandRecords({
        metadata: {
          literal_acceptance_commands: [
            { command: "npx vitest run src/app.test.ts", cwd: "/abs/web", source: "explicit" },
          ],
        },
      });
      expect(records.cwdWarnings).toHaveLength(1);
      const warning = records.cwdWarnings[0];
      return warning === undefined ? "" : formatAcceptanceCwdWarningLine(warning);
    },
    retry: null,
  },
  // #7223: enforce with a named exception; the fix is a brief edit, so the row
  // is deferred to #7223.
  "acceptance-cwd-dependency": {
    refuse: () => {
      const records = resolveAcceptanceCommandRecords({
        metadata: {
          literal_acceptance_commands: [
            {
              command: "npx vitest run src/app.test.ts",
              cwd: "node_modules/pkg",
              source: "explicit",
            },
          ],
        },
      });
      expect(records.commands).toHaveLength(0);
      expect(records.blocking).toHaveLength(1);
      return records.blocking[0]?.reason ?? "";
    },
    retry: null,
  },
  // #6886: enforce with a named exception; the fix is a brief edit or a new
  // directory, so the row is deferred to #6886.
  "acceptance-cwd-containment": {
    refuse: (root) => {
      const result = runLiteralAcceptanceCommands(
        [{ command: "npx vitest run src/app.test.ts", cwd: "web", source: "explicit" }],
        {
          projectRoot: root,
          runner: () => {
            throw new Error("must not spawn");
          },
        },
      );
      expect(result.code).toBe(2);
      return result.runs[0]?.stderr ?? "";
    },
    retry: null,
  },
  "setup-hook-files": {
    refuse: (root) => {
      const line = runSetupCheck(root);
      expect(line, "setup must refuse with no .githooks").not.toBeNull();
      return line ?? "";
    },
    retry: (root) => runSetupCheck(root) === null,
  },
  "hooks-installed": {
    refuse: (root) => {
      execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"]);
      const result = evaluateHooksInstalled(root, { platform: "win32" });
      expect(result.code).toBe(1);
      return result.message.split("\n")[0] ?? "";
    },
    retry: (root) => evaluateHooksInstalled(root, { platform: "win32" }).code === 0,
  },
};

const ROWS = loadRefusalDeclarations();

describe("declared refusal remedies run as printed (#6281 item 5)", () => {
  it.each(ROWS.map((row) => [row.id, row] as const))("row %s", (id, row) => {
    const remedyCase = CASES[id];
    expect(remedyCase, `no refusal-state case for declared refusal row ${id}`).toBeDefined();
    if (remedyCase === undefined) return;
    const root = freshInstall();
    const printed = remedyCase.refuse(root);
    expect(printed).toContain(`deft gate ${id} `);
    const commands = parsePrintedRemedy(printed);
    expect(commands).toEqual(row.remedy);
    if (remedyCase.retry === null) {
      expect(row.deferred, `row ${id} has no runnable-as-printed case`).not.toBeNull();
      expect(printed).toContain(`Not runnable exactly as printed: ${row.deferred}.`);
      expect(row.deferred).toMatch(/#\d+/);
      return;
    }
    expect(row.deferred).toBeNull();
    for (const command of commands) {
      const ran = runPrinted(root, command);
      expect(ran.stderr).not.toMatch(/downgrade/i);
      expect(ran.code, `${command}: ${ran.stderr}`).toBe(0);
    }
    expect(remedyCase.retry(root)).toBe(true);
  });

  it("the bound pre-PR push gate honors its row mode: enforce refuses, warn lets the push proceed", () => {
    expect(prePrPushGateRefusal("d", "h")[0]).toBe(1);
    const warnRows = ROWS.map((r) =>
      r.id === "pre-pr-push-gate" ? { ...r, mode: "warn" as const } : r,
    );
    const [code, line] = prePrPushGateRefusal("d", "h", warnRows);
    expect(code).toBe(0);
    expect(line).toContain("can refuse from a later release");
  });

  it("the bound pre-PR push gate names the head it knows and the controller sequence", () => {
    const line = prePrPushGateRefusalLine("no completed pre-PR pass bound to this HEAD", "abc123");
    expect(line).toContain("deft gate pre-pr-push-gate (bound pre-PR push gate (#5804)) refused:");
    const commands = parsePrintedRemedy(line);
    expect(commands[0]).toContain("--head-sha abc123 ");
    expect(commands.slice(1)).toEqual([
      "deft pre-pr:run --observe-command --run-id <run-id> --phase <phase> --command <command> --exit-code <n>",
      "deft pre-pr:run --observe-semantic --run-id <run-id> --phase <phase> --reviewed-file <path> --supplied-contents-hash <hex>",
      "deft pre-pr:run --complete --run-id <run-id>",
      "git push",
    ]);
    expect(line).toContain("#5933");
  });

  it("a row with no refusal-state case is named", () => {
    const extra = loadRefusalDeclarations([{ id: "uncovered-gate", gate: "g", remedy: ["x"] }]);
    expect(rowsWithoutRemedyCase([...ROWS, ...extra], Object.keys(CASES))).toEqual([
      "uncovered-gate",
    ]);
    expect(rowsWithoutRemedyCase(ROWS, Object.keys(CASES))).toEqual([]);
  });

  it("the Taskfile setup refusal line is the declared line, byte for byte", () => {
    const { files, line } = taskfileSetupCheck();
    expect(files).toEqual(["pre-commit", "pre-push", "_directive-run.sh"]);
    expect(line).toBe(
      formatDeclaredRefusal({
        id: "setup-hook-files",
        detail: "project-root .githooks/ is missing hook files",
      }).line,
    );
  });

  it("a fresh hook deposit satisfies the setup check (no retired helper required)", () => {
    const root = freshInstall();
    ensureGitHooks(root);
    expect(runSetupCheck(root)).toBeNull();
  });

  it("the verify:hooks-installed remedy keeps the pin when npm latest is older (no downgrade)", () => {
    const root = freshInstall();
    const ran = runPrinted(root, "directive install --repair --yes");
    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toMatch(/older than pin|downgrade/i);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies["@deftai/directive-runtime"]).toBe(PIN);
  });
});
