import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractMarkupFacts as viaLite } from "../extract.js";

const cases: Record<string, string> = {
  "noscript-heading":
    "<noscript><h1>Offline mode</h1><button>Retry</button></noscript><h1>Live</h1>",
  "unclosed-buttons": "<button>Save<button>Cancel<h1>End</h1>",
  "cdata-in-heading": "<h2><![CDATA[<b>X]]>tail</h2>",
  "legacy-entity-nosemi": "<h1>&copy 2026 Acme</h1>",
  "entity-outside-latin1":
    '<h1>Sort &darr;</h1><div role="tab">Next &rarr;</div><div role="tab">Up &uarr;</div>',
  "entity-notit": "<h1>&notit;</h1>",
  "foster-parented-heading": "<table><h1>Fostered</h1><tr><td>cell</td></tr></table><h1>After</h1>",
  "misnested-formatting": "<b><h1>A</b>B</h1>",
  "p-implied-close-table": "<p>intro<table><tr><th>Col</th></tr></table>",
  "li-button-implied": "<ul><li><button>A<li><button>B</ul>",
  "select-options": "<select name=s><option selected>x<option>y</select>",
  "dup-attr": '<div role="tab" role="button" aria-label="One">t</div>',
  "nested-form-controls": "<form><input name=a><form><input name=b></form></form>",
  "unclosed-template": "<template><h2>T</h2><h1>Live?</h1>",
  "svg-foreign-title":
    "<svg><title>svg title</title><desc><h1>InSvg</h1></desc></svg><h1>After</h1>",
  "comment-bogus": "<!--><h1>After bogus comment</h1>",
  "attr-newline-unquoted": '<div role=tab\naria-label="X">t</div>',
  "th-in-thead-implied": "<table><thead><tr><th>A<th>B</thead><tbody><tr><td>1<td>2</table>",
  "raw-textarea-markup": "<textarea><h1>not heading</h1></textarea><h1>heading</h1>",
  "script-close-in-string": '<script>var s = "</script>";</script><h1>After</h1>',
  "nested-template": "<template><h2>T</h2><template><h3>N</h3></template></template><h2>Live</h2>",
  "stray-end-tags": "</div></h1><h1>Real</h1>",
  "a-inside-p-misnest": "<p><a href=#>link<p>second</a></p><h1>H</h1>",
  "caption-colgroup":
    "<table><caption>Cap</caption><colgroup><col></colgroup><tr><th>C1</th></tr></table>",
  "attr-entity-in-label": '<button aria-label="Up &uarr; now">B</button>',
  "head-body-split": "<html><head><title>T</title></head><body><h1>H</h1></body></html>",
  "nav-in-table": '<table><tr><td><nav aria-label="Pager">p</nav></td></tr></table>',
  "input-in-table-foster": '<table><input name="fostered"><tr><td>x</td></tr></table>',
  plaintext: "<h1>A</h1><plaintext><h1>B</h1>",
  "frameset-ish": "<h1>A</h1><frameset><frame></frameset><h1>B</h1>",
};

it("parse5 extracts critic-30 fixtures without truncated-token refusal", () => {
  const threw: string[] = [];
  for (const [name, src] of Object.entries(cases)) {
    try {
      viaLite(src, "x.html");
    } catch (e) {
      threw.push(`${name}:${(e as Error).message}`);
    }
  }
  writeFileSync(join(tmpdir(), "out-critic30.txt"), `${threw.join("\n")}\n`);
  expect(threw).toEqual([]);
});
