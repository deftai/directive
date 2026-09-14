import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import { runInPortRecordMode } from "../fs/mutation-ledger.js";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import type { ClassifySeams } from "../resolution/index.js";
import {
  recordModePayloadRoot,
  runRefreshDepositCli,
  UPDATE_REFUSED_EXIT_CODE,
} from "./refresh.js";
import { writeAgentsMd } from "./scaffold.js";

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") {
    throw new Error("expected a JSON object payload");
  }
  return value as Record<string, unknown>;
}

describe("recordModePayloadRoot (#4446)", () => {
  it("stays dest-rooted outside record mode", () => {
    expect(
      recordModePayloadRoot({ contentRoot: "in", deftDir: "dest", alreadyCurrent: false }),
    ).toBe("dest");
  });

  it("stays dest-rooted when already current even in record mode", () => {
    expect(
      runInPortRecordMode(() =>
        recordModePayloadRoot({ contentRoot: "in", deftDir: "dest", alreadyCurrent: true }),
      ),
    ).toBe("dest");
  });

  it("uses incoming on the swap path in record mode", () => {
    expect(
      runInPortRecordMode(() =>
        recordModePayloadRoot({ contentRoot: "in", deftDir: "dest", alreadyCurrent: false }),
      ),
    ).toBe("in");
  });
});

describe("directive update record-mode payload-root (#4446)", () => {
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

  function installIncomingAway(version: string, templateText: string): string {
    const pkgDir = freshRoot("incoming-away-");
    mkdirSync(join(pkgDir, "templates"), { recursive: true });
    mkdirSync(join(pkgDir, "vbrief", "schemas"), { recursive: true });
    mkdirSync(join(pkgDir, ".githooks"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version }),
      "utf8",
    );
    writeFileSync(join(pkgDir, "templates", "agents-entry.md"), templateText, "utf8");
    for (const name of ["pre-commit", "pre-push", "_deft-run.sh"] as const) {
      copyFileSync(join(process.cwd(), ".githooks", name), join(pkgDir, ".githooks", name));
    }
    writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(
      join(pkgDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "incoming-schema\n",
      "utf8",
    );
    return pkgDir;
  }

  function writeInitializedProject(project: string, contentVersion: string): void {
    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    mkdirSync(join(deftDir, "vbrief", "schemas"), { recursive: true });
    writeFileSync(
      join(deftDir, "VERSION"),
      `tag: 'v${contentVersion}'\nsha: abc\ninstall_root: '.deft/core'\n`,
      "utf8",
    );
    writeFileSync(join(deftDir, "main.md"), "# Deft\n", "utf8");
    writeFileSync(
      join(deftDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"),
      "current\n",
      "utf8",
    );
    copyFileSync(
      join(process.cwd(), "content/templates/agents-entry.md"),
      join(deftDir, "templates/agents-entry.md"),
    );
    writeFileSync(
      join(project, "AGENTS.md"),
      `# Operator prose\n\n<!-- deft:managed-section v3 sha=deadbeefcafe -->\nbody\n${AGENTS_MANAGED_CLOSE}\n`,
      "utf8",
    );
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ private: true, devDependencies: { "@deftai/directive": contentVersion } }),
      "utf8",
    );
  }

  function hashFixtureTree(root: string): string {
    const hash = createHash("sha256");
    const walk = (dir: string, rel: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
        const nextAbs = join(dir, entry.name);
        if (entry.isDirectory()) {
          hash.update(`d:${nextRel}\n`);
          walk(nextAbs, nextRel);
          continue;
        }
        if (entry.isFile()) {
          hash.update(`f:${nextRel}\n`);
          hash.update(readFileSync(nextAbs));
          hash.update("\n");
        }
      }
    };
    walk(root, "");
    return hash.digest("hex");
  }

  function classifySeams(engine: { reachable: boolean; version: string | null }): ClassifySeams {
    return { engineProbe: () => engine, preCutoverProbe: () => false };
  }

  function repoTemplate(): string {
    return readFileSync(join(process.cwd(), "content/templates/agents-entry.md"), "utf8");
  }

  function agentHookReadiness() {
    return {
      code: 0 as const,
      message: "ok",
      stream: "stdout" as const,
      skipped: false,
      liveStatus: "functional" as const,
      hosts: [],
      registrations: [],
      liveProbe: { code: 0 as const, message: "ok", cases: [], hosts: [], durationMs: 1 },
    };
  }

  it("dry-run plans AGENTS.md and dest-only delete from incoming tree (#4446)", async () => {
    const project = freshRoot("payload-root-agents-");
    const stale = repoTemplate().replace(
      "Deft is installed in .deft/core/.",
      "STALE-DEST-TEMPLATE-4446",
    );
    const incomingText = repoTemplate().replace(
      "Deft is installed in .deft/core/.",
      "INCOMING-TEMPLATE-4446",
    );
    const contentRoot = installIncomingAway("0.103.0", incomingText);
    writeInitializedProject(project, "0.78.0");
    const deftDir = join(project, ".deft", "core");
    writeFileSync(join(deftDir, "templates", "agents-entry.md"), stale, "utf8");
    writeAgentsMd(project, deftDir, { printf: () => undefined });
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain("STALE-DEST-TEMPLATE-4446");
    const destOnly = join(deftDir, "stale-agent.md");
    writeFileSync(destOnly, "EVIL\n", "utf8");
    const before = hashFixtureTree(project);
    const out: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      dryRun: true,
      classifySeams: classifySeams({ reachable: true, version: "0.103.0" }),
      writeOut: (t) => out.push(t),
      writeErr: () => undefined,
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.103.0",
      },
    });
    expect(code).toBe(0);
    expect(hashFixtureTree(project)).toBe(before);
    const payload = parseJsonObject(out.join(""));
    expect(payload.dry_run).toBe(true);
    expect(payload.success).toBe(true);
    const mutations = payload.mutations as { wrote: string[]; deleted: string[] };
    expect(mutations.wrote).toContain("AGENTS.md");
    expect(
      mutations.deleted.some((path) => path.replace(/\\/g, "/").endsWith("stale-agent.md")),
    ).toBe(true);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain("STALE-DEST-TEMPLATE-4446");
    expect(readFileSync(destOnly, "utf8")).toBe("EVIL\n");
    const liveOut: string[] = [];
    const liveCode = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: classifySeams({ reachable: true, version: "0.103.0" }),
      writeOut: (t) => liveOut.push(t),
      writeErr: () => undefined,
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.103.0",
        nowIso: () => "2026-09-14T12:00:00Z",
        gitPorcelain: () => null,
        gitLsFiles: () => null,
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });
    expect(liveCode).toBe(0);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toContain("INCOMING-TEMPLATE-4446");
    expect(existsSync(destOnly)).toBe(false);
  });

  it("dry-run and live agree when pre-swap dest template is missing (#4446)", async () => {
    const project = freshRoot("payload-root-missing-");
    const contentRoot = installIncomingAway("0.103.0", repoTemplate());
    writeInitializedProject(project, "0.78.0");
    rmSync(join(project, ".deft", "core", "templates", "agents-entry.md"));
    const dryOut: string[] = [];
    const dryCode = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      dryRun: true,
      classifySeams: classifySeams({ reachable: true, version: "0.103.0" }),
      writeOut: (t) => dryOut.push(t),
      writeErr: () => undefined,
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.103.0",
      },
    });
    expect(dryCode).toBe(0);
    const dryPayload = parseJsonObject(dryOut.join(""));
    expect(dryPayload.success).toBe(true);
    expect(dryPayload.error_code).toBeUndefined();
    const liveOut: string[] = [];
    const liveCode = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: classifySeams({ reachable: true, version: "0.103.0" }),
      writeOut: (t) => liveOut.push(t),
      writeErr: () => undefined,
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.103.0",
        nowIso: () => "2026-09-14T12:00:00Z",
        gitPorcelain: () => null,
        gitLsFiles: () => null,
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });
    expect(liveCode).toBe(0);
    const livePayload = parseJsonObject(liveOut.join(""));
    expect(livePayload.success).toBe(true);
  });

  it("dry-run and live agree when pre-swap dest template is malformed (#4446)", async () => {
    const project = freshRoot("payload-root-malformed-");
    const contentRoot = installIncomingAway("0.103.0", repoTemplate());
    writeInitializedProject(project, "0.78.0");
    writeFileSync(
      join(project, ".deft", "core", "templates", "agents-entry.md"),
      "not a managed template\n",
      "utf8",
    );
    const dryOut: string[] = [];
    const dryCode = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      dryRun: true,
      classifySeams: classifySeams({ reachable: true, version: "0.103.0" }),
      writeOut: (t) => dryOut.push(t),
      writeErr: () => undefined,
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.103.0",
      },
    });
    expect(dryCode).toBe(0);
    expect(parseJsonObject(dryOut.join("")).success).toBe(true);
    const liveOut: string[] = [];
    const liveCode = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      classifySeams: classifySeams({ reachable: true, version: "0.103.0" }),
      writeOut: (t) => liveOut.push(t),
      writeErr: () => undefined,
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.103.0",
        nowIso: () => "2026-09-14T12:00:00Z",
        gitPorcelain: () => null,
        gitLsFiles: () => null,
        evaluateAgentHookReadiness: () => agentHookReadiness(),
      },
    });
    expect(liveCode).toBe(0);
    expect(parseJsonObject(liveOut.join("")).success).toBe(true);
  });

  it("recorded dest plan does not waive dirty-tree refuse (#4446)", async () => {
    const project = freshRoot("payload-root-dirty-");
    const incomingText = repoTemplate().replace(
      "Deft is installed in .deft/core/.",
      "INCOMING-TEMPLATE-4446",
    );
    const contentRoot = installIncomingAway("0.103.0", incomingText);
    writeInitializedProject(project, "0.78.0");
    const out: string[] = [];
    const code = await runRefreshDepositCli({
      projectDir: project,
      jsonOut: true,
      nonInteractive: true,
      upgrade: true,
      dryRun: true,
      classifySeams: classifySeams({ reachable: true, version: "0.103.0" }),
      writeOut: (t) => out.push(t),
      writeErr: () => undefined,
      seams: {
        resolveContentRoot: async () => contentRoot,
        readEngineVersion: () => "0.103.0",
        probeUpdateGit: () => ({
          kind: "dirty",
          dirty_tree: true,
          dirty_files: ["scratch.txt"],
          stderr: "",
        }),
      },
    });
    expect(code).toBe(UPDATE_REFUSED_EXIT_CODE);
    const payload = parseJsonObject(out.join(""));
    expect(payload.error_code).toBe("dirty_tree");
    expect(payload.dry_run).toBe(true);
    const mutations = payload.mutations as { wrote: string[] };
    expect(mutations.wrote.length).toBeGreaterThan(0);
  });
});
