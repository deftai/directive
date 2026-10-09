import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DEFAULT_BRANCHES } from "@deftai/directive-core/preflight";
import { afterEach, describe, expect, it } from "vitest";
import { enrichBranchesWithTypedDelivery, parseArgs, run } from "./preflight-gh.js";

const ZERO = "0000000000000000000000000000000000000000";
const LIVE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function captureRun(argv: string[]): { code: number | Promise<number>; out: string; err: string } {
  let out = "";
  let err = "";
  const prevOut = process.stdout.write.bind(process.stdout);
  const prevErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out += String(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err += String(c);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: run(argv), out, err };
  } finally {
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
  }
}

describe("enrichBranchesWithTypedDelivery (#5520)", () => {
  it("unions develop when typed deliveryBranch is set", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-prepush-5520-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          status: "running",
          policy: { deliveryBranch: "develop" },
        },
      }),
      "utf8",
    );
    const enriched = enrichBranchesWithTypedDelivery(root, new Set(DEFAULT_BRANCHES));
    expect(enriched.has("develop")).toBe(true);
    expect(enriched.has("master")).toBe(true);
    expect(DEFAULT_BRANCHES.has("develop")).toBe(false);
  });

  it("skips hostile typed deliveryBranch", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-prepush-hostile-"));
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          status: "running",
          policy: { deliveryBranch: "--upload-pack=evil" },
        },
      }),
      "utf8",
    );
    const enriched = enrichBranchesWithTypedDelivery(root, new Set(DEFAULT_BRANCHES));
    expect(enriched.has("--upload-pack=evil")).toBe(false);
  });
});

describe("preflight-gh parseArgs --project-root", () => {
  it("keeps projectRoot for pre-push stdin", () => {
    const parsed = parseArgs(["--pre-push-stdin", "--project-root", "/tmp/x"]);
    expect(parsed.mode).toBe("pre-push-stdin");
    expect(parsed.projectRoot).toBe("/tmp/x");
    expect(parsed.error).toBeUndefined();
  });

  it("keeps projectRoot for --command", () => {
    const parsed = parseArgs(["--command", "git push origin master", "--project-root", "/tmp/x"]);
    expect(parsed.mode).toBe("command");
    expect(parsed.command).toBe("git push origin master");
    expect(parsed.projectRoot).toBe("/tmp/x");
  });

  it("errors when --project-root is missing its argument", () => {
    const parsed = parseArgs(["--pre-push-stdin", "--project-root"]);
    expect(parsed.error).toContain("project-root");
  });

  it("errors on unrecognized flags", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
  });
});

describe("preflight-gh run", () => {
  it("exits 2 with no mode", () => {
    const { code, err } = captureRun([]);
    expect(code).toBe(2);
    expect(err).toContain("--self-test");
  });

  it("exits 2 on parse error", () => {
    const { code, err } = captureRun(["--project-root"]);
    expect(code).toBe(2);
    expect(err).toContain("project-root");
  });

  it("runs --self-test", () => {
    const { code, out } = captureRun(["--self-test"]);
    expect(code).toBe(0);
    expect(out).toContain("fixtures classified");
  });

  it("refuses --command git push origin master", () => {
    const { code, err } = captureRun(["--command", "git push origin master"]);
    expect(code).toBe(1);
    expect(err).toContain("push_default");
    expect(err).toContain("deft policy:allow-destructive-gh-verbs -- --confirm");
  });

  it("consults --project-root on --command", () => {
    const r = mkdtempSync(join(tmpdir(), "deft-cli-preflight-"));
    mkdirSync(join(r, "xbrief"), { recursive: true });
    writeFileSync(
      join(r, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "t",
          status: "running",
          "x-directive/policy": { allowDestructiveGhVerbs: true },
        },
      }),
      "utf8",
    );
    const { code, out } = captureRun(["--command", "git push origin master", "--project-root", r]);
    expect(code).toBe(0);
    expect(out).toContain("allowDestructiveGhVerbs=true");
  });
});

describe("preflight-gh run --pre-push-stdin", () => {
  const origStdin = process.stdin;
  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  });

  it("refuses create master and names the policy verb", async () => {
    const stdin = Readable.from([`refs/heads/master ${LIVE} refs/heads/master ${ZERO}\n`]);
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    let out = "";
    let err = "";
    const prevOut = process.stdout.write.bind(process.stdout);
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => {
      out += String(c);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      err += String(c);
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await run(["--pre-push-stdin"]);
      expect(code).toBe(1);
      expect(err).toContain("create master");
      expect(err).toContain("deft policy:allow-destructive-gh-verbs -- --confirm");
      expect(out).toBe("");
    } finally {
      process.stdout.write = prevOut;
      process.stderr.write = prevErr;
    }
  });
});
