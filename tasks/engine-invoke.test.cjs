#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  shellSplit,
  quoteWin32Arg,
  buildSpawnPlan,
  WIN32_CMD_METACHAR_RE,
} = require("./engine-invoke.cjs");

const WIN32 = { platform: "win32", nodePath: "/node" };
const POSIX = { platform: "linux", nodePath: "/node" };

/**
 * Split a `cmd.exe`-quoted command line into top-level tokens, honouring
 * double-quote grouping and the `""` escaped-quote convention. Used to assert
 * that a metacharacter-bearing arg survives as exactly one argv token and is
 * never seen by cmd.exe as a command separator.
 * @param {string} line
 */
function splitCmdTokens(line) {
  const tokens = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuote = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      started = true;
      continue;
    }
    if (c === " ") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    started = true;
    cur += c;
  }
  if (started) {
    tokens.push(cur);
  }
  return tokens;
}

describe("shellSplit", () => {
  it("keeps quoted free-text (apostrophes, spaces, metachars) as one token", () => {
    assert.deepEqual(shellSplit(`release --summary "It's a & test"`), [
      "release",
      "--summary",
      "It's a & test",
    ]);
  });
});

describe("quoteWin32Arg", () => {
  it("passes safe tokens through unquoted", () => {
    assert.equal(quoteWin32Arg("release"), "release");
    assert.equal(quoteWin32Arg("--summary=fixed"), "--summary=fixed");
  });

  it("double-quotes whitespace, quotes, and cmd.exe metacharacters", () => {
    assert.equal(quoteWin32Arg("a b"), '"a b"');
    assert.equal(quoteWin32Arg("a&b"), '"a&b"');
    assert.equal(quoteWin32Arg("a|b"), '"a|b"');
    assert.equal(quoteWin32Arg("a>b"), '"a>b"');
    assert.equal(quoteWin32Arg("a<b"), '"a<b"');
    assert.equal(quoteWin32Arg("(a)"), '"(a)"');
    assert.equal(quoteWin32Arg("%PATH%"), '"%PATH%"');
    assert.equal(quoteWin32Arg("a^b"), '"a^b"');
    assert.equal(quoteWin32Arg("a!b"), '"a!b"');
  });

  it("escapes embedded double quotes by doubling", () => {
    assert.equal(quoteWin32Arg('a"b'), '"a""b"');
  });

  it("regex flags every cmd.exe separator", () => {
    for (const meta of [" ", '"', "&", "|", "<", ">", "^", "(", ")", "%", "!"]) {
      assert.ok(WIN32_CMD_METACHAR_RE.test(`x${meta}y`), meta);
    }
  });
});

describe("buildSpawnPlan — win32 global (subprocess-scm-01 / #2911)", () => {
  it("never uses shell:true and routes through cmd.exe /d /s /c", () => {
    const plan = buildSpawnPlan("global", "deft", ["release"], WIN32);
    assert.equal(plan.shell, false);
    assert.equal(plan.command, "cmd.exe");
    assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(plan.args[3], "deft release");
  });

  it("keeps injection-shaped free-text args as a single quoted token", () => {
    const injections = [
      "& calc.exe",
      "&calc",
      "| whoami",
      "&& shutdown /s",
      "; rm -rf /",
      "$(reboot)",
      "`reboot`",
      "> C:\\pwn.txt",
      "< C:\\secret",
      "(malicious)",
      "%USERPROFILE%",
      "^escaped",
      "!DELAYED!",
    ];
    for (const evil of injections) {
      const plan = buildSpawnPlan("global", "deft", ["release", "--summary", evil], WIN32);
      assert.equal(plan.shell, false, evil);
      const commandLine = plan.args[3];
      const tokens = splitCmdTokens(commandLine);
      // deft + release + --summary + evil == 4 top-level tokens, evil intact.
      assert.deepEqual(tokens, ["deft", "release", "--summary", evil], `injection ${evil}`);
      // Any cmd.exe metacharacter must be neutralised inside a quoted span so it
      // can never act as a bare command separator (POSIX-only chars like the
      // backtick are literal to cmd.exe and need no quoting).
      if (WIN32_CMD_METACHAR_RE.test(evil)) {
        assert.ok(commandLine.includes(`"${evil.replace(/"/g, '""')}"`), `quoted ${evil}`);
      }
    }
  });

  it("routes end-to-end from a quoted DEFT_ENGINE_CMD string", () => {
    const argv = shellSplit('release --summary "pwn & calc | whoami"');
    const plan = buildSpawnPlan("global", "directive", argv, WIN32);
    assert.equal(plan.shell, false);
    assert.deepEqual(splitCmdTokens(plan.args[3]), [
      "directive",
      "release",
      "--summary",
      "pwn & calc | whoami",
    ]);
  });

  it("leaves safe args unquoted for readability", () => {
    const plan = buildSpawnPlan("global", "deft", ["session:start", "--json"], WIN32);
    assert.equal(plan.args[3], "deft session:start --json");
  });
});

describe("buildSpawnPlan — other paths keep shell:false", () => {
  it("win32 vendored spawns node directly (no cmd.exe, no shell)", () => {
    const plan = buildSpawnPlan("vendored", "/bin.js", ["release", "a&b"], WIN32);
    assert.equal(plan.shell, false);
    assert.equal(plan.command, "/node");
    assert.deepEqual(plan.args, ["/bin.js", "release", "a&b"]);
  });

  it("posix global spawns the shim directly with shell:false", () => {
    const plan = buildSpawnPlan("global", "deft", ["release", "a&b"], POSIX);
    assert.equal(plan.shell, false);
    assert.equal(plan.command, "deft");
    assert.deepEqual(plan.args, ["release", "a&b"]);
  });

  it("posix vendored spawns node with shell:false", () => {
    const plan = buildSpawnPlan("vendored", "/bin.js", ["release"], POSIX);
    assert.equal(plan.shell, false);
    assert.equal(plan.command, "/node");
    assert.deepEqual(plan.args, ["/bin.js", "release"]);
  });

  it("returns null for unknown modes (caller exits 2)", () => {
    assert.equal(buildSpawnPlan("bogus", "deft", ["release"], WIN32), null);
  });
});

describe("buildSpawnPlan — CodeQL absolute-path isolation (#3175 / alert #74)", () => {
  it("never places nodePath/process.execPath into the win32 cmd.exe command line", () => {
    const evilNode = String.raw`C:\Program Files\nodejs\node.exe`;
    const plan = buildSpawnPlan("global", "deft", ["release", "--summary", "ok"], {
      platform: "win32",
      nodePath: evilNode,
    });
    assert.equal(plan.shell, false);
    assert.equal(plan.command, "cmd.exe");
    assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
    // Global win32 must only join target + operator argv — not the Node binary.
    assert.equal(plan.args[3].includes(evilNode), false);
    assert.equal(plan.args[3].includes("Program Files"), false);
    assert.equal(plan.args[3].includes("node.exe"), false);
    assert.deepEqual(splitCmdTokens(plan.args[3]), ["deft", "release", "--summary", "ok"]);
  });

  it("uses nodePath only as the non-shell vendored command (never cmd.exe)", () => {
    const nodePath = String.raw`C:\Program Files\nodejs\node.exe`;
    const plan = buildSpawnPlan("vendored", String.raw`C:\repo\packages\cli\dist\bin.js`, ["session:start"], {
      platform: "win32",
      nodePath,
    });
    assert.equal(plan.shell, false);
    assert.equal(plan.command, nodePath);
    assert.notEqual(plan.command, "cmd.exe");
    assert.deepEqual(plan.args, [String.raw`C:\repo\packages\cli\dist\bin.js`, "session:start"]);
  });
});
