import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ACTIVE_SCOPE_PIN_ENV, rewriteExactLifecycleCommand } from "@deftai/directive-core/hooks";
import { parseLaunchArgv } from "@deftai/directive-core/swarm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseArgs as parseOccupancyReleaseArgs } from "./occupancy-release.js";
import { parseArgs as parseOccupancyStealArgs } from "./occupancy-steal.js";
import { parseArgs as parseSessionReadyArgs } from "./session-ready.js";
import { parseArgs as parseSessionStartArgs } from "./session-start.js";

const CLI_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK_BIN_PATH = join(CLI_SRC_DIR, "../dist/hook-bin.js");
const CLI_SESSION_START_PATH = join(CLI_SRC_DIR, "../dist/session-start.js");
const CORE_SESSION_PATH = resolve(CLI_SRC_DIR, "../../core/dist/session/index.js");
const DIST_BUILD_HINT =
  "built CLI/core output is missing — run `task check` or build both workspace packages";
const SESSION_ID = "host:cursor:v1:Y29udmVyc2F0aW9uLWE";
const CLAIM_SCRIPT = String.raw`
const [coreModuleUrl, cliModuleUrl, root, forwardedJson, head] = process.argv.slice(1);
const { runSessionStart } = await import(coreModuleUrl);
const { parseArgs } = await import(cliModuleUrl);
const parsed = parseArgs(JSON.parse(forwardedJson));
if (parsed.error !== undefined || parsed.sessionId === null) {
  throw new Error("rewritten session:start args did not parse an owner: " + JSON.stringify(parsed));
}
const sessionId = parsed.sessionId;
const result = runSessionStart(root, {
  sessionId,
  writeHistory: false,
  deferrals: { doctor: "child fixture", cache_fresh: "child fixture" },
  orientation: null,
  toolchainPreflight: null,
  runGit: (_root, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: root, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "fixture has no upstream" };
  },
  verifyTools: () => ({ exitCode: 0 }),
  runTriageWelcome: () => ({ exitCode: 0 }),
  resolveUserMd: () => ({
    path: root + "/USER.md",
    rung: "workspace-local",
    found: false,
    diagnostic: "fixture USER.md absent",
    searched: [],
  }),
  probeEnvironment: () => ({
    hostPlatform: process.platform,
    shell: { name: "fixture", path: "fixture", kind: "unknown", source: "test" },
  }),
  probeScm: () => ({
    ready: true,
    binary: "gh",
    binaryPath: "fixture",
    authState: "authenticated",
    githubAuthMode: "host-gh",
    runtimeMode: "local-unsandboxed",
    injectedTokenPresent: false,
    depth: "shallow",
    detail: "fixture SCM ready",
    remediation: null,
    skippedGates: [],
    login: null,
    failureKind: null,
  }),
  runStalenessTickler: () => ({ lines: [], prompted: false }),
});
process.stdout.write(JSON.stringify({ code: result.code, occupancy: result.payload.occupancy }) + "\n");
process.exitCode = result.code;
`;

const temps: string[] = [];

function rewrittenDirectArgs(command: string): string[] {
  const rewritten = rewriteExactLifecycleCommand(
    { tool_name: "Shell", tool_input: { command } },
    SESSION_ID,
  );
  expect(rewritten).toMatchObject({ kind: "rewrite" });
  if (rewritten === null || rewritten.kind !== "rewrite") return [];
  return rewritten.rewrittenCommand.split(" ").slice(2);
}

afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function directiveFreeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "DEFT_SESSION_ID",
    "DEFT_SESSION_RITUAL_SKIP",
    "DEFT_HOOK_READ_ONLY",
    "DEFT_SESSION_POSTURE",
    ACTIVE_SCOPE_PIN_ENV,
  ]) {
    delete env[name];
  }
  for (const key of Object.keys(env).filter((name) => name.toLowerCase() === "path")) {
    const entries = (env[key] ?? "").split(delimiter);
    env[key] = entries
      .filter((entry) => {
        if (entry.length === 0) return false;
        return ![
          "deft",
          "directive",
          "deft.cmd",
          "directive.cmd",
          "deft.exe",
          "directive.exe",
        ].some((name) => existsSync(join(entry, name)));
      })
      .join(delimiter);
  }
  return env;
}

function fixtureProject(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "hook-host-lifetime-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        policy: {
          hostHooks: { claude: false, grok: false, cursor: false, codex: false },
        },
      },
    })}\n`,
  );
  writeFileSync(
    join(root, "xbrief", "active", "story.xbrief.json"),
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        status: "running",
        metadata: {
          intended_placement: {
            schema: "deft.scope.intended_placement.v1",
            files: ["src/app.ts"],
            module_boundary: "host identity lifetime fixture",
          },
        },
      },
    })}\n`,
  );
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Directive fixture"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]) };
}

function runHookPayload(root: string, payload: Record<string, unknown>): Record<string, unknown> {
  const child = spawnSync(
    process.execPath,
    [HOOK_BIN_PATH, "--host=cursor", "--event=tool.before", `--project-root=${root}`],
    {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: directiveFreeChildEnv(),
    },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim(), child.stderr).not.toBe("");
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

function runHook(root: string, conversationId?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tool_name: "Write",
    workspace_roots: [root],
    tool_input: {
      file_path: join(root, "src", "app.ts"),
      content: "export const value = 2;\n",
    },
  };
  if (conversationId !== undefined) payload.conversation_id = conversationId;
  return runHookPayload(root, payload);
}

it("directiveFreeChildEnv deletes ACTIVE_SCOPE_PIN_ENV without mutating process.env (#4506)", () => {
  const previousPin = process.env[ACTIVE_SCOPE_PIN_ENV];
  const previousSession = process.env.DEFT_SESSION_ID;
  process.env[ACTIVE_SCOPE_PIN_ENV] = "xbrief/active/ineligible.xbrief.json";
  process.env.DEFT_SESSION_ID = "host:cursor:v1:keep-on-parent";
  try {
    const env = directiveFreeChildEnv();
    expect(env[ACTIVE_SCOPE_PIN_ENV]).toBeUndefined();
    expect(process.env[ACTIVE_SCOPE_PIN_ENV]).toBe("xbrief/active/ineligible.xbrief.json");
    expect(process.env.DEFT_SESSION_ID).toBe("host:cursor:v1:keep-on-parent");
  } finally {
    if (previousPin === undefined) delete process.env[ACTIVE_SCOPE_PIN_ENV];
    else process.env[ACTIVE_SCOPE_PIN_ENV] = previousPin;
    if (previousSession === undefined) delete process.env.DEFT_SESSION_ID;
    else process.env.DEFT_SESSION_ID = previousSession;
  }
});

describe.sequential("host identity across claim and hook process lifetimes (#3611)", () => {
  beforeAll(() => {
    if (
      !existsSync(HOOK_BIN_PATH) ||
      !existsSync(CORE_SESSION_PATH) ||
      !existsSync(CLI_SESSION_START_PATH)
    ) {
      throw new Error(DIST_BUILD_HINT);
    }
  });

  it("keeps every direct rewrite aligned with the production lifecycle parsers", () => {
    const start = parseSessionStartArgs(rewrittenDirectArgs("deft session:start --rearm"));
    expect(start.sessionId).toBe(SESSION_ID);
    expect(start.error).toBeUndefined();
    const ready = parseSessionReadyArgs(rewrittenDirectArgs("deft session:ready --json"));
    expect(ready.sessionId).toBe(SESSION_ID);
    expect(ready.error).toBeUndefined();
    const end = parseOccupancyReleaseArgs(rewrittenDirectArgs("deft session:end"));
    expect(end.sessionId).toBe(SESSION_ID);
    expect(end.error).toBeUndefined();
    const steal = parseOccupancyStealArgs(
      rewrittenDirectArgs("deft occupancy:steal --confirm --occupant old-owner"),
    );
    expect(steal).toMatchObject({ sessionId: SESSION_ID, occupant: "old-owner" });
    expect(steal.error).toBeUndefined();
    const release = parseOccupancyReleaseArgs(rewrittenDirectArgs("deft occupancy:release"));
    expect(release.sessionId).toBe(SESSION_ID);
    expect(release.error).toBeUndefined();
    expect(parseLaunchArgv(rewrittenDirectArgs("deft swarm-launch --stories 3611"))).toMatchObject({
      stories: ["3611"],
      sessionId: SESSION_ID,
    });
  });

  it("recognizes the claiming conversation and denies foreign or missing host identity", () => {
    const { root, head } = fixtureProject();
    const rewrite = runHookPayload(root, {
      tool_name: "Shell",
      conversation_id: "conversation-a",
      tool_input: {
        command: "deft session:start --no-history",
        description: "claim the fixture mutation session",
      },
    });
    expect(rewrite).toMatchObject({
      permission: "allow",
      updated_input: {
        command: `deft session:start --no-history --session-id=${SESSION_ID}`,
        description: "claim the fixture mutation session",
      },
    });
    const rewrittenCommand = (rewrite.updated_input as { command: string }).command;
    const forwardedArgs = rewrittenCommand.split(" ").slice(2);

    const claim = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        CLAIM_SCRIPT,
        pathToFileURL(CORE_SESSION_PATH).href,
        pathToFileURL(CLI_SESSION_START_PATH).href,
        root,
        JSON.stringify(forwardedArgs),
        head,
      ],
      { encoding: "utf8", env: directiveFreeChildEnv() },
    );
    expect(claim.status, claim.stderr).toBe(0);
    const claimLine = claim.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    expect(JSON.parse(claimLine)).toMatchObject({
      code: 0,
      occupancy: { session_id: SESSION_ID },
    });

    const occupancy = JSON.parse(readFileSync(join(root, ".deft", "occupancy.json"), "utf8")) as {
      session_id: string;
    };
    const ritual = JSON.parse(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")) as {
      session_id: string;
    };
    expect(occupancy.session_id).toBe(SESSION_ID);
    expect(ritual.session_id).toBe(SESSION_ID);

    expect(runHook(root, "conversation-a")).toMatchObject({
      permission: "allow",
      code: "write-ready",
    });
    expect(runHook(root, "conversation-b")).toMatchObject({
      permission: "deny",
      code: "occupancy-occupied",
    });
    expect(runHook(root)).toMatchObject({
      permission: "deny",
      code: "occupancy-identity-unavailable",
    });

    const deftStateFiles = readdirSync(join(root, ".deft"));
    expect(deftStateFiles).toContain("occupancy.json");
    expect(deftStateFiles).toContain("ritual-state.json");
    expect(deftStateFiles.some((name) => /binding|credential|host-map/i.test(name))).toBe(false);
  });
});
