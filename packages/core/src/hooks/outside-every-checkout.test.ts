/**
 * #6376 outside-every-checkout class test. Real filesystem fixtures under the
 * OS temp directory; the class's own temp and home anchors are seams so each
 * case controls exactly which directory is "temp" and which is "home".
 */
import { execFileSync } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agyConversationSeam,
  allTargetsOutsideEveryCheckout,
  classifyOutsideEveryCheckoutTarget,
  defaultRuntimePackageDir,
  deftTempName,
  type OutsideEveryCheckoutSeams,
  pathInside,
  targetsKeepOriginalSpelling,
} from "./outside-every-checkout.js";

let base = "";
let temp = "";
let home = "";
let payload = "";

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "oec-fixture-")));
  temp = join(base, "tmp");
  home = join(base, "home");
  payload = join(base, "payload");
  for (const dir of [temp, home, payload]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function seams(overrides: Partial<OutsideEveryCheckoutSeams> = {}): OutsideEveryCheckoutSeams {
  return {
    tmpdir: () => temp,
    homedir: () => home,
    runtimePackageDir: null,
    ...overrides,
  };
}

function classify(
  target: string,
  env: NodeJS.ProcessEnv = {},
  overrides: Partial<OutsideEveryCheckoutSeams> = {},
) {
  return classifyOutsideEveryCheckoutTarget(payload, target, env, seams(overrides));
}

function linkDir(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("positive location (#6376 items 1-2)", () => {
  it("admits a new file under the OS temp directory", () => {
    expect(classify(join(temp, "note.md"))).toEqual({ inClass: true });
  });

  it("admits a missing nested path, appending the unresolved rest unchanged", () => {
    expect(classify(join(temp, "a", "b", "c.md"))).toEqual({ inClass: true });
  });

  it("admits a file in an ordinary folder under the home directory", () => {
    mkdirSync(join(home, "notes"));
    writeFileSync(join(home, "notes", "n.md"), "x");
    expect(classify(join(home, "notes", "n.md"))).toEqual({ inClass: true });
  });

  it("treats HOME and USERPROFILE as home directories", () => {
    const other = join(base, "other-home");
    mkdirSync(other);
    expect(classify(join(other, "n.md"), { HOME: other }).inClass).toBe(true);
    expect(classify(join(other, "n.md"), { USERPROFILE: other }).inClass).toBe(true);
    expect(classify(join(other, "n.md")).inClass).toBe(false);
  });

  it("refuses a path under neither a home directory nor the OS temp directory", () => {
    const verdict = classify(join(base, "elsewhere", "n.md"));
    expect(verdict).toMatchObject({ inClass: false });
    expect(JSON.stringify(verdict)).toContain("not inside the OS temp directory or a home");
  });

  it("refuses a target inside the payload root", () => {
    const inner = join(temp, "payload");
    mkdirSync(inner);
    const verdict = classifyOutsideEveryCheckoutTarget(inner, join(inner, "x.md"), {}, seams());
    expect(verdict).toEqual({ inClass: false, reason: "inside the payload root" });
  });

  it("accepts the case-folding host branch (darwin)", () => {
    expect(classify(join(temp, "n.md"), {}, { platform: "darwin" }).inClass).toBe(
      process.platform !== "win32",
    );
  });
});

describe("configuration areas (#6376 item 3)", () => {
  it("refuses a dot-folder directly under the home directory", () => {
    expect(classify(join(home, ".claude", "memory", "m.md")).inClass).toBe(false);
  });

  it("refuses <home>/AppData/Roaming with APPDATA not set, in any letter case", () => {
    expect(classify(join(home, "AppData", "Roaming", "x.md")).inClass).toBe(false);
    expect(classify(join(home, "appdata", "Local", "x.md")).inClass).toBe(false);
    expect(classify(join(home, "Library", "x.md")).inClass).toBe(false);
  });

  it("refuses a directory named by a configuration variable", () => {
    const cfg = join(home, "cfg");
    expect(classify(join(cfg, "x.md"), { XDG_CONFIG_HOME: cfg }).inClass).toBe(false);
  });

  it("innermost wins: a home inside temp keeps its .config out of the class", () => {
    const innerHome = join(temp, "h");
    mkdirSync(innerHome);
    expect(classify(join(innerHome, ".config", "x"), {}, { homedir: () => innerHome })).toEqual({
      inClass: false,
      reason: "typed path: inside a configuration area",
    });
    expect(classify(join(innerHome, "notes.md"), {}, { homedir: () => innerHome }).inClass).toBe(
      true,
    );
  });

  it("innermost wins: a temp directory inside a configuration area still passes", () => {
    const cfg = join(base, "cfg");
    const innerTemp = join(cfg, "tmp");
    mkdirSync(innerTemp, { recursive: true });
    const verdict = classify(
      join(innerTemp, "x.md"),
      { XDG_CONFIG_HOME: cfg },
      { tmpdir: () => innerTemp },
    );
    expect(verdict).toEqual({ inClass: true });
  });
});

describe("no repository and no Directive project (#6376 item 4)", () => {
  it("refuses a target under a folder that holds .deft or .git", () => {
    mkdirSync(join(home, "proj", ".deft"), { recursive: true });
    mkdirSync(join(home, "repo", ".git"), { recursive: true });
    expect(classify(join(home, "proj", "x.md")).inClass).toBe(false);
    expect(classify(join(home, "repo", "src", "x.md")).inClass).toBe(false);
  });

  it("refuses a target under an ancestor that is itself a Git directory", () => {
    const bare = join(home, "bare");
    for (const d of ["objects", "refs"]) mkdirSync(join(bare, d), { recursive: true });
    writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
    expect(classify(join(bare, "x"))).toEqual({
      inClass: false,
      reason: "typed path: an ancestor is a Git directory",
    });
  });

  it("walks the typed ancestors too: a project a link points out of keeps the target out", () => {
    const project = join(home, "project");
    mkdirSync(join(project, ".deft"), { recursive: true });
    const plain = join(temp, "plain");
    mkdirSync(plain);
    if (!linkDir(plain, join(project, "alias"))) return;
    expect(classify(join(project, "alias", "note.md"))).toEqual({
      inClass: false,
      reason: "typed path: an ancestor holds a .git or .deft entry",
    });
    expect(classify(join(plain, "note.md")).inClass).toBe(true);
  });

  it("refuses when the Git lookup fails to run or reports a repository", () => {
    const failing = classify(
      join(temp, "x.md"),
      {},
      {
        runGit: () => ({ code: 127, stdout: "", stderr: "git executable not found on PATH" }),
      },
    );
    expect(failing).toEqual({
      inClass: false,
      reason: "the Git lookup could not run to completion",
    });
    const repo = classify(
      join(temp, "x.md"),
      {},
      {
        runGit: () => ({ code: 0, stdout: temp, stderr: "" }),
      },
    );
    expect(repo.inClass).toBe(false);
  });

  it("refuses when a directory on the walk cannot be read", () => {
    const verdict = classify(
      join(temp, "x.md"),
      {},
      {
        lstat: (p: string): Stats => {
          if (p.endsWith(".deft")) {
            const err = new Error("denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return lstatSync(p);
        },
      },
    );
    expect(verdict).toEqual({
      inClass: false,
      reason: "typed path: a directory on the walk cannot be read",
    });
  });

  it("refuses a backslash in a POSIX typed path", () => {
    const posix = {
      platform: "linux" as const,
      homedir: () => "/home/u",
      tmpdir: () => "/tmp",
      realpath: (p: string) => p,
    };
    expect(classify("/tmp/alias\\name/file.ts", {}, posix)).toEqual({
      inClass: false,
      reason: "backslash in a POSIX typed path",
    });
  });
});

describe("exclusions (#6376 item 5)", () => {
  it("refuses deft-backups and any deft or directive component in any letter case", () => {
    expect(classify(join(temp, "deft-backups", "a.json")).inClass).toBe(false);
    expect(classify(join(temp, "DEFT", "a")).inClass).toBe(false);
    expect(classify(join(temp, "My-Directive-notes", "a")).inClass).toBe(false);
    expect(classify(join(temp, "x", ".git", "config")).inClass).toBe(false);
  });

  it("refuses a file named by DEFT_USER_PATH and a folder named by OPENCLAW_STATE_DIR", () => {
    mkdirSync(join(home, "notes"));
    const user = join(home, "notes", "USER.md");
    expect(classify(user, { DEFT_USER_PATH: user }).inClass).toBe(false);
    expect(classify(user, { DIRECTIVE_X: join(home, "notes") }).inClass).toBe(false);
    const oc = join(home, "oc");
    expect(classify(join(oc, "state.json"), { OPENCLAW_STATE_DIR: oc }).inClass).toBe(false);
    expect(classify(user, { DEFT_SESSION_ID: "host:claude:v1:x" }).inClass).toBe(true);
  });

  it("resolves a relative exclusion value against the working directory", () => {
    mkdirSync(join(home, "notes"));
    const user = join(home, "notes", "USER.md");
    const verdict = classify(
      user,
      { DEFT_USER_PATH: join("notes", "USER.md") },
      { cwd: () => home },
    );
    expect(verdict.inClass).toBe(false);
  });

  it("catches a not-yet-existing excluded file named through a link", () => {
    mkdirSync(join(home, "notes"));
    if (!linkDir(join(home, "notes"), join(home, "alias"))) return;
    const typedThroughAlias = join(home, "alias", "USER.md");
    const verdict = classify(join(home, "notes", "USER.md"), { DEFT_USER_PATH: typedThroughAlias });
    expect(verdict.inClass).toBe(false);
  });

  it("refuses a target inside a directory listed in PATH", () => {
    const bin = join(home, "bin");
    const sepChar = process.platform === "win32" ? ";" : ":";
    expect(classify(join(bin, "tool"), { PATH: `relative${sepChar}${bin}` }).inClass).toBe(false);
  });

  it("refuses a target inside the running Directive runtime package", () => {
    const rt = join(home, "rt");
    mkdirSync(rt);
    expect(classify(join(rt, "x.js"), {}, { runtimePackageDir: rt }).inClass).toBe(false);
    expect(defaultRuntimePackageDir()).not.toBeNull();
    expect(statSync(join(defaultRuntimePackageDir() as string, "package.json")).isFile()).toBe(
      true,
    );
  });
});

describe("doubt rules (#6376 item 6)", () => {
  it("refuses a relative typed path and a non-drive path on Windows", () => {
    expect(classify("notes/x.md")).toEqual({ inClass: false, reason: "relative typed path" });
    expect(classify("/tmp/x.md", {}, { platform: "win32" }).inClass).toBe(false);
  });

  it("refuses parent and current-directory steps instead of collapsing them", () => {
    const repo = join(base, "repo");
    mkdirSync(join(repo, "build"), { recursive: true });
    mkdirSync(join(repo, ".git"));
    linkDir(join(repo, "build"), join(temp, "link"));
    const parentStep = `${join(temp, "link")}/../file.md`;
    expect(classify(parentStep)).toEqual({
      inClass: false,
      reason: "parent or current-directory step in the typed path",
    });
    expect(classify(`${temp}/./file.md`).inClass).toBe(false);
  });

  it("refuses device and network-share prefixes", () => {
    for (const target of ["\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x"]) {
      expect(classify(target)).toEqual({
        inClass: false,
        reason: "device or network-share prefix",
      });
    }
    expect(classify("   ").inClass).toBe(false);
  });

  it("refuses short-name, trailing dot or space, and colon components", () => {
    expect(classify(join(temp, "PROGRA~1", "x")).inClass).toBe(false);
    expect(classify(`${join(temp, "name.")}/x`).inClass).toBe(false);
    expect(classify(`${join(temp, "name ")}/x`).inClass).toBe(false);
    expect(classify(join(temp, "a:b", "x")).inClass).toBe(false);
  });

  it("refuses an existing file with two hard links", () => {
    const one = join(temp, "h1.md");
    writeFileSync(one, "x");
    linkSync(one, join(temp, "h2.md"));
    expect(classify(one)).toEqual({
      inClass: false,
      reason: "existing target file has more than one hard link",
    });
  });

  it("refuses an unresolvable home or temp directory", () => {
    expect(classify(join(temp, "x"), {}, { homedir: () => join(base, "missing") })).toEqual({
      inClass: false,
      reason: "a home directory cannot be resolved",
    });
    expect(classify(join(temp, "x"), { HOME: "relative/home" }).inClass).toBe(false);
    expect(classify(join(temp, "x"), {}, { tmpdir: () => join(base, "gone") })).toEqual({
      inClass: false,
      reason: "the OS temp directory cannot be resolved",
    });
  });

  it("refuses a link whose target cannot be resolved", () => {
    const dangle = join(temp, "dangle");
    mkdirSync(dangle);
    const verdict = classify(
      join(dangle, "x.md"),
      {},
      {
        realpath: (p: string) => {
          if (p.endsWith("dangle")) throw new Error("ENOENT");
          return realpathSync.native(p);
        },
      },
    );
    expect(verdict).toEqual({ inClass: false, reason: "a link on the path cannot be resolved" });
  });

  it("refuses unreadable components and a file used as a folder", () => {
    writeFileSync(join(temp, "file.txt"), "x");
    expect(classify(join(temp, "file.txt", "x")).inClass).toBe(false);
    const eacces = classify(
      join(temp, "x"),
      {},
      {
        lstat: () => {
          const err = new Error("denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        },
      },
    );
    expect(eacces.inClass).toBe(false);
    const stat = classify(
      join(temp, "x"),
      {},
      {
        lstat: (p: string): Stats => statSync(p),
        stat: () => {
          throw new Error("stat failed");
        },
      },
    );
    expect(stat).toEqual({ inClass: false, reason: "a resolved component cannot be read" });
    const root = classify(
      join(temp, "x"),
      {},
      {
        realpath: (p: string) => {
          if (p === realpathSync.native(p) && p.length <= 3) throw new Error("root");
          return realpathSync.native(p);
        },
      },
    );
    expect(root.inClass).toBe(false);
  });

  it("refuses through an ordinary home folder linked into a checkout or a config area", () => {
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    if (!linkDir(repo, join(home, "linked"))) return;
    expect(classify(join(home, "linked", "src", "x.ts")).inClass).toBe(false);
    mkdirSync(join(home, ".config"));
    if (!linkDir(join(home, ".config"), join(home, "cfglink"))) return;
    expect(classify(join(home, "cfglink", "x")).inClass).toBe(false);
  });

  it("never throws: a failing seam is out of the class", () => {
    const verdict = classify(
      join(temp, "x"),
      {},
      {
        homedir: () => {
          throw new Error("boom");
        },
      },
    );
    expect(verdict.inClass).toBe(false);
  });
});

describe("combining rule (#6376 item 8)", () => {
  it("needs a non-empty set whose every target is in the class", () => {
    const s = seams();
    expect(allTargetsOutsideEveryCheckout(payload, [], {}, s)).toBe(false);
    expect(allTargetsOutsideEveryCheckout(payload, [join(temp, "a"), join(temp, "b")], {}, s)).toBe(
      true,
    );
    expect(
      allTargetsOutsideEveryCheckout(payload, [join(temp, "a"), join(home, ".x", "b")], {}, s),
    ).toBe(false);
    expect(
      allTargetsOutsideEveryCheckout(
        payload,
        [join(temp, "a")],
        {},
        {
          ...s,
          tmpdir: () => join(base, "gone"),
        },
      ),
    ).toBe(false);
    expect(
      allTargetsOutsideEveryCheckout(
        payload,
        [join(temp, "a")],
        {},
        {
          ...s,
          homedir: () => {
            throw new Error("boom");
          },
        },
      ),
    ).toBe(false);
  });
});

describe("native path identity, no case folding for location (#6376 round 3)", () => {
  it("compares names exactly for location and folds only for exclusions", () => {
    expect(pathInside("/Users/ALICE/x.md", "/Users/alice", "darwin", "exact")).toBeNull();
    expect(pathInside("/Users/ALICE/x.md", "/Users/alice", "darwin", "exclusion")).toEqual([
      "x.md",
    ]);
    expect(pathInside("/Users/ALICE/x.md", "/Users/alice", "linux", "exclusion")).toBeNull();
    expect(pathInside("C:\\USERS\\a\\x", "C:\\Users\\a", "win32", "exact")).toBeNull();
    expect(pathInside("c:\\Users\\a\\x", "C:\\Users\\a", "win32", "exact")).toEqual(["x"]);
    expect(pathInside("/a", "/a/b", "linux", "exact")).toBeNull();
    expect(pathInside("/a/b", "/a/b", "linux", "exact")).toEqual([]);
  });

  it("keeps a case-variant sibling of home out on a case-sensitive volume", () => {
    const alice = join(base, "alice");
    const upper = join(base, "ALICE");
    mkdirSync(alice);
    let distinct = false;
    try {
      mkdirSync(upper);
      distinct = statSync(alice).ino !== statSync(upper).ino;
    } catch {
      distinct = false;
    }
    // A case-insensitive volume has only one folder; the simulation needs two.
    if (!distinct) return;
    const verdict = classify(
      join(upper, "n.md"),
      {},
      { homedir: () => alice, platform: process.platform === "win32" ? "win32" : "darwin" },
    );
    expect(verdict.inClass).toBe(false);
    expect(classify(join(alice, "n.md"), {}, { homedir: () => alice }).inClass).toBe(true);
  });
});

describe("original target spelling (#6376 round 3)", () => {
  it("keeps a target the harvest trimmed or decoded out of the class", () => {
    const t = "/tmp/note";
    expect(targetsKeepOriginalSpelling({ tool_input: { file_path: t } }, [t])).toBe(true);
    expect(targetsKeepOriginalSpelling({ tool_input: { file_path: `${t} ` } }, [t])).toBe(false);
    expect(targetsKeepOriginalSpelling({ tool_input: { file_path: ` ${t}` } }, [t])).toBe(false);
    expect(targetsKeepOriginalSpelling({ tool_input: { file_path: `file://${t}` } }, [t])).toBe(
      false,
    );
    expect(targetsKeepOriginalSpelling({ tool_input: { file_path: t } }, [])).toBe(false);
  });

  it("reads ApplyPatch headers verbatim", () => {
    const body = (line: string) => ({
      tool_input: { patch: `*** Begin Patch\n${line}\n+x\n*** End Patch` },
    });
    expect(targetsKeepOriginalSpelling(body("*** Update File: /tmp/a"), ["/tmp/a"])).toBe(true);
    expect(targetsKeepOriginalSpelling(body("*** Update File: /tmp/a "), ["/tmp/a"])).toBe(false);
    expect(targetsKeepOriginalSpelling(body("*** Add File:  /tmp/a"), ["/tmp/a"])).toBe(false);
    expect(targetsKeepOriginalSpelling(body("*** Move to: /tmp/a"), ["/tmp/a"])).toBe(true);
  });
});

describe("the checkout folder (#6871)", () => {
  function git(cwd: string, args: readonly string[]): void {
    execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: "pipe" });
  }

  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@t.dev"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["commit", "--allow-empty", "-q", "-m", "base"]);
  }

  /** `<folder>/main` is the main worktree; `<folder>/wt` is a plain folder. */
  function checkout(folderName = "checkouts"): { folder: string; main: string; wt: string } {
    const folder = join(base, folderName);
    const main = join(folder, "main");
    const wt = join(folder, "wt");
    initRepo(main);
    mkdirSync(wt, { recursive: true });
    return { folder, main, wt };
  }

  function classifyAt(root: string, target: string, env: NodeJS.ProcessEnv = {}) {
    return classifyOutsideEveryCheckoutTarget(root, target, env, seams());
  }

  it("admits a plain folder beside the main worktree, from the main or a linked worktree", () => {
    const { main, wt } = checkout();
    expect(classifyAt(main, join(wt, "notes.md"))).toEqual({ inClass: true });
    const linked = join(wt, "story");
    git(main, ["worktree", "add", "--detach", "-q", linked]);
    expect(classifyAt(linked, join(wt, "notes.md"))).toEqual({ inClass: true });
  });

  it("skips the name rule only for the checkout folder's own components", () => {
    const { folder, main, wt } = checkout("deft-checkouts");
    expect(classifyAt(main, join(wt, "notes.md"))).toEqual({ inClass: true });
    for (const below of [".deft-scratch", "deft-state", "directive-notes"]) {
      const verdict = classifyAt(main, join(folder, below, "x"));
      expect(verdict, below).toMatchObject({ inClass: false });
      expect(JSON.stringify(verdict)).toContain("deft or directive");
    }
  });

  it("keeps every other rule inside the checkout folder", () => {
    const { folder, main, wt } = checkout();
    const marked = join(folder, "marked");
    mkdirSync(join(marked, ".deft"), { recursive: true });
    expect(classifyAt(main, join(marked, "x.md")).inClass).toBe(false);
    const gitAncestor = join(folder, "gitted");
    mkdirSync(join(gitAncestor, ".git"), { recursive: true });
    expect(classifyAt(main, join(gitAncestor, "x.md")).inClass).toBe(false);
    const other = join(folder, "other-repo");
    initRepo(other);
    expect(classifyAt(main, join(other, "x.md")).inClass).toBe(false);
    expect(classifyAt(main, join(wt, "n.md"), { DEFT_STATE: wt }).inClass).toBe(false);
    expect(classifyAt(main, join(main, "x.md")).inClass).toBe(false);
  });

  it("has no checkout folder when the payload root is not a repository", () => {
    const { wt } = checkout();
    const verdict = classifyAt(payload, join(wt, "notes.md"));
    expect(verdict).toMatchObject({ inClass: false });
    expect(JSON.stringify(verdict)).toContain("nor in the checkout folder");
  });

  it("has no checkout folder for a bare repository", () => {
    const { main } = checkout();
    const bareRepo = join(base, "bare-host", "repo.git");
    mkdirSync(join(base, "bare-host"), { recursive: true });
    git(base, ["clone", "-q", "--bare", main, bareRepo]);
    const linked = join(base, "bare-host", "linked");
    git(bareRepo, ["worktree", "add", "--detach", "-q", linked]);
    const verdict = classifyAt(linked, join(base, "bare-host", "notes.md"));
    expect(verdict).toMatchObject({ inClass: false });
    expect(JSON.stringify(verdict)).toContain("nor in the checkout folder");
  });

  it("has no checkout folder when the main worktree's parent is a filesystem root", () => {
    const rootCommon = resolve("/.git");
    const verdict = classifyOutsideEveryCheckoutTarget(
      payload,
      join(base, "elsewhere", "n.md"),
      {},
      seams({
        realpath: (p) => (p === rootCommon ? p : realpathSync.native(p)),
        runGit: (_cwd, args) =>
          args.includes("--git-common-dir")
            ? { code: 0, stdout: `${rootCommon}\n`, stderr: "" }
            : args.includes("--is-bare-repository")
              ? { code: 0, stdout: "false\n", stderr: "" }
              : { code: 128, stdout: "", stderr: "fatal: not a git repository" },
      }),
    );
    expect(verdict).toMatchObject({ inClass: false });
    expect(JSON.stringify(verdict)).toContain("nor in the checkout folder");
  });

  it("keeps today's rules when the checkout folder is inside a home directory", () => {
    const folder = join(home, "deft-src");
    const main = join(folder, "main");
    initRepo(main);
    mkdirSync(join(folder, "wt"), { recursive: true });
    const verdict = classifyAt(main, join(folder, "wt", "n.md"));
    expect(verdict).toMatchObject({ inClass: false });
    expect(JSON.stringify(verdict)).toContain("deft or directive");
  });
});

describe("deftTempName (#6376 item 12)", () => {
  it("keeps a name that carries deft and prefixes one that does not", () => {
    expect(deftTempName("deft-cache-")).toBe("deft-cache-");
    expect(deftTempName("cache-")).toBe("deft-cache-");
  });
});

describe("agy conversation-folder carve-out (#7445)", () => {
  const ID = "conv-aaaa-1111";
  let brain = "";
  let own = "";

  beforeEach(() => {
    brain = join(home, ".gemini", "antigravity", "brain");
    own = join(brain, ID);
    mkdirSync(own, { recursive: true });
    mkdirSync(join(brain, "conv-bbbb-2222"), { recursive: true });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  });

  function allowed(
    target: string,
    agy: OutsideEveryCheckoutSeams["agyConversation"] = {
      conversationId: ID,
      artifactDirectoryPath: null,
    },
  ): boolean {
    return allTargetsOutsideEveryCheckout(payload, [target], {}, seams({ agyConversation: agy }));
  }

  it("allows a write inside the current conversation folder, a new file included", () => {
    expect(allowed(join(own, "plan.md"))).toBe(true);
    expect(allowed(join(own, "sub", "new", "a.md"))).toBe(true);
  });

  it("stays gated without the carve-out seam", () => {
    expect(allowed(join(own, "plan.md"), null)).toBe(false);
  });

  it("gates a sibling conversation's folder", () => {
    expect(allowed(join(brain, "conv-bbbb-2222", "x.md"))).toBe(false);
  });

  it("gates config/ and the brain folder itself", () => {
    expect(allowed(join(home, ".gemini", "config", "settings.json"))).toBe(false);
    expect(allowed(join(brain, "x.md"))).toBe(false);
    expect(allowed(own)).toBe(false);
  });

  it("gates a .. escape", () => {
    expect(allowed(`${own}/../conv-bbbb-2222/x.md`)).toBe(false);
    expect(allowed(`${own}/../../../config/x.md`)).toBe(false);
  });

  it("gates a link that leaves the conversation folder", () => {
    if (!linkDir(join(home, ".gemini", "config"), join(own, "escape"))) return;
    expect(allowed(join(own, "escape", "x.md"))).toBe(false);
    if (!linkDir(join(brain, "conv-bbbb-2222"), join(own, "sibling"))) return;
    expect(allowed(join(own, "sibling", "x.md"))).toBe(false);
  });

  it("gates a conversation folder that is itself a link out of the brain folder", () => {
    const other = "conv-cccc-3333";
    if (!linkDir(join(home, ".gemini", "config"), join(brain, other))) return;
    expect(
      allowed(join(brain, other, "x.md"), { conversationId: other, artifactDirectoryPath: null }),
    ).toBe(false);
  });

  it("gates an unsafe conversation id", () => {
    for (const bad of ["", "..", ".", "a/b", "a\\b", "conv-aaaa-1111/.."]) {
      expect(allowed(join(own, "x.md"), { conversationId: bad, artifactDirectoryPath: null })).toBe(
        false,
      );
    }
  });

  it("accepts a matching artifactDirectoryPath and gates a mismatched one", () => {
    const wrong = [
      join(brain, "conv-bbbb-2222"),
      join(home, ".gemini"),
      join(home, ".gemini", "config"),
      join(own, "sub"),
      "",
      "relative/path",
    ];
    expect(allowed(join(own, "p.md"), { conversationId: ID, artifactDirectoryPath: own })).toBe(
      true,
    );
    for (const artifactDirectoryPath of wrong) {
      expect(allowed(join(own, "p.md"), { conversationId: ID, artifactDirectoryPath })).toBe(false);
    }
    // A payload folder never admits another conversation's target.
    expect(
      allowed(join(brain, "conv-bbbb-2222", "p.md"), {
        conversationId: ID,
        artifactDirectoryPath: join(brain, "conv-bbbb-2222"),
      }),
    ).toBe(false);
  });

  it("accepts the antigravity-cli root for the current id only", () => {
    const cli = join(home, ".gemini", "antigravity-cli", "brain");
    mkdirSync(join(cli, ID), { recursive: true });
    mkdirSync(join(cli, "conv-bbbb-2222"), { recursive: true });
    mkdirSync(join(home, ".gemini", "antigravity-cli", "config"), { recursive: true });
    expect(allowed(join(cli, ID, "plan.md"))).toBe(true);
    expect(
      allowed(join(cli, ID, "plan.md"), {
        conversationId: ID,
        artifactDirectoryPath: join(cli, ID),
      }),
    ).toBe(true);
    expect(allowed(join(cli, "conv-bbbb-2222", "x.md"))).toBe(false);
    expect(allowed(join(home, ".gemini", "antigravity-cli", "config", "x.json"))).toBe(false);
    expect(allowed(join(home, ".gemini", "antigravity-cli", "x.md"))).toBe(false);
    // Mismatched artifactDirectoryPath: other id, the other root's folder, a parent.
    for (const artifactDirectoryPath of [
      join(cli, "conv-bbbb-2222"),
      own,
      cli,
      join(home, ".gemini"),
    ]) {
      expect(allowed(join(cli, ID, "p.md"), { conversationId: ID, artifactDirectoryPath })).toBe(
        false,
      );
    }
    // The same cross-check holds for the desktop root.
    expect(
      allowed(join(own, "p.md"), { conversationId: ID, artifactDirectoryPath: join(cli, ID) }),
    ).toBe(false);
    // A third root under ~/.gemini is never admitted.
    mkdirSync(join(home, ".gemini", "other", "brain", ID), { recursive: true });
    expect(allowed(join(home, ".gemini", "other", "brain", ID, "x.md"))).toBe(false);
  });

  it("requires every target in a set to qualify", () => {
    expect(
      allTargetsOutsideEveryCheckout(
        payload,
        [join(own, "a.md"), join(home, ".gemini", "config", "b.json")],
        {},
        seams({ agyConversation: { conversationId: ID, artifactDirectoryPath: null } }),
      ),
    ).toBe(false);
  });

  it("builds the seam from the agy identity and payload folder; null otherwise", () => {
    const payloadOk = { conversationId: ID, artifactDirectoryPath: own };
    expect(agyConversationSeam("agy", payloadOk, {})).toEqual({
      conversationId: ID,
      artifactDirectoryPath: own,
    });
    expect(agyConversationSeam("agy", { conversationId: ID }, {})).toEqual({
      conversationId: ID,
      artifactDirectoryPath: null,
    });
    expect(
      agyConversationSeam("agy", { conversationId: ID, artifactDirectoryPath: 5 }, {}),
    ).toEqual({ conversationId: ID, artifactDirectoryPath: "" });
    expect(agyConversationSeam("claude", payloadOk, {})).toBeNull();
    expect(agyConversationSeam("agy", {}, {})).toBeNull();
    expect(agyConversationSeam("agy", { conversationId: "../x" }, {})).toBeNull();
  });
});
