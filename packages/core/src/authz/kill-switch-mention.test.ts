import { describe, expect, it } from "vitest";
import { classifyShellAuthzOps, hasKillSwitchShellWrite } from "./classify.js";

/**
 * #6941: plain-read and heredoc-data relief in the kill-switch mention rule (#6681),
 * bound by the accepted design lean (issue #6941, comment 7070849780).
 */
describe("kill-switch mention rule: read and data relief (#6941)", () => {
  const kill = ".deft-directive-disable";
  const opt = ".no-deft-directive";

  function expectAllowed(command: string): void {
    expect(hasKillSwitchShellWrite(command), command).toBe(false);
    expect(classifyShellAuthzOps(command), command).not.toContain("settings");
  }

  function expectRefused(command: string): void {
    expect(hasKillSwitchShellWrite(command), command).toBe(true);
    // Structural plant shapes keep their own class (`settings` or grant-immune `unknown`).
    const ops = classifyShellAuthzOps(command);
    expect(ops.includes("settings") || ops.includes("unknown"), command).toBe(true);
  }

  it("counts cut, tr, nl, jq, sort, git grep and sed line-range prints as plain reads", () => {
    for (const command of [
      `git grep -n ${kill} HEAD -- p | cut -c1-200`,
      `grep -rn ${kill} p | sort -u`,
      `sed -n 1,20p a.md | grep ${kill}`,
      `grep ${kill} a | tr a b | nl | jq -R .`,
      `sort -k2 -t, ${kill}`,
      `sed -n '$p' a.md | grep -c ${kill}`,
      `sed -n 5,$p a.md | grep ${kill}`,
      `sed -n -e 1p -e 5p a.md | grep ${kill}`,
      `sed --quiet 3p a.md | grep ${opt}`,
      `git --no-pager grep -l ${kill} -- docs`,
    ]) {
      expectAllowed(command);
    }
    // A sed print whose operand is the flag passes the mention rule; the older structural
    // scan keeps its own op class for a sed operand, which this issue does not change.
    expect(hasKillSwitchShellWrite(`sed -n '$p' ${kill}`)).toBe(false);
  });

  it("refuses sort with an output or run option in any spelling, after -- too", () => {
    for (const command of [
      `sort -o ${kill} x`,
      `sort -o${kill} x`,
      `sort -uo${kill} x`,
      `sort --out=${kill} x`,
      `sort --o=${kill} x`,
      `sort --o ${kill} x`,
      `sort --output ${kill} x`,
      `sort -T -- -o${kill} /dev/null`,
      `sort --compress=sh x ${kill}`,
      `SORT -O ${kill} x`,
      `sort.exe /o ${kill} x`,
      `sort /OUTPUT ${kill} x`,
    ]) {
      expectRefused(command);
    }
  });

  it("refuses when a separator is quoted, escaped or decoded (untrusted split)", () => {
    for (const command of [
      `sort -T ';cat' -o${kill} /dev/null`,
      `sort -T '|cat' -o${kill} /dev/null`,
      `sort -T '&cat' -o${kill} /dev/null`,
      `sort -T \\;cat -o${kill} /dev/null`,
      `sort -T 'x\ncat -o${kill}' /dev/null`,
      `sort -T "x\ncat -o${kill}" /dev/null`,
      `sort -T $'\\x3bcat' -o${kill} /dev/null`,
      `sort -T \\x3bcat -o${kill} /dev/null`,
      `sort -T x^;cat -o${kill} /dev/null`,
      // Over-refusal pinned: a quoted alternation beside a mention.
      `grep 'a|b' ${kill} | sort`,
    ]) {
      expectRefused(command);
    }
  });

  it("refuses git grep, less, rg and sed write or run options", () => {
    for (const command of [
      `git grep -O ${kill}`,
      `git grep -Oless ${kill}`,
      `git grep --open=sh ${kill}`,
      `git grep --op ${kill}`,
      `git grep --textconv ${kill}`,
      `git grep --t ${kill}`,
      `less -o${kill} f`,
      `less -Ro ${kill} f`,
      `rg --hostname-bin=x ${kill}`,
      `rg --host ${kill} x`,
      `rg --pre=sh x ${kill}`,
      `sed -n 'w ${kill}' a`,
      `sed -i s/a/b/ ${kill}`,
      `sed -i 's/x/${kill}/' f`,
      `sed -n 1p --expression='w ${kill}' a`,
      `sed -n -e 1p -e 'w ${kill}' a`,
      `sed --q 1p ${kill}`,
      `sed -n -- 1p ${kill}`,
      // `-E` lowercases to `-e`: the first operand is still checked as the script.
      `sed 'w ${kill}' -E 1p`,
    ]) {
      expectRefused(command);
    }
  });

  it("refuses an argument-sensitive reader behind xargs", () => {
    for (const command of [
      `printf '%s\\n' -o ${kill} /dev/null | xargs sort`,
      `xargs less -o ${kill}`,
      `echo ${kill} | xargs sed -n 1p`,
      `echo ${kill} | xargs git grep x`,
      `echo ${kill} | xargs rg x`,
      `echo ${kill} | xargs file`,
      `echo ${kill} | xargs more`,
    ]) {
      expectRefused(command);
    }
  });

  it("refuses any xargs option that is not on the closed list", () => {
    for (const command of [
      `cut -c1 /dev/null | xargs --arg-file cat touch ${kill}`,
      `echo x | xargs -a cat touch ${kill}`,
      `echo x | xargs --a cat touch ${kill}`,
      `echo x | xargs -i cat touch ${kill}`,
      `echo x | xargs -p cat touch ${kill}`,
      `echo x | xargs -0r cat ${kill}`,
      `echo x | xargs -n x cat ${kill}`,
      `echo x | xargs --nu cat ${kill}`,
      `echo x | xargs -- cat ${kill}`,
      `echo x | xargs --max-args=x cat ${kill}`,
    ]) {
      expectRefused(command);
    }
  });

  it("refuses the current-guard gap: echo into xargs --arg-file runs touch (operator ruling)", () => {
    // Before #6941 the guard skipped `--arg-file` as one word and read `cat` as the program.
    expectRefused(`echo x | xargs --arg-file cat touch ${kill}`);
    expectRefused(`echo x | xargs --arg-file cat touch ${opt}`);
  });

  it("allows xargs with only closed-list options in front of a flag-free reader", () => {
    for (const command of [
      `grep -l ${kill} p | xargs -0 -r -n 1 cat`,
      `grep -l ${kill} p | xargs --null --max-args=2 grep x`,
      `grep -l ${kill} p | xargs -n1 head -5`,
      `grep -l ${kill} p | xargs --no-run-if-empty --verbose --max-args 3 wc -l`,
      `grep -l ${kill} p | xargs -t cut -c1-80`,
    ]) {
      expectAllowed(command);
    }
  });

  it("treats a quoted heredoc written by cat or tee to literal paths as data", () => {
    const body = `The kill-switch file ${kill} stops Directive load.`;
    for (const command of [
      `cat > /tmp/b.md <<'EOF'\n${body}\nEOF`,
      `cat >> /tmp/b.md <<'EOF'\n${body}\nEOF`,
      `cat >/tmp/b.md <<"EOF"\n${body}\nEOF\n`,
      `cat <<'EOF' > /tmp/b.md\n${body}\nEOF`,
      `tee -a /tmp/b.md <<'EOF'\n${body}\nEOF`,
      `tee /tmp/b.md /tmp/c.md <<'EOF'\n${body}\nEOF`,
      `cat > /tmp/b.md <<-'EOF'\n\t${body}\n\tEOF`,
    ]) {
      expect(hasKillSwitchShellWrite(command), command).toBe(false);
    }
  });

  it("reads the heredoc body as today unless the heredoc is the only command", () => {
    const body = `The kill-switch file ${kill} stops Directive load.`;
    for (const command of [
      `tee >(sh) <<'EOF'\n${body}\nEOF`,
      `cat <<'EOF' | sh\n${body}\nEOF`,
      `cat > /tmp/b.md <<EOF\n${body}\nEOF`,
      `cat > /tmp/$X.md <<'EOF'\n${body}\nEOF`,
      `cat > ${kill} <<'EOF'\n${body}\nEOF`,
      `cat > /tmp/b.md <<'EOF'\n${body}\nEOF\nrg --hostname-bin=/tmp/h x /dev/null`,
      `cat > /tmp/b.md <<'EOF'\n${body}\nEOF\ncat /tmp/b.md`,
      `cat > /tmp/b.md <<'EOF'; cat /tmp/b.md\n${body}\nEOF`,
      `cat > /tmp/b.md <<'EOF' && rg --hostname-bin=/tmp/b.md x /dev/null\n${body}\nEOF`,
      `cat x > /tmp/b.md <<'EOF'\n${body}\nEOF`,
      `cat > /tmp/b.md > /tmp/c.md <<'EOF'\n${body}\nEOF`,
      `tee -a - <<'EOF'\n${body}\nEOF`,
      `tee <<'EOF'\n${body}\nEOF`,
      `cat > /tmp/b.md <<'EOF'\n${body}`,
      `cat > /tmp/b.md <<'EOF' <<'END'\n${body}\nEOF\nx\nEND`,
      `FOO=1 cat > /tmp/b.md <<'EOF'\n${body}\nEOF`,
    ]) {
      expect(hasKillSwitchShellWrite(command), command).toBe(true);
    }
  });

  it("keeps the over-refusal for a printed heredoc with no literal destination", () => {
    expectRefused(`cat <<'DOC'\necho ${kill} | xargs touch\nDOC`);
  });
});
