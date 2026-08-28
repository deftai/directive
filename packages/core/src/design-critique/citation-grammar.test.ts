import { describe, expect, it } from "vitest";
import { ACCEPTED_CITATION_FORMS, scanCitations } from "./citation-grammar.js";

const ID = 5439547122;
const TABLE_ID = 5439956893;

function ids(body: string): number[] {
  return scanCitations(body).citations.map((row) => row.id);
}

describe("scanCitations accepted forms (#3831)", () => {
  it("reads a bare decimal after a citation keyword", () => {
    expect(ids(`successor lean ${ID}`)).toEqual([ID]);
  });

  it("reads a colon with and without a following space", () => {
    expect(ids(`successor lean: ${ID}`)).toEqual([ID]);
    expect(ids(`successor lean:${ID}`)).toEqual([ID]);
  });

  it("reads a balanced single-backtick id -- the form that blocked #3796", () => {
    expect(ids(`successor lean \`${ID}\``)).toEqual([ID]);
  });

  it("reads an emphasised keyword, which is the mandated house style", () => {
    expect(ids(`**successor lean:** ${ID}`)).toEqual([ID]);
    expect(ids(`**successor lean** ${ID}`)).toEqual([ID]);
    expect(ids(`*successor lean* ${ID}`)).toEqual([ID]);
    expect(ids(`**successor lean:** \`${ID}\``)).toEqual([ID]);
  });

  it("reads canonical comment permalinks", () => {
    expect(ids(`#issuecomment-${ID}`)).toEqual([ID]);
    expect(ids(`https://github.com/o/r/issues/comments/${ID}`)).toEqual([ID]);
    expect(ids(`[successor lean](https://github.com/o/r/issues/3831#issuecomment-${ID})`)).toEqual([
      ID,
    ]);
  });

  it("types the citation by keyword", () => {
    const scan = scanCitations(
      `successor lean ${ID}, verified-claims table \`${TABLE_ID}\`, comment 5439713778`,
    );
    expect(scan.citations).toEqual([
      { id: ID, kind: "lean" },
      { id: TABLE_ID, kind: "table" },
      { id: 5439713778, kind: "comment" },
    ]);
  });

  it("types a bare lean keyword as a lean and a permalink as a comment", () => {
    expect(scanCitations(`lean ${ID}`).citations).toEqual([{ id: ID, kind: "lean" }]);
    expect(scanCitations(`#issuecomment-${ID}`).citations).toEqual([{ id: ID, kind: "comment" }]);
  });

  it("keeps both kinds when one id is cited under two keywords", () => {
    const scan = scanCitations(`successor lean ${ID} and verified-claims table ${ID}`);
    expect(scan.citations).toEqual([
      { id: ID, kind: "lean" },
      { id: ID, kind: "table" },
    ]);
  });

  it("deduplicates a repeated id under the same keyword", () => {
    expect(ids(`successor lean ${ID}; again successor lean ${ID}`)).toEqual([ID]);
  });

  it("reads a citation on the final line with no trailing newline", () => {
    expect(ids(`line one\nsuccessor lean ${ID}`)).toEqual([ID]);
  });

  it("publishes the accepted-form list the diagnostics quote", () => {
    expect(ACCEPTED_CITATION_FORMS).toContain("successor lean `12345678`");
    expect(ACCEPTED_CITATION_FORMS).toContain("**successor lean:** 12345678");
    expect(ACCEPTED_CITATION_FORMS).toContain("#issuecomment-12345678");
  });
});

describe("scanCitations closed set -- decorations outside it do not cite (#3831)", () => {
  const outside: ReadonlyArray<readonly [string, string]> = [
    ["bold id", `successor lean **${ID}**`],
    ["italic id", `successor lean *${ID}*`],
    ["underscore id", `successor lean __${ID}__`],
    ["hash-prefixed id", `successor lean #${ID}`],
    ["display-text link", `successor lean [${ID}](https://example.invalid/x)`],
    ["parenthesised id", `successor lean (${ID})`],
    ["quoted id", `successor lean "${ID}"`],
    ["html code tag", `successor lean <code>${ID}</code>`],
    ["intervening words", `successor lean is the same as ${ID}`],
    ["no separator at all", `lean${ID}`],
    ["an unclosed code span around the id", `successor lean \`${ID}`],
    ["digits that run into a word", `successor lean ${ID}abc`],
    ["no keyword anchor", `confirmed by ${ID}`],
  ];

  for (const [label, body] of outside) {
    it(`refuses ${label}`, () => {
      expect(ids(body)).toEqual([]);
    });
  }

  it("refuses an all-zero run that is id-shaped but not an id", () => {
    expect(ids("successor lean 00000000")).toEqual([]);
  });

  it("refuses a digit run too long to be a safe integer", () => {
    const scan = scanCitations("successor lean 123456789012345678901234");
    expect(scan.citations).toEqual([]);
    expect(scan.idShapedRuns).toEqual([]);
  });
});

describe("scanCitations position predicate (#3831)", () => {
  it("refuses a fenced example", () => {
    const scan = scanCitations(`\`\`\`text\nsuccessor lean ${ID}\n\`\`\`\n`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "code-fence" }]);
  });

  it("refuses a fence indented up to three spaces", () => {
    for (const indent of [" ", "  ", "   "]) {
      const scan = scanCitations(
        `prose\n\n${indent}\`\`\`text\n${indent}successor lean ${ID}\n${indent}\`\`\`\n`,
      );
      expect(scan.citations, JSON.stringify(indent)).toEqual([]);
      expect(scan.rejected, JSON.stringify(indent)).toEqual([{ id: ID, reason: "code-fence" }]);
    }
  });

  it("refuses a tilde fence", () => {
    const scan = scanCitations(`~~~\nsuccessor lean ${ID}\n~~~\n`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "code-fence" }]);
  });

  it("does not treat a mismatched fence character as a closer", () => {
    const scan = scanCitations(`\`\`\`\nexample\n~~~\nsuccessor lean ${ID}\n\`\`\`\n`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "code-fence" }]);
  });

  it("does not treat a same-character run carrying an info string as a closer", () => {
    const scan = scanCitations(
      `\`\`\`\nexample\n\`\`\`ts more text\nsuccessor lean ${ID}\n\`\`\`\n`,
    );
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "code-fence" }]);
  });

  it("refuses a code span that opened on an earlier line", () => {
    const scan = scanCitations(`here is \`an example\nsuccessor lean ${ID}\` in prose\n`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "inline-code" }]);
  });

  it("refuses a strikethrough that opened on an earlier line", () => {
    const scan = scanCitations(`~~withdrawn text\nsuccessor lean ${ID}~~\n`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "strikethrough" }]);
  });

  it("restarts inline scanning at a blank line", () => {
    expect(ids(`a stray \` backtick\n\nbound contract is successor lean ${ID}\n`)).toEqual([ID]);
    expect(ids(`a stray ~~ run\n\nbound contract is successor lean ${ID}\n`)).toEqual([ID]);
  });

  it("restarts inline scanning after a closed fence", () => {
    expect(ids(`\`\`\`text\nexample\n\`\`\`\nbound contract is successor lean ${ID}\n`)).toEqual([
      ID,
    ]);
  });

  it("accepts a citation after a fence has closed", () => {
    expect(ids(`\`\`\`text\nexample\n\`\`\`\n\nbound contract is successor lean ${ID}\n`)).toEqual([
      ID,
    ]);
  });

  it("refuses a fenced permalink", () => {
    const scan = scanCitations(`\`\`\`\n#issuecomment-${ID}\n\`\`\`\n`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "code-fence" }]);
  });

  it("refuses a keyword inside a single-backtick code span", () => {
    const scan = scanCitations(`the parser wants \`successor lean ${ID}\` shaped text`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "inline-code" }]);
  });

  it("refuses a keyword inside a double-backtick code span", () => {
    const scan = scanCitations(`house style is \`\` successor lean \`${ID}\` \`\``);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "inline-code" }]);
  });

  it("accepts a citation after a closed code span on the same line", () => {
    expect(ids(`\`CITE_RE\` reads successor lean ${ID}`)).toEqual([ID]);
  });

  it("treats a mismatched backtick run as still open", () => {
    const scan = scanCitations(`\`\`open span \` successor lean ${ID}`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "inline-code" }]);
  });

  it("refuses a blockquoted citation", () => {
    const scan = scanCitations(`> on another thread they wrote: successor lean ${ID}\n`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "blockquote" }]);
  });

  it("refuses a struck-through citation", () => {
    const scan = scanCitations(`~~successor lean ${ID}~~ was withdrawn`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "strikethrough" }]);
  });

  it("accepts a citation after a closed strikethrough on the same line", () => {
    expect(ids(`~~withdrawn~~ bound contract is successor lean ${ID}`)).toEqual([ID]);
  });

  it("refuses negated prose", () => {
    const scan = scanCitations(`do not use successor lean ${ID}`);
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([{ id: ID, reason: "negation" }]);
  });

  it("refuses the other explicit negations", () => {
    for (const body of [
      `this does not bind successor lean ${ID}`,
      `we never cited successor lean ${ID}`,
      `ingest cannot read successor lean ${ID}`,
      `doesn't cite successor lean ${ID}`,
      `the record is not successor lean ${ID}`,
      `the thread no longer cites successor lean ${ID}`,
      `this does not cite the bound successor lean ${ID}`,
    ]) {
      expect(scanCitations(body).citations, body).toEqual([]);
    }
  });

  it("keeps a negation inside the sentence it belongs to", () => {
    expect(ids(`this is not stale. Bound contract is successor lean ${ID}`)).toEqual([ID]);
  });

  it("does not read a negation from an earlier line", () => {
    expect(ids(`do not reuse the old record\nbound contract is successor lean ${ID}`)).toEqual([
      ID,
    ]);
  });

  it("keeps an affirmative citation whose sentence merely contains a negation word", () => {
    for (const body of [
      `without a doubt, successor lean ${ID} is accepted`,
      `not only successor lean ${ID} but also the verified-claims table`,
      `every lean except one: successor lean ${ID} binds`,
      `the chip does not gate ingest, so successor lean ${ID} binds`,
      `this does not change the fact that successor lean ${ID} binds`,
    ]) {
      expect(scanCitations(body).citations, body).toEqual([{ id: ID, kind: "lean" }]);
    }
  });
});

describe("scanCitations diagnostics surface (#3831)", () => {
  it("reports id-shaped runs the grammar did not accept", () => {
    const scan = scanCitations(`bound contract is successor lean **${ID}** and ${TABLE_ID}`);
    expect(scan.citations).toEqual([]);
    expect(scan.idShapedRuns).toEqual([ID, TABLE_ID]);
  });

  it("deduplicates id-shaped runs", () => {
    expect(scanCitations(`${ID} and ${ID} again`).idShapedRuns).toEqual([ID]);
  });

  it("reports nothing for a body with no ids", () => {
    const scan = scanCitations("design-critique: synthesis accepted, because agents agreed\n");
    expect(scan.citations).toEqual([]);
    expect(scan.rejected).toEqual([]);
    expect(scan.idShapedRuns).toEqual([]);
  });
});
