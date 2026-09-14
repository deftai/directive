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
