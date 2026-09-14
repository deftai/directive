import { describe, expect, it } from "vitest";
import { diffArtifacts, unlistedDeltas } from "./diff.js";
import { buildArtifact, extractSurface } from "./extract.js";

const BASE = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;

const PARSERS = { html: "parse5@7", typescript: null };

describe("markup delta vs minted allows (#4495)", () => {
  it("fails unlisted tab reorder / extra control / heading / columns / landmarks / containers", () => {
    const candidate = `
<nav><button role="tab">Details</button><button role="tab" aria-selected="true">Overview</button></nav>
<h1>Dashboard</h1>
<h2>Extra</h2>
<input name="title" />
<input name="email" />
<button>Save</button>
<button>Delete</button>
<table><tr><th>Name</th><th>Owner</th></tr></table>
<footer></footer>
<section id="card"></section>
<article id="panel"></article>
`;
    const deltas = diffArtifacts(
      buildArtifact([extractSurface("ui.html", BASE)], PARSERS),
      buildArtifact([extractSurface("ui.html", candidate)], PARSERS),
    );
    const leftover = unlistedDeltas(deltas, [{ kind: "control", op: "add", name: "email" }]);
    expect(leftover.some((d) => d.kind === "tab" && d.op === "reorder")).toBe(true);
    expect(leftover.some((d) => d.kind === "heading")).toBe(true);
    expect(leftover.some((d) => d.kind === "control" && d.name === "Delete")).toBe(true);
    expect(leftover.some((d) => d.kind === "table-column")).toBe(true);
    expect(leftover.some((d) => d.kind === "landmark")).toBe(true);
    expect(leftover.some((d) => d.kind === "container")).toBe(true);
  });

  it("passes when only minted bound-field controls change", () => {
    const candidate = `
<nav><button role="tab" aria-selected="true">Overview</button><button role="tab">Details</button></nav>
<h1>Dashboard</h1>
<input name="title" />
<input name="email" />
<input name="phone" />
<button>Save</button>
<table><tr><th>Name</th><th>Status</th></tr></table>
<section id="card"></section>
`;
    const deltas = diffArtifacts(
      buildArtifact([extractSurface("ui.html", BASE)], PARSERS),
      buildArtifact([extractSurface("ui.html", candidate)], PARSERS),
    );
    const leftover = unlistedDeltas(deltas, [
      { kind: "control", op: "add", name: "email" },
      { kind: "control", op: "add", name: "phone" },
    ]);
    expect(leftover).toEqual([]);
  });
});
