import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateDurableEffectAcquisition, readLivePresentationSource } from "./evaluate.js";
import { PRESENTATION_CEILING_ARTIFACT_REL, PRESENTATION_CEILING_SCHEMA } from "./types.js";

const CEILING = `${JSON.stringify({
  schema: PRESENTATION_CEILING_SCHEMA,
  changeClass: "presentation",
})}\n`;

const SAFE_FORM = '<form method="get" action="/orders"></form>';
const UNSAFE_FORM = '<form method="post" action="/orders"></form>';

function files(head: Record<string, string>, base?: Record<string, string>) {
  const changed = Object.keys(head);
  const baseFiles: Record<string, string> = {
    [PRESENTATION_CEILING_ARTIFACT_REL]: CEILING,
    ...(base ?? {}),
  };
  return {
    projectRoot: process.cwd(),
    mergeBase: "injected",
    changedFiles: changed,
    presentationFiles: changed.filter((p) => /\.(html|jsx|tsx)$/i.test(p)),
    readAtBase: (rel: string) => baseFiles[rel] ?? null,
    readAtHead: (rel: string) => head[rel] ?? baseFiles[rel] ?? null,
  };
}

describe("evaluateDurableEffectAcquisition (#5080)", () => {
  it.each([
    ["src/A.html", '<div style="CSS"></div>', "background:url(/a)"],
    ["src/A.html", "<style>CSS</style>", ".a{background:url(/a)}"],
    ["src/A.tsx", '<div style="CSS"/>', "background:url(/a)"],
    ["src/A.tsx", '<div style={"CSS"}/>', "background:url(/a)"],
    ["src/A.tsx", '<div style={{background:"CSS"}}/>', "url(/a)"],
    ["src/A.tsx", '<style>{"CSS"}</style>', ".a{background:url(/a)}"],
  ])("compares CSS occurrences rather than whole source in %s %s", (path, wrap, css) => {
    const source = (value: string) => wrap.replace("CSS", () => value);
    const base = source(css);
    const color = wrap.includes('background:"CSS"')
      ? base.replace("background:", 'color:"red",background:')
      : source(css.replace("url(/a)", "url(/a);color:red"));
    for (const head of [
      color,
      source(css.replace("url(/a)", "url( '/a' ) /*note*/")),
      source("color:red"),
    ])
      expect(evaluateDurableEffectAcquisition(files({ [path]: head }, { [path]: base })).code).toBe(
        0,
      );
    for (const head of [
      source(css.replace("/a", "/b")),
      source(css.replace("url(/a)", "url(/a),url(/a)")),
    ])
      expect(evaluateDurableEffectAcquisition(files({ [path]: head }, { [path]: base })).code).toBe(
        1,
      );
  });
  it.each([
    "src/Form.html",
    "src/Form.tsx",
  ])("keeps submission identity separate from independently checked attributes in %s", (path) => {
    const base = '<form method="post" action="/orders"></form>';
    for (const attr of ['data-testid="orders"', 'unknown="harmless"', 'class="wide"']) {
      expect(
        evaluateDurableEffectAcquisition(
          files({ [path]: base.replace("<form", `<form ${attr}`) }, { [path]: base }),
        ).code,
      ).toBe(0);
    }
    for (const head of [
      base.replace("/orders", "/different"),
      base.replace("post", "delete"),
      `${base}${base}`,
      base.replace("<form", '<form data-testid="https://collector.example/p"'),
    ]) {
      expect(evaluateDurableEffectAcquisition(files({ [path]: head }, { [path]: base })).code).toBe(
        1,
      );
    }
  });
  it("still executes expression analysis outside submission identity", () => {
    const path = "src/Form.tsx";
    const base = '<form method="post" action="/orders" />';
    for (const attr of [
      `data-testid={localStorage.setItem('key','value')}`,
      `title={localStorage.setItem('key','value')}`,
    ]) {
      expect(
        evaluateDurableEffectAcquisition(
          files({ [path]: base.replace("<form", `<form ${attr}`) }, { [path]: base }),
        ).code,
      ).toBe(1);
    }
    expect(
      evaluateDurableEffectAcquisition(
        files(
          { [path]: `const action='/new';<form method="post" action={action}/>` },
          { [path]: `const action='/old';<form method="post" action={action}/>` },
        ),
      ).code,
    ).toBe(1);
  });
  it.each([
    "src/Page.html",
    "src/Page.tsx",
  ])("preserves other acquisition targets without unrelated-attribute churn in %s", (path) => {
    for (const base of [
      '<iframe src="/old"></iframe>',
      '<script src="/old"></script>',
      '<embed src="/old"/>',
      '<object data="/old"></object>',
      '<meta http-equiv="refresh" content="0;url=/old"/>',
      '<div style="background:url(/old)"></div>',
      '<button formaction="/old"></button>',
    ]) {
      const head = base.replace(/^(<\w+)/, '$1 data-testid="channel"');
      expect(evaluateDurableEffectAcquisition(files({ [path]: head }, { [path]: base })).code).toBe(
        0,
      );
      expect(
        evaluateDurableEffectAcquisition(
          files({ [path]: base.replace("/old", "/new") }, { [path]: base }),
        ).code,
      ).toBe(1);
    }
  });
  it("applies each typed merge-base grant at its supplying edge", () => {
    const grants = JSON.stringify({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: "presentation",
      admittedPaths: ["src/helper.ts", "src/approved.tsx"],
      admittedPackages: ["approved-package"],
      admittedGlobals: [{ name: "approvedReader", members: ["read"] }],
      admittedOrigins: ["https://approved.example"],
      humanApproval: { kind: "human", actor: "David", mintedAt: "2026-09-28T00:00:00Z" },
    });
    const base = { [PRESENTATION_CEILING_ARTIFACT_REL]: grants };
    for (const path of ["index.html", "src/Base.tsx"]) {
      expect(
        evaluateDurableEffectAcquisition(
          files({ [path]: '<base href="https://approved.example/" />' }, base),
        ).code,
      ).toBe(1);
      expect(
        evaluateDurableEffectAcquisition(files({ [path]: '<base href="/" />' }, base)).code,
      ).toBe(0);
    }
    expect(
      evaluateDurableEffectAcquisition(
        files(
          {
            "src/A.tsx": `import { read } from './helper.ts'; import p from 'approved-package';
        approvedReader.read(); fetch('https://approved.example/data');`,
            "src/approved.tsx": `localStorage.setItem('key','value');`,
          },
          base,
        ),
      ).code,
    ).toBe(0);
    expect(
      evaluateDurableEffectAcquisition(
        files(
          {
            "src/A.tsx": `approvedReader.write();`,
          },
          base,
        ),
      ).code,
    ).toBe(1);
    expect(
      evaluateDurableEffectAcquisition(
        files(
          {
            "src/nested/A.tsx": `import {read} from './helper.ts';`,
          },
          base,
        ),
      ).code,
    ).toBe(1);
  });

  it.each(["base", "head"])("reports failed %s reads without treating them as absence", (side) => {
    const inputs = files({ "src/A.html": "<p>safe</p>" });
    const read = side === "base" ? inputs.readAtBase : inputs.readAtHead;
    const failedRead = (path: string) =>
      path === PRESENTATION_CEILING_ARTIFACT_REL ? { error: "fixture read denied" } : read(path);
    const result = evaluateDurableEffectAcquisition({
      ...inputs,
      ...(side === "base" ? { readAtBase: failedRead } : { readAtHead: failedRead }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("fixture read denied");
  });

  it.each(["base", "head"])("refuses malformed %s ceilings", (side) => {
    const inputs = files({ "src/A.html": "<p>safe</p>" });
    const read = side === "base" ? inputs.readAtBase : inputs.readAtHead;
    const malformed = (path: string) =>
      path === PRESENTATION_CEILING_ARTIFACT_REL ? "{" : read(path);
    expect(
      evaluateDurableEffectAcquisition({
        ...inputs,
        ...(side === "base" ? { readAtBase: malformed } : { readAtHead: malformed }),
      }).code,
    ).toBe(1);
  });

  it("protects existing verifier code and reports parser refusals", () => {
    const path = "packages/core/src/durable-effect-acquisition/evaluate.ts";
    expect(
      evaluateDurableEffectAcquisition(files({ [path]: "changed" }, { [path]: "base" })).code,
    ).toBe(1);
    expect(evaluateDurableEffectAcquisition(files({ "src/A.tsx": "const =" })).code).toBe(1);
    expect(
      evaluateDurableEffectAcquisition({ ...files({ "src/A.html": "<p>safe</p>" }), quiet: true })
        .stream,
    ).toBe("none");
  });

  it.each([
    ["src/A.html", '<form method="post" action="/a"></form>'],
    ["src/A.tsx", `export function f(){localStorage.setItem('k','v');}`],
  ])("preserves multiplicity and ignores shifts in %s", (path, source) => {
    expect(
      evaluateDurableEffectAcquisition(
        files({ [path]: `\n<!-- text -->\n${source}` }, { [path]: source }),
      ).code,
    ).toBe(path.endsWith(".html") ? 0 : 1);
    const shifted = path.endsWith(".html")
      ? `<p>new text</p>\n${source}`
      : `// new text\n${source}`;
    expect(
      evaluateDurableEffectAcquisition(files({ [path]: shifted }, { [path]: source })).code,
    ).toBe(0);
    expect(
      evaluateDurableEffectAcquisition(
        files({ [path]: `${source}\n${source}` }, { [path]: source }),
      ).code,
    ).toBe(1);
  });

  it("refuses changed arguments at existing effect sites", () => {
    expect(
      evaluateDurableEffectAcquisition(
        files(
          { "src/A.html": '<style>@import "https://new.example/style";</style>' },
          { "src/A.html": '<style>@import "https://old.example/style";</style>' },
        ),
      ).code,
    ).toBe(1);
    const escaped = `const options={method:'GET'};function mutate(x){x.method='POST';}mutate(options);`;
    expect(
      evaluateDurableEffectAcquisition(
        files({ "src/A.tsx": `${escaped}fetch('/orders',options);` }, { "src/A.tsx": escaped }),
      ).code,
    ).toBe(1);
    const base = `const options={method:'GET'};const alias=options;alias.method='POST';`;
    expect(
      evaluateDurableEffectAcquisition(
        files({ "src/A.tsx": `${base} fetch('/orders',options);` }, { "src/A.tsx": base }),
      ).code,
    ).toBe(1);
    const imageBase = `const data={src:'/safe'};const alias=data;alias.src='https://collector.example/p';`;
    expect(
      evaluateDurableEffectAcquisition(
        files({ "src/A.tsx": `${imageBase} <img src={data.src}/>;` }, { "src/A.tsx": imageBase }),
      ).code,
    ).toBe(1);
    expect(
      evaluateDurableEffectAcquisition(
        files(
          { "src/A.tsx": `const endpoint='/new'; fetch(endpoint,{method:'POST'});` },
          { "src/A.tsx": `const endpoint='/old'; fetch(endpoint,{method:'POST'});` },
        ),
      ).code,
    ).toBe(1);
    expect(
      evaluateDurableEffectAcquisition(
        files(
          { "src/A.html": '<form method="post" action="/b"></form>' },
          { "src/A.html": '<form method="post" action="/a"></form>' },
        ),
      ).code,
    ).toBe(1);
    expect(
      evaluateDurableEffectAcquisition(
        files(
          { "src/A.tsx": `localStorage.setItem('k','new');` },
          { "src/A.tsx": `localStorage.setItem('k','old');` },
        ),
      ).code,
    ).toBe(1);
  });
  it("passes off-ceiling in-class localStorage", () => {
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: ["src/Prefs.tsx"],
      presentationFiles: ["src/Prefs.tsx"],
      readAtBase: () => null,
      readAtHead: (rel) =>
        rel === "src/Prefs.tsx" ? "export function f(){ localStorage.setItem('k','v'); }\n" : null,
    });
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/off-ceiling/);
  });

  it("refuses localStorage under an armed ceiling", () => {
    const result = evaluateDurableEffectAcquisition(
      files({ "src/Prefs.tsx": "export function f(){ localStorage.setItem('k','v'); }\n" }),
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/durable-effect/);
  });

  it("refuses submitter formMethod", () => {
    const result = evaluateDurableEffectAcquisition(
      files({ "src/Form.tsx": 'export const B = () => <button formMethod="post">Go</button>;\n' }),
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/formMethod|formmethod|item-4/i);
  });

  it("refuses a non-sentinel base anywhere in-class", () => {
    const result = evaluateDurableEffectAcquisition({
      ...files({
        "src/Search.tsx": 'export const F = () => <form method="get" action="collect" />;\n',
      }),
      presentationFiles: ["index.html", "src/Search.tsx"],
      readAtBase: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? CEILING
          : rel === "index.html"
            ? '<base href="https://collector.example/">\n'
            : null,
      readAtHead: (rel) =>
        rel === "src/Search.tsx"
          ? 'export const F = () => <form method="get" action="collect" />;\n'
          : rel === PRESENTATION_CEILING_ARTIFACT_REL
            ? CEILING
            : rel === "index.html"
              ? '<base href="https://collector.example/">\n'
              : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/base/i);
  });

  it("cannot disarm by deleting the merge-base ceiling", () => {
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: ["src/Prefs.tsx", PRESENTATION_CEILING_ARTIFACT_REL],
      presentationFiles: ["src/Prefs.tsx"],
      readAtBase: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? CEILING
          : rel === "src/Prefs.tsx"
            ? "export const A = () => <div />;\n"
            : null,
      readAtHead: (rel) =>
        rel === "src/Prefs.tsx" ? "export function f(){ localStorage.setItem('k','v'); }\n" : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/durable-effect|localStorage|js-root/i);
  });

  it("refuses same-PR allowlist widening", () => {
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: [PRESENTATION_CEILING_ARTIFACT_REL, "src/A.tsx"],
      presentationFiles: ["src/A.tsx"],
      readAtBase: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? CEILING
          : rel === "src/A.tsx"
            ? 'export const A = () => <a href="/x" />;\n'
            : null,
      readAtHead: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? `${JSON.stringify({
              schema: PRESENTATION_CEILING_SCHEMA,
              changeClass: "presentation",
              admittedOrigins: ["https://example.com"],
            })}\n`
          : rel === "src/A.tsx"
            ? 'export const A = () => <a href="/x" />;\n'
            : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/allowlist/);
  });

  it("ignores head-only admitted origins on an add-only ceiling", () => {
    const headCeiling = `${JSON.stringify({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: "presentation",
      admittedOrigins: ["https://example.com"],
    })}\n`;
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: [PRESENTATION_CEILING_ARTIFACT_REL, "src/A.tsx"],
      presentationFiles: ["src/A.tsx"],
      readAtBase: () => null,
      readAtHead: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? headCeiling
          : rel === "src/A.tsx"
            ? 'export const A = () => <a href="https://example.com/docs">d</a>;\n'
            : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/durable-effect|origin|example.com/i);
  });

  it("continues a same-origin ordinary page under a ceiling", () => {
    const src = `export const Page = () => (
  <main>
    <a href="/search?q=a:b">s</a>
    <img src="/img/a.png" srcSet="/a.png 1x, /b.png 2x" />
    <form action="/search"><button>ok</button></form>
    <link rel="stylesheet" href="/app.css" />
    <meta httpEquiv="content-type" content="text/html" />
  </main>
);
`;
    const result = evaluateDurableEffectAcquisition(files({ "src/Page.tsx": src }));
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/pass/);
  });

  it("refuses a second POST form as a new channel", () => {
    const one = `<form method="post" action="/a"></form>\n`;
    const two = `<form method="post" action="/a"></form>\n<form method="post" action="/b"></form>\n`;
    const result = evaluateDurableEffectAcquisition(
      files({ "src/A.html": two }, { "src/A.html": one }),
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/form-method|durable-effect/);
  });
});

/** #4567 share-plus-reset: one git init, hard-reset between cases (#5140). */
const sharedTemps: string[] = [];
let sharedSnap: { root: string; head: string } | null = null;

function gitAt(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeAt(root: string, path: string, source: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), source);
}

function resetSharedSnap(): void {
  if (sharedSnap === null) return;
  const { root, head } = sharedSnap;
  gitAt(root, "checkout", "-q", "-f", "master");
  gitAt(root, "reset", "--hard", "-q", head);
  gitAt(root, "clean", "-fdq");
}

function buildSharedSnap(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "dea-git-"));
  sharedTemps.push(root);
  gitAt(root, "init", "--quiet", "-b", "master");
  gitAt(root, "config", "user.email", "fixture@example.test");
  gitAt(root, "config", "user.name", "Fixture");
  writeAt(root, "App.html", SAFE_FORM);
  writeAt(root, PRESENTATION_CEILING_ARTIFACT_REL, CEILING);
  gitAt(root, "add", ".");
  gitAt(root, "commit", "--quiet", "-m", "base");
  return { root, head: gitAt(root, "rev-parse", "HEAD") };
}

function sharedSnapshot(): {
  root: string;
  base: string;
  git: (...args: string[]) => string;
  write: (path: string, source: string) => void;
} {
  if (sharedSnap === null) sharedSnap = buildSharedSnap();
  const { root, head } = sharedSnap;
  return {
    root,
    base: head,
    git: (...args: string[]) => gitAt(root, ...args),
    write: (path, source) => writeAt(root, path, source),
  };
}

function reseedWithCeiling(
  ceilingPath: string,
  ceiling: string,
): { root: string; base: string; write: (path: string, source: string) => void } {
  const { root, git, write } = sharedSnapshot();
  // Drop seed files, then plant the case-specific ceiling shape and recommit.
  git("rm", "-rf", "--quiet", "--ignore-unmatch", ".");
  git("clean", "-fdq");
  write("App.html", SAFE_FORM);
  if (ceilingPath) write(ceilingPath, ceiling);
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  return { root, base: git("rev-parse", "HEAD"), write };
}

describe("actual git snapshots", () => {
  beforeAll(() => {
    sharedSnapshot();
  });

  afterEach(() => {
    resetSharedSnap();
  });

  afterAll(() => {
    for (const t of sharedTemps.splice(0)) rmSync(t, { recursive: true, force: true });
    sharedSnap = null;
  });

  it("reads working-tree bytes before committed HEAD", () => {
    const { root, git, write } = sharedSnapshot();
    write("src/A.tsx", "export const A = () => <a href='/ok' />;\n");
    git("add", "src/A.tsx");
    git("commit", "--quiet", "-m", "a");
    write("src/A.tsx", "export const A = () => <a href='https://collector.example/p' />;\n");
    const live = readLivePresentationSource(root, "src/A.tsx");
    expect(live).toContain("collector.example");
    expect(live).not.toContain("/ok");
  });

  it.each([
    "unstaged",
    "staged",
    "committed",
  ])("checks new effects and deletions in the %s snapshot", (mode) => {
    const { root, base, git, write } = sharedSnapshot();
    write("App.html", UNSAFE_FORM);
    if (mode !== "unstaged") git("add", ".");
    if (mode === "committed") git("commit", "--quiet", "-m", "effect");
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(1);
    unlinkSync(join(root, "App.html"));
    if (mode !== "unstaged") git("add", ".");
    if (mode === "committed") git("commit", "--quiet", "-m", "delete");
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(0);
  });

  it.each([
    "unstaged",
    "staged",
  ])("does not resurrect newly committed effects deleted %s", (mode) => {
    const { root, base, git, write } = sharedSnapshot();
    write("App.html", UNSAFE_FORM);
    git("add", ".");
    git("commit", "--quiet", "-m", "effect");
    unlinkSync(join(root, "App.html"));
    if (mode === "staged") git("add", ".");
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(0);
  });

  it("reads live bytes over staged bytes and handles unusual renamed paths", () => {
    const { root, base, git, write } = sharedSnapshot();
    write("App.html", UNSAFE_FORM);
    git("add", ".");
    write("App.html", SAFE_FORM);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(0);
    // Win32 forbids control chars (including newline) in filenames; spaces +
    // unicode still exercise unusual-path handling without ENOENT on rename.
    const unusual = "Space and ünicode.html";
    renameSync(join(root, "App.html"), join(root, unusual));
    write(unusual, UNSAFE_FORM);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(1);
  });

  it.skipIf(process.platform === "win32")("handles POSIX newline pathname renames (#5140)", () => {
    const { root, base, git, write } = sharedSnapshot();
    write("App.html", UNSAFE_FORM);
    git("add", ".");
    write("App.html", SAFE_FORM);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(0);
    const unusual = "Space\nand ünicode.html";
    renameSync(join(root, "App.html"), join(root, unusual));
    write(unusual, UNSAFE_FORM);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(1);
  });

  it.each([
    ["xbrief/active/a.xbrief.json", { plan: { "x-directive/changeClass": "presentation" } }],
    [
      "xbrief/pending/a.xbrief.json",
      { plan: { "x-directive/changeClass": { changeClass: "presentation" } } },
    ],
    [
      "xbrief/proposed/a.xbrief.json",
      { plan: { metadata: { "x-directive/changeClass": "presentation" } } },
    ],
    [
      "xbrief/active/a.xbrief.json",
      { plan: { metadata: { "x-directive/changeClass": { changeClass: "presentation" } } } },
    ],
    ["policy/presentation-ceiling.json", { changeClass: "presentation" }],
  ])("discovers #5056 shape at %s", (path, payload) => {
    const { root, base, write } = reseedWithCeiling(path as string, JSON.stringify(payload));
    write("App.html", UNSAFE_FORM);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(1);
  });

  it("retains deleted base ceilings and arms untracked restrictions", () => {
    const { root, base, write } = sharedSnapshot();
    unlinkSync(join(root, PRESENTATION_CEILING_ARTIFACT_REL));
    write("App.html", UNSAFE_FORM);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(1);
  });

  it("arms a new untracked restriction", () => {
    const { root, base, write } = reseedWithCeiling("", "");
    write(PRESENTATION_CEILING_ARTIFACT_REL, CEILING);
    write("App.html", UNSAFE_FORM);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(1);
  });

  it("distinguishes I/O failure from deletion", () => {
    const { root, base } = sharedSnapshot();
    unlinkSync(join(root, "App.html"));
    mkdirSync(join(root, "App.html"));
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: base }).code).toBe(2);
  });

  it("reports failed git snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "dea-not-git-"));
    sharedTemps.push(root);
    expect(evaluateDurableEffectAcquisition({ projectRoot: root, mergeBase: "missing" }).code).toBe(
      2,
    );
  });
});

describe("merge-base ref discovery (#5104)", () => {
  const discoverTemps: string[] = [];
  let discoverRoot: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (discoverRoot !== null && existsSync(discoverRoot)) {
      rmSync(join(discoverRoot, ".git"), { recursive: true, force: true });
      for (const name of ["App.html", "policy", "xbrief", ".deft"]) {
        rmSync(join(discoverRoot, name), { recursive: true, force: true });
      }
    }
  });

  afterAll(() => {
    for (const t of discoverTemps.splice(0)) rmSync(t, { recursive: true, force: true });
    discoverRoot = null;
  });

  function discoverRepo(opts: {
    branch: string;
    remoteRefs?: readonly string[];
    files?: Record<string, string>;
  }): string {
    if (discoverRoot === null) {
      discoverRoot = mkdtempSync(join(tmpdir(), "dea-discover-"));
      discoverTemps.push(discoverRoot);
    }
    const root = discoverRoot;
    const git = (...args: string[]) => gitAt(root, ...args);
    git("init", "--quiet", "-b", opts.branch);
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Fixture");
    for (const [path, source] of Object.entries(opts.files ?? {})) {
      writeAt(root, path, source);
    }
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    for (const ref of opts.remoteRefs ?? []) git("update-ref", `refs/remotes/${ref}`, "HEAD");
    return root;
  }

  it("passes off-ceiling when only origin/main exists", () => {
    vi.stubEnv("DEFT_BASE_REF", undefined);
    vi.stubEnv("GITHUB_BASE_REF", undefined);
    const root = discoverRepo({
      branch: "feature",
      remoteRefs: ["origin/main"],
      files: { "App.html": UNSAFE_FORM },
    });
    const result = evaluateDurableEffectAcquisition({ projectRoot: root });
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/off-ceiling/);
  });

  it("returns a configuration error when no default base ref exists", () => {
    vi.stubEnv("DEFT_BASE_REF", undefined);
    vi.stubEnv("GITHUB_BASE_REF", undefined);
    const root = discoverRepo({
      branch: "topic",
      files: { "App.html": UNSAFE_FORM },
    });
    const result = evaluateDurableEffectAcquisition({ projectRoot: root });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/merge-base|base ref/);
  });

  it("still requires a merge-base when a ceiling is armed", () => {
    vi.stubEnv("DEFT_BASE_REF", undefined);
    vi.stubEnv("GITHUB_BASE_REF", undefined);
    const root = discoverRepo({
      branch: "topic",
      files: {
        [PRESENTATION_CEILING_ARTIFACT_REL]: CEILING,
        "App.html": UNSAFE_FORM,
      },
    });
    const result = evaluateDurableEffectAcquisition({ projectRoot: root });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/merge-base|base ref/);
  });

  it("evaluates an armed ceiling against origin/main when origin/master is absent", () => {
    vi.stubEnv("DEFT_BASE_REF", undefined);
    vi.stubEnv("GITHUB_BASE_REF", undefined);
    const root = discoverRepo({
      branch: "feature",
      remoteRefs: ["origin/main"],
      files: {
        [PRESENTATION_CEILING_ARTIFACT_REL]: CEILING,
        "App.html": SAFE_FORM,
      },
    });
    writeFileSync(join(root, "App.html"), UNSAFE_FORM);
    const result = evaluateDurableEffectAcquisition({ projectRoot: root });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/durable-effect/);
  });
});
