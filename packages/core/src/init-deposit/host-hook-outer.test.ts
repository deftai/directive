import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
  hostHookOuterCommand,
  hostHookOuterRelPath,
  hostHookOuterSha8,
  hostHookOuterSource,
  isHostHookOuterCommand,
} from "./host-hook-outer.js";

type Host = "grok" | "claude" | "cursor" | "codex";

const HOSTS: Host[] = ["grok", "claude", "cursor", "codex"];

function gitInit(root: string): void {
  const r = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  expect(r.status).toBe(0);
}

function writeDenyRuntime(root: string): void {
  mkdirSync(join(root, "node_modules", "@deftai", "directive-runtime", "dist"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "node_modules/@deftai/directive-runtime/dist/hook-bin.js"),
    'process.stderr.write("DENY_RUNTIME_REACHED\\n"); process.exit(2);\n',
  );
}

function writeFakeGit(binDir: string, kind: "fail" | "tracked" | "untracked"): void {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, process.platform === "win32" ? "git.cmd" : "git");
  if (process.platform === "win32") {
    if (kind === "fail") {
      writeFileSync(script, "@echo off\r\nexit /b 1\r\n");
    } else if (kind === "tracked") {
      writeFileSync(script, "@echo off\r\necho .deft-directive-disable\r\nexit /b 0\r\n");
    } else {
      writeFileSync(script, "@echo off\r\nexit /b 0\r\n");
    }
  } else {
    if (kind === "fail") {
      writeFileSync(script, "#!/bin/sh\nexit 1\n");
    } else if (kind === "tracked") {
      writeFileSync(script, "#!/bin/sh\necho .deft-directive-disable\nexit 0\n");
    } else {
      writeFileSync(script, "#!/bin/sh\nexit 0\n");
    }
    chmodSync(script, 0o755);
  }
}

function runOuter(
  root: string,
  host: Host,
  envExtra: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  const sha8 = hostHookOuterSha8();
  const abs = join(root, hostHookOuterRelPath(host, sha8));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, hostHookOuterSource());
  return spawnSync(process.execPath, [abs, "--host", host, "--event", "tool.before"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...envExtra },
  });
}

function expectHostFailClosed(r: ReturnType<typeof spawnSync>, host: Host): void {
  if (host === "grok") {
    expect(r.status).toBe(0);
    expect(r.stdout ?? "").toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
    expect(r.stdout ?? "").toContain('"decision":"deny"');
  } else {
    expect(r.status).toBe(1);
    expect(`${r.stderr ?? ""}${r.stdout ?? ""}`).toContain(
      HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
    );
  }
}

function expectHostDenyRuntime(r: ReturnType<typeof spawnSync>, host: Host): void {
  // Pin exits 2 → outer failClosedUnusablePin (host-specific refusal).
  expectHostFailClosed(r, host);
  // Child stderr may be inherited before fail-closed rewrite; either the
  // runtime token or the outer guidance proves enforcement path was taken.
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  expect(
    combined.includes("DENY_RUNTIME_REACHED") ||
      combined.includes(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE),
  ).toBe(true);
}

describe("host-hook-outer (#5994)", () => {
  it("hashes to stable sha8 and builds per-host paths", () => {
    const source = hostHookOuterSource();
    const sha8 = hostHookOuterSha8(source);
    expect(sha8).toMatch(/^[a-f0-9]{8}$/);
    expect(hostHookOuterRelPath("grok", sha8)).toBe(`.grok/hooks/deft-hook-${sha8}.mjs`);
    expect(hostHookOuterCommand("cursor", sha8)).toBe(`node .cursor/hooks/deft-hook-${sha8}.mjs`);
    expect(isHostHookOuterCommand(hostHookOuterCommand("claude", sha8))).toBe(true);
    expect(
      isHostHookOuterCommand("node node_modules/@deftai/directive-runtime/dist/hook-bin.js"),
    ).toBe(false);
  });

  it("F1: eligible disable quiet-allows without pin present", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-disable-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const r = runOuter(root, "grok");
      expect(r.status).toBe(0);
      expect(r.stdout ?? "").toBe("");
      expect(r.stderr ?? "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F1: missing pin fail-closed with project PM guidance (not AC9.7)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-misspin-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const r = runOuter(root, "grok");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
      expect(r.stdout).not.toContain("npm i -g @deftai/directive");
      expect(r.stdout).not.toContain("directive install --repair");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source mentions pin hook-bin and disable flag", () => {
    const source = hostHookOuterSource();
    expect(source).toContain("node_modules/@deftai/directive-runtime/dist/hook-bin.js");
    expect(source).toContain(".deft-directive-disable");
    expect(source).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
    expect(source).toContain("isRegularFile");
    expect(source).toContain("gitTrackListing");
    expect(source).not.toContain("error-unmatch");
  });

  it("logs spawn failure diagnostic when child.error is set (SLizard P1)", () => {
    const source = hostHookOuterSource();
    expect(source).toContain("failed to spawn pin hook-bin");
    expect(source).toContain("child.error");
    expect(source).toContain("failClosedUnusablePin");
    expect(source).toMatch(/if \(child\.error\)/);
    expect(source).toMatch(/if \(child\.status === null\)/);
    expect(source).toContain("failClosedUnusablePin(");
  });

  it("F1: unusable pin (non-zero child) emits Grok deny JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-unusable-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeDenyRuntime(root);
      const r = runOuter(root, "grok");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
      expect(r.stdout).toContain('"decision":"deny"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host-hook-outer eligibility conformance (#6122)", () => {
  it.each(HOSTS)("%s: tracked flag reaches deny runtime (not quietAllow)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-tracked-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const add = spawnSync("git", ["add", "-f", ".deft-directive-disable"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(add.status).toBe(0);
      writeDenyRuntime(root);
      const r = runOuter(root, host);
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: absent flag with deny runtime reaches refusal", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-absent-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeDenyRuntime(root);
      const r = runOuter(root, host);
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: directory-named flag is ineligible; deny runtime reached", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-dirflag-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      mkdirSync(join(root, ".deft-directive-disable"));
      writeDenyRuntime(root);
      const r = runOuter(root, host);
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: indeterminate git probe does not quietAllow (no pin)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-indet-${host}-`));
    const bin = join(root, ".bin");
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      writeFakeGit(bin, "fail");
      const r = runOuter(root, host, {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expectHostFailClosed(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: indeterminate git probe with deny runtime keeps refusal", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-indet-rt-${host}-`));
    const bin = join(root, ".bin");
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      writeFakeGit(bin, "fail");
      writeDenyRuntime(root);
      const r = runOuter(root, host, {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(
    HOSTS,
  )("%s: eligible untracked still quietAllows without pin (missing-runtime)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-eligible-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const r = runOuter(root, host);
      expect(r.status).toBe(0);
      expect(r.stdout ?? "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("symlink flag does not quietAllow (lstat regular-file parity)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-symlink-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "target.txt"), "x\n");
      try {
        symlinkSync(join(root, "target.txt"), join(root, ".deft-directive-disable"));
      } catch {
        return;
      }
      const r = runOuter(root, "grok");
      expectHostFailClosed(r, "grok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
