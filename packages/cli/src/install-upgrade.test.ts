import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  parseUpdateArgv,
  type RefreshDepositSeams,
  runRefreshDepositCli,
} from "@deftai/directive-core/init-deposit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchIo } from "./dispatch.js";
import { CANONICAL_UPDATE_ARGV } from "./init-cli/constants.js";
import { REDIRECT_NOTICE, run, translateArgs } from "./install-upgrade.js";

const CONTENT_PACKAGE_NAME = "@deftai/directive-content";

describe("translateArgs", () => {
  it("maps --project-root onto --repo-root (space form)", () => {
    expect(translateArgs(["--project-root", "/x"])).toEqual(["--repo-root", "/x"]);
  });

  it("maps --project-root= onto --repo-root= (inline form)", () => {
    expect(translateArgs(["--project-root=/x"])).toEqual(["--repo-root=/x"]);
  });

  it("drops --framework-root (and its value), --migrate, and --force", () => {
    expect(translateArgs(["--framework-root", "/f", "--migrate", "--force", "--json"])).toEqual([
      "--json",
    ]);
    expect(translateArgs(["--framework-root=/f", "--migrate"])).toEqual([]);
  });

  it("passes through unrecognized argv unchanged", () => {
    expect(translateArgs(["--repo-root", "/y", "--json"])).toEqual(["--repo-root", "/y", "--json"]);
  });
});

describe("run (redirect delegation)", () => {
  it("emits the redirect notice and delegates to the update path with translated argv", async () => {
    const err: string[] = [];
    const io: DispatchIo = { writeOut: () => {}, writeErr: (t) => err.push(t) };
    const update = vi.fn(async () => 7);

    const code = await run(["--project-root", "/x", "--migrate"], io, { runUpdate: update });

    expect(code).toBe(7);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(["--repo-root", "/x"], io);
    expect(err.join("")).toContain(REDIRECT_NOTICE.trim());
  });
});

describe("install-upgrade <-> directive update parity (#2064)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
  }

  /** A minimal vendored-install fixture: local content package + stale deposit. */
  function makeVendoredFixture(prefix: string, version = "0.53.0"): string {
    const project = freshRoot(prefix);
    const pkgDir = join(project, "node_modules", "@deftai", "directive-content");
    mkdirSync(join(pkgDir, "templates"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version }),
      "utf8",
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(pkgDir, "templates/agents-entry.md"),
    );
    writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");

    // A stale vendored deposit so a real refresh has work to do.
    const deftDir = join(project, ".deft", "core");
    mkdirSync(deftDir, { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      "tag: 'v0.40.0'\nsha: abc\ninstall_root: '.deft/core'\n",
      "utf8",
    );
    writeFileSync(
      join(project, "AGENTS.md"),
      "# Operator prose\n\n<!-- deft:managed-section v2 -->\nOld body\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    return project;
  }

  function seamsFor(contentRoot: string): RefreshDepositSeams {
    return {
      resolveContentRoot: async () => contentRoot,
      readEngineVersion: () => "0.53.0",
      nowIso: () => "2026-07-03T12:00:00Z",
      gitPorcelain: () => null,
    };
  }

  /** The exact code path `directive update` drives, wired to fixture seams. */
  function updateWithSeams(
    contentRoot: string,
  ): (argv: readonly string[], io: DispatchIo) => Promise<number> {
    return (argv, io) => {
      const args = parseUpdateArgv(CANONICAL_UPDATE_ARGV, argv);
      return runRefreshDepositCli({
        ...args,
        writeOut: io.writeOut,
        writeErr: io.writeErr,
        seams: seamsFor(contentRoot),
      });
    };
  }

  /** Recursively read a directory into a relpath -> contents map. */
  function readTree(root: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) {
          walk(abs);
        } else {
          out.set(relative(root, abs).split("\\").join("/"), readFileSync(abs, "utf8"));
        }
      }
    };
    walk(root);
    return out;
  }

  function normalizeSummary(stdout: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(stdout);
    // JSON.parse happily returns top-level null / a scalar without throwing, so
    // guard before any property access (which would otherwise TypeError outside
    // the parse try/catch).
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`Expected a JSON object summary, got: ${stdout}`);
    }
    const summary = parsed as Record<string, unknown>;
    // project_dir / deft_dir are absolute fixture paths that legitimately differ
    // between the two runs; every other field must match byte-for-byte.
    summary.project_dir = "<project>";
    summary.deft_dir = "<project>/.deft/core";
    return summary;
  }

  it("produces identical deposit state + stdout; only install-upgrade emits the notice", async () => {
    const contentRoot = "node_modules/@deftai/directive-content";

    // directive update against fixture U.
    const projU = makeVendoredFixture("parity-update-");
    const outU: string[] = [];
    const errU: string[] = [];
    const ioU: DispatchIo = { writeOut: (t) => outU.push(t), writeErr: (t) => errU.push(t) };
    const codeU = await updateWithSeams(join(projU, contentRoot))(["--repo-root", projU], ioU);

    // install-upgrade against an identical fixture I (delegating to the same path).
    const projI = makeVendoredFixture("parity-installupgrade-");
    const outI: string[] = [];
    const errI: string[] = [];
    const ioI: DispatchIo = { writeOut: (t) => outI.push(t), writeErr: (t) => errI.push(t) };
    const codeI = await run(["--project-root", projI], ioI, {
      runUpdate: updateWithSeams(join(projI, contentRoot)),
    });

    expect(codeU).toBe(0);
    expect(codeI).toBe(0);

    // stdout (the JSON upgrade summary) is identical modulo the fixture paths.
    expect(normalizeSummary(outI.join(""))).toEqual(normalizeSummary(outU.join("")));

    // Deposited .deft/core tree is byte-identical.
    expect(readTree(join(projI, ".deft", "core"))).toEqual(readTree(join(projU, ".deft", "core")));

    // AGENTS.md refresh is identical modulo the intrinsic per-run managed-section
    // stamp (`refreshed=` timestamp + random `session=`), which differs between
    // any two independent refreshes regardless of the verb that drove them.
    const normalizeAgents = (text: string): string =>
      text.replace(/refreshed=\S+/g, "refreshed=<t>").replace(/session=\S+/g, "session=<s>");
    expect(normalizeAgents(readFileSync(join(projI, "AGENTS.md"), "utf8"))).toBe(
      normalizeAgents(readFileSync(join(projU, "AGENTS.md"), "utf8")),
    );

    // Only install-upgrade emits the one-line redirect notice.
    expect(errI.join("")).toContain(REDIRECT_NOTICE.trim());
    expect(errU.join("")).not.toContain(REDIRECT_NOTICE.trim());
  });
});
