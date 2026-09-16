import { describe, expect, it } from "vitest";
import {
  extractMarkupFacts,
  extractSurface,
  isMarkupPath,
  isUndeclaredTemplatePath,
  SCRIPT_SENTINEL,
} from "./extract.js";

const PAGE = `
<nav aria-label="Primary">
  <button role="tab" aria-selected="true">Overview</button>
  <button role="tab">Details</button>
</nav>
<main>
  <h1>Dashboard</h1>
  <section id="card">
    <input name="title" />
    <button>Save</button>
    <table><thead><tr><th>Name</th><th>Status</th></tr></thead></table>
  </section>
</main>
`;

describe("parse5+typescript oracle (#4495)", () => {
  it("recognizes the closed first-ship suffix set", () => {
    expect(isMarkupPath("src/App.tsx")).toBe(true);
    expect(isMarkupPath("src/App.jsx")).toBe(true);
    expect(isMarkupPath("templates/page.html")).toBe(true);
    expect(isMarkupPath("src/app.ts")).toBe(false);
    expect(isMarkupPath("App.vue")).toBe(false);
    expect(isUndeclaredTemplatePath("App.vue")).toBe(true);
    expect(isUndeclaredTemplatePath("page.njk")).toBe(true);
    expect(isUndeclaredTemplatePath("ui.html")).toBe(false);
  });

  it("extracts tabs, headings, controls, columns, landmarks, containers from html", () => {
    const facts = extractMarkupFacts(PAGE, "ui.html");
    const ids = facts.map((f) => f.id);
    expect(ids).toContain("tab:Overview");
    expect(ids).toContain("tab:Details");
    expect(ids).toContain("tab-selected:Overview");
    expect(ids).toContain("heading:1:Dashboard");
    expect(ids).toContain("control:input:title");
    expect(ids).toContain("control:button:Save");
    expect(ids).toContain("table-column:Name");
    expect(ids).toContain("table-column:Status");
    expect(ids.some((id) => id.startsWith("landmark:nav:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("landmark:main:"))).toBe(true);
    expect(ids).toContain("container:section:card");
  });

  it("sees markup-visible selected tab in tsx, not state expressions", () => {
    const facts = extractMarkupFacts(
      `<><Tab>A</Tab><Tab selected>B</Tab><Tab selected={isOn}>C</Tab></>`,
      "ui.tsx",
      { projectRoot: process.cwd() },
    );
    expect(facts.map((f) => f.id)).toEqual(["tab:A", "tab:B", "tab-selected:B", "tab:C"]);
  });

  it("snapshots path + facts", () => {
    const surface = extractSurface("src/App.tsx", "<h2>Hello</h2>", { projectRoot: process.cwd() });
    expect(surface.path).toBe("src/App.tsx");
    expect(surface.facts).toEqual([{ kind: "heading", id: "heading:2:Hello" }]);
  });

  it("extracts Heading, TableHead, and role landmarks from tsx", () => {
    const facts = extractMarkupFacts(
      `<><Heading level="2">Stats</Heading><TableHead>Owner</TableHead><div role="navigation" aria-label="Side">x</div></>`,
      "ui.tsx",
      { projectRoot: process.cwd() },
    );
    const ids = facts.map((f) => f.id);
    expect(ids).toContain("heading:2:Stats");
    expect(ids).toContain("table-column:Owner");
    expect(ids).toContain("landmark:navigation:Side");
  });

  it("extracts html selected flag, landmarks, and jsx control/landmark variants", () => {
    const html = `<select name="region"></select><textarea id="notes"></textarea>
<option selected>x</option><header aria-label="Top"></header><footer></footer>
<aside id="rail"></aside><article class="panel"></article>
<input placeholder="Search" /><button selected aria-selected="true" role="tab">Live</button>`;
    const htmlIds = extractMarkupFacts(html, "ui.html").map((f) => f.id);
    expect(htmlIds).toContain("control:select:region");
    expect(htmlIds).toContain("control:textarea:notes");
    expect(htmlIds).toContain("control:input:Search");
    expect(htmlIds).toContain("tab:Live");
    expect(htmlIds).toContain("tab-selected:Live");
    expect(htmlIds).toContain("landmark:header:Top");
    expect(htmlIds).toContain("landmark:footer:footer");
    expect(htmlIds).toContain("landmark:aside:rail");
    expect(htmlIds).toContain("container:article:panel");

    const tsx = `
export function Page() {
  return (
    <>
      <header aria-label={"Head"}>H</header>
      <nav id="menu" />
      <main>M</main>
      <Heading aria-label="Stats" />
      <Tab label="One" />
      <Tab title={"Two"} selected={true} />
      <Tab name="Three">{'Inner'}</Tab>
      <Input name="email" />
      <Select name="zone" />
      <Textarea id="bio" />
      <section aria-label="Card" />
      <article className="box" />
      <div role="banner" id="hero">x</div>
    </>
  );
}
`;
    const tsxIds = extractMarkupFacts(tsx, "ui.tsx", { projectRoot: process.cwd() }).map(
      (f) => f.id,
    );
    expect(tsxIds).toContain("landmark:header:Head");
    expect(tsxIds).toContain("landmark:nav:menu");
    expect(tsxIds).toContain("landmark:main:main");
    expect(tsxIds).toContain("heading:1:Stats");
    expect(tsxIds).toContain("tab:One");
    expect(tsxIds).toContain("tab:Two");
    expect(tsxIds).toContain("tab-selected:Two");
    expect(tsxIds).toContain("tab:Inner");
    expect(tsxIds).toContain("control:input:email");
    expect(tsxIds).toContain("control:select:zone");
    expect(tsxIds).toContain("control:textarea:bio");
    expect(tsxIds).toContain("container:section:Card");
    expect(tsxIds).toContain("container:article:box");
    expect(tsxIds).toContain("landmark:banner:hero");
  });

  it("walks HTML template element content and never executes script tags", () => {
    const html = `
<template><button role="tab" aria-selected="true">Inbox</button></template>
<script>globalThis.${SCRIPT_SENTINEL} = "executed"; throw new Error("script ran")</script>
<button>Save</button>
`;
    expect((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL]).toBeUndefined();
    const facts = extractMarkupFacts(html, "ui.html");
    expect((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL]).toBeUndefined();
    const ids = facts.map((f) => f.id);
    expect(ids).toContain("tab:Inbox");
    expect(ids).toContain("tab-selected:Inbox");
    expect(ids).toContain("control:button:Save");
  });
});

function tsxIds(source: string): string[] {
  return extractMarkupFacts(source, "ui.tsx", { projectRoot: process.cwd() }).map((f) => f.id);
}

function controlledTabsSnippet(initializer: string, valueExpr = "tab"): string {
  return `
function Page() {
  const [tab, setTab] = ${initializer};
  return (
    <Tabs value={${valueExpr}} onValueChange={setTab}>
      <TabsTrigger value="overview">Overview</TabsTrigger>
      <TabsTrigger value="billing">Billing</TabsTrigger>
    </Tabs>
  );
}
`;
}

describe("const useState StringLiteral unwrap (#4586)", () => {
  it("emits tab-selected from the matching TabsTrigger when value={ident} unwraps", () => {
    const ids = tsxIds(controlledTabsSnippet('useState("overview")'));
    expect(ids).toContain("tab-selected:Overview");
    expect(ids).not.toContain("tab-selected:Billing");
    expect(ids).not.toContain("tab:Overview");
    expect(ids).not.toContain("tab:Billing");
  });

  it("sees a useState StringLiteral flip as a tab-selected delta", () => {
    expect(tsxIds(controlledTabsSnippet('useState("billing")'))).toContain("tab-selected:Billing");
    expect(tsxIds(controlledTabsSnippet('useState("overview")'))).not.toContain(
      "tab-selected:Billing",
    );
  });

  it("accepts the closed React.useState callee", () => {
    expect(tsxIds(controlledTabsSnippet('React.useState("overview")'))).toContain(
      "tab-selected:Overview",
    );
  });

  it("leaves lazy, non-literal, let, and setTab unresolvable", () => {
    expect(tsxIds(controlledTabsSnippet('useState(() => "overview")'))).not.toContain(
      "tab-selected:Overview",
    );
    expect(tsxIds(controlledTabsSnippet("useState(DEFAULT)"))).not.toContain(
      "tab-selected:Overview",
    );
    expect(
      tsxIds(`
function Page() {
  let [tab, setTab] = useState("overview");
  return (
    <Tabs value={tab}>
      <TabsTrigger value="overview">Overview</TabsTrigger>
    </Tabs>
  );
}
`),
    ).not.toContain("tab-selected:Overview");
    expect(tsxIds(controlledTabsSnippet('useState("overview")', "setTab"))).not.toContain(
      "tab-selected:Overview",
    );
  });

  it("does not treat TabsTrigger as a tab tag and does not throw on a controlled value= expression", () => {
    const bare = tsxIds(
      `<Tabs value={tab}><TabsTrigger value="overview">Overview</TabsTrigger></Tabs>`,
    );
    expect(bare).not.toContain("tab:Overview");
    expect(bare).not.toContain("tab-selected:Overview");
    expect(() =>
      extractMarkupFacts(
        `<Tabs value={tab}><TabsTrigger value="overview">Overview</TabsTrigger></Tabs>`,
        "ui.tsx",
        { projectRoot: process.cwd() },
      ),
    ).not.toThrow();
  });

  it("falls back to the TabsTrigger value literal when inner text is empty", () => {
    expect(
      tsxIds(`
function Page() {
  const [tab, setTab] = useState("overview");
  return (
    <Tabs value={tab}>
      <TabsTrigger value="overview" />
      <TabsTrigger value="billing" />
    </Tabs>
  );
}
`),
    ).toContain("tab-selected:overview");
  });

  it("does not unwrap optional chaining, omitted bindings, or other callees", () => {
    expect(tsxIds(controlledTabsSnippet('React?.useState("overview")'))).not.toContain(
      "tab-selected:Overview",
    );
    expect(
      tsxIds(`
function Page() {
  const [, tab] = useState("overview");
  return (
    <Tabs value={tab}>
      <TabsTrigger value="overview">Overview</TabsTrigger>
    </Tabs>
  );
}
`),
    ).not.toContain("tab-selected:Overview");
    expect(tsxIds(controlledTabsSnippet('foo.useState("overview")'))).not.toContain(
      "tab-selected:Overview",
    );
  });

  it("does not unwrap defaultValue and does not follow an in-file const into useState", () => {
    expect(
      tsxIds(`
const DEFAULT_TAB = "overview";
function Page() {
  const [tab, setTab] = useState(DEFAULT_TAB);
  return (
    <Tabs defaultValue={tab}>
      <TabsTrigger value="overview">Overview</TabsTrigger>
    </Tabs>
  );
}
`),
    ).not.toContain("tab-selected:Overview");
  });
  it("does not mint tab-selected from a non-Tabs value ident", () => {
    expect(
      tsxIds(`
function Page() {
  const [tab, setTab] = useState("overview");
  return (
    <>
      <input value={tab} />
      <TabsTrigger value="overview">Overview</TabsTrigger>
    </>
  );
}
`),
    ).not.toContain("tab-selected:Overview");
  });

  it("leaves colliding same-file useState idents unresolvable", () => {
    const ids = tsxIds(`
function A() {
  const [tab, setTab] = useState("overview");
  return (
    <Tabs value={tab}>
      <TabsTrigger value="overview">Overview</TabsTrigger>
    </Tabs>
  );
}
function B() {
  const [tab, setTab] = useState("billing");
  return (
    <Tabs value={tab}>
      <TabsTrigger value="billing">Billing</TabsTrigger>
    </Tabs>
  );
}
`);
    expect(ids).not.toContain("tab-selected:Overview");
    expect(ids).not.toContain("tab-selected:Billing");
  });
  it("leaves colliding TabsTrigger labels unresolvable", () => {
    expect(
      tsxIds(`
function Page() {
  const [tab, setTab] = useState("overview");
  return (
    <>
      <Tabs value={tab}>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="billing">Billing</TabsTrigger>
      </Tabs>
      <Tabs value={other}>
        <TabsTrigger value="overview">Settings</TabsTrigger>
        <TabsTrigger value="billing">Settings</TabsTrigger>
      </Tabs>
    </>
  );
}
`),
    ).not.toContain("tab-selected:Overview");
  });
});
