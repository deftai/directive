import { expect, it } from "vitest";
import { extractMarkupFacts as viaLite } from "../extract.js";

/** Inverse of critic 5658507245's silent-pass harness: parse5 must see these deltas. */
const cases: Record<string, { base: string; candidate: string }> = {
  "heading-moved-out-of-select": {
    base: '<select name="s"><h1>Settings</h1><option>A</option></select>',
    candidate: '<select name="s"><option>A</option></select><h1>Settings</h1>',
  },
  "nbsp-tag-separator-corrected": {
    base: '<button\u00a0aria-label="Save">Text</button>',
    candidate: '<button aria-label="Save">Text</button>',
  },
  "raw-close-nbsp-corrected": {
    base: "<script>x</script\u00a0><h1>Shown</h1></script>",
    candidate: "<script>x</script><h1>Shown</h1>",
  },
  "windows-1252-reference-replaced-by-literal-control": {
    base: "<h1>Price &#x80;</h1>",
    candidate: "<h1>Price \u0080</h1>",
  },
  "noscript-heading-added": {
    base: "<noscript><p>Enable JS</p></noscript><h1>Live</h1>",
    candidate: "<noscript><h1>Offline</h1></noscript><h1>Live</h1>",
  },
  "tab-added-after-bogus-comment": {
    base: '<!--><div role="tablist"><button role="tab">A</button></div>',
    candidate:
      '<!--><div role="tablist"><button role="tab">A</button><button role="tab">B</button></div>',
  },
};

it("every base/candidate paired delta is visible to the parse5 front end", () => {
  for (const [name, { base, candidate }] of Object.entries(cases)) {
    const l = [
      viaLite(base, "x.html").map((f) => f.id),
      viaLite(candidate, "x.html").map((f) => f.id),
    ];
    expect(l[1], name).not.toEqual(l[0]);
  }
});
