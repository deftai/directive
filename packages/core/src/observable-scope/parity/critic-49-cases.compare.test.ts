import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractMarkupFacts as viaLite } from "../extract.js";

const deep = `${"<div>".repeat(2_000)}<h1>Deep</h1>${"</div>".repeat(2_000)}`;

const cases: Record<string, string> = {
  "foster-button-between-rows":
    '<div role="tab">Before</div><table><tr><td>A</td></tr><button role="tab">Foster</button><tr><td>B</td></tr></table><div role="tab">After</div>',
  "nested-table-columns":
    "<table><tr><th>Outer<table><tr><th>Inner</th></tr></table>Tail</th></tr></table>",
  "form-inside-table":
    '<table><form id="f"><input name="a"><tr><td><button>Save</button></td></tr></form></table>',
  "select-inside-table":
    '<table><tr><td><select name="s"><option>A</option></select></td></tr></table>',
  "select-invalid-elements":
    '<select name="s"><h1>Ghost heading</h1><button>Ghost button</button><option>Real</option></select><button>After</button>',
  "select-tab-role":
    '<select><div role="tab">Ghost tab</div><option>One</option></select><div role="tab">After</div>',
  "nested-select":
    '<select name="outer"><option>A<select name="inner"><option>B</select><option>C</select>',
  "misnested-anchor-button-p": '<p><a href="#"><button>A</a>B</button><p><button>C</button></p>',
  "adoption-agency-button": "<b><i><button>A</b>B</i>C</button><button>D</button>",
  "numeric-win1252-text": "<h1>&#x80; &#128; &#x82; &#x9f;</h1>",
  "numeric-win1252-attribute": '<button aria-label="Pay &#x80;10">X</button>',
  "numeric-invalids": "<h1>&#0; &#xD800; &#x110000;</h1>",
  "numeric-control": "<h1>A&#13;B&#x0b;C</h1>",
  "entity-multicodepoint": "<h1>&NotEqualTilde; &ThickSpace; &fjlig;</h1>",
  "entity-legacy-attribute-alnum": '<button aria-label="&copycat">X</button>',
  "entity-unknown": "<h1>&DefinitelyNotAnEntity; &ampersand;</h1>",
  "attribute-crlf": '<button aria-label="Line 1\r\nLine 2">X</button>',
  "attribute-cr": '<button aria-label="Line 1\rLine 2">X</button>',
  "attribute-nbsp-separator": '<button\u00a0aria-label="NBSP">Text</button>',
  "attribute-line-separator": '<button\u2028aria-label="LS">Text</button>',
  "attribute-formfeed-separator": '<button\faria-label="FF">Text</button>',
  "attribute-duplicate-case": '<button ARIA-LABEL="One" aria-label="Two">Text</button>',
  "attribute-slash-unquoted": "<button aria-label=x/>After</button>",
  "bom-document": "\ufeff<h1>After BOM</h1>",
  "bom-inside-tag": '<button\ufeffaria-label="BOM">Text</button>',
  "null-in-text": "<h1>A\0B</h1>",
  "null-in-attribute": '<button aria-label="A\0B">Text</button>',
  "crlf-text": "<h1>Line 1\r\nLine 2</h1>",
  "deep-2000": deep,
  "template-inside-table":
    '<table><template><h1>Template H</h1><button role="tab">Template T</button></template><tr><th>Column</th></tr></table><h1>After</h1>',
  "template-between-cells":
    "<table><tr><th>A<template><th>T</th></template><th>B</th></tr></table>",
  "foreignobject-html":
    "<svg><foreignObject><h1>Foreign HTML</h1><button>Inside</button></foreignObject></svg><h1>After</h1>",
  "foreignobject-cdata":
    "<svg><foreignObject><h1>A<![CDATA[<button>Ghost</button>]]>B</h1></foreignObject></svg>",
  "math-annotation-html":
    '<math><annotation-xml encoding="text/html"><h1>Math HTML</h1><button>Inside</button></annotation-xml></math>',
  "svg-self-close-cdata": "<svg/><h1>A<![CDATA[<button>Ghost</button>]]>B</h1>",
  "raw-close-nbsp": "<script>one</script\u00a0><h1>Ghost</h1></script><h1>After</h1>",
  "textarea-close-nbsp":
    '<textarea name="t">one</textarea\u00a0><h1>Ghost</h1></textarea><h1>After</h1>',
  "comment-nested-open": "<!-- one <!-- two --><h1>After</h1>",
  "comment-empty-bang": "<!----!><h1>After</h1>",
  "comment-one-dash": "<!---x--><h1>After</h1>",
  "processing-instruction": "<?x y?><h1>After</h1>",
  "doctype-internal-subset": '<!DOCTYPE html [ <!ENTITY x "y"> ]><h1>After</h1>',
  "unclosed-doctype": "<!DOCTYPE html<h1>After</h1>",
  "unclosed-comment-after-fact": "<h1>Seen</h1><!-- unfinished",
  "unclosed-quoted-attribute": '<h1>Seen</h1><button aria-label="unfinished',
  "unclosed-raw-text": "<h1>Seen</h1><style>unfinished",
  "unclosed-start-tag": "<h1>Seen</h1><button",
  "heading-inside-button": "<button>A<h1>H</h1>B</button>",
  "button-inside-heading": "<h1>A<button>B</button>C</h1>",
};

const truncated = new Set([
  "unclosed-comment-after-fact",
  "unclosed-quoted-attribute",
  "unclosed-raw-text",
  "unclosed-start-tag",
]);

it("parse5 refuses truncated critic-49 fixtures and extracts the rest", () => {
  const unexpected: string[] = [];
  for (const [name, source] of Object.entries(cases)) {
    let threw = false;
    try {
      viaLite(source, "x.html");
    } catch {
      threw = true;
    }
    if (truncated.has(name) !== threw) {
      unexpected.push(
        `${name}: threw=${String(threw)} expectedTruncated=${String(truncated.has(name))}`,
      );
    }
  }
  writeFileSync(join(tmpdir(), "codex-own-out.txt"), `${unexpected.join("\n")}\n`);
  expect(unexpected).toEqual([]);
});
