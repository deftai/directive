import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

/** Strip YAML comments outside quotes so permission probes ignore prose. */
function stripYamlComments(workflowText: string): string {
  const codeLines: string[] = [];
  for (const line of workflowText.split("\n")) {
    let trimmed = line;
    let idx = 0;
    let inQuote = false;
    while (idx < line.length) {
      const ch = line[idx];
      if (ch === "'" || ch === '"') inQuote = !inQuote;
      else if (ch === "#" && !inQuote && (idx === 0 || " \t".includes(line[idx - 1] ?? ""))) {
        trimmed = line.slice(0, idx);
        break;
      }
      idx += 1;
    }
    codeLines.push(trimmed);
  }
  return codeLines.join("\n");
}

/** Extract one top-level job under `jobs:` (two-space keys only). */
function jobBlock(yml: string, jobKey: string): string {
  const re = new RegExp(`^  ${jobKey}:\\s*$`, "m");
  const start = yml.search(re);
  if (start < 0) return "";
  const after = yml.slice(start);
  const next = after.slice(1).search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? after : after.slice(0, next + 1);
}

const workflow = readText(".github/workflows/npm-publish.yml");
const code = stripYamlComments(workflow);
const prepare = jobBlock(code, "prepare");
const publish = jobBlock(code, "publish");
const postPublish = jobBlock(code, "post-publish");

describe("npm_publish_workflow (#5365 Prefer-A Bound)", () => {
  it("pins environment npm on the OIDC publish job", () => {
    expect(publish).toMatch(/^\s*environment:\s*npm\s*$/m);
    expect(prepare).not.toMatch(/^\s*environment:\s*/m);
    expect(postPublish).not.toMatch(/^\s*environment:\s*/m);
  });

  it("tightens push tags to v*.*.*", () => {
    expect(code).toMatch(/tags:\s*\n\s*-\s*"v\*\.\*\.\*"/);
    expect(code).not.toMatch(/-\s*"v\*"/);
  });

  it("splits prepare (no id-token) from publish (id-token only)", () => {
    const topPerms = code.match(/^permissions:\n((?:[ \t]+.+\n)*)/m)?.[1] ?? "";
    expect(topPerms).toMatch(/contents:\s*read/);
    expect(topPerms).not.toMatch(/id-token:\s*write/);
    expect(prepare).not.toMatch(/id-token:\s*write/);
    expect(postPublish).not.toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/id-token:\s*write/);
    expect(publish).toMatch(/contents:\s*read/);
  });

  it("publishes same-run tarballs with provenance and scripts suppressed", () => {
    expect(prepare).toMatch(/npm pack/);
    expect(prepare).toMatch(/upload-artifact/);
    expect(publish).toMatch(/download-artifact/);
    const publishCmds = publish.match(/npm publish[^\n]*/g) ?? [];
    expect(publishCmds.length).toBe(4);
    for (const cmd of publishCmds) {
      expect(cmd).toContain("--provenance");
      expect(cmd).toContain("--ignore-scripts");
      expect(cmd).toMatch(/\.tgz|TGZ|tarballs\//);
    }
    expect(publish).not.toMatch(/pnpm install/);
    expect(publish).not.toMatch(/pnpm -w run build/);
    expect(publish).not.toMatch(/npm-ops\.js/);
  });

  it("keeps GitHub-hosted runner and moves fixture off the OIDC job", () => {
    expect(publish).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(publish).not.toMatch(/blacksmith/);
    expect(postPublish).toContain("Post-publish two-pass fixture (#4271)");
    expect(postPublish).toContain("--post-publish-two-pass");
    expect(publish).not.toContain("--post-publish-two-pass");
  });

  it("constrains dispatch workflow ref and peels tag identity", () => {
    expect(prepare).toContain("refs/heads/master");
    expect(prepare).toContain("merge-base --is-ancestor");
    expect(prepare).toContain("rev-list -n 1");
    expect(code).toContain("workflow_dispatch");
    expect(prepare).toMatch(/workflow_dispatch must run from refs\/heads\/master[\s\S]*?exit 1/);
    expect(prepare).toMatch(/is not on origin\/master ancestry[\s\S]*?exit 1/);
  });

  it("maps numeric prerelease identifiers to dist-tag next", () => {
    expect(prepare).toContain("DIST_TAG=next");
    expect(prepare).toMatch(/PRE="\$\{BASH_REMATCH\[1\]\}"/);
    expect(prepare).toMatch(/\[\[ "\$\{PRE\}" =~ \^\[0-9\]\+\$ \]\]/);
    expect(prepare).not.toMatch(/DIST_TAG="\$\{BASH_REMATCH\[1\]\}"/);
  });

  it("runs post-publish from prepare-built runner artifact without source_sha checkout", () => {
    expect(prepare).toContain("post-publish-runner-");
    expect(postPublish).toContain("post-publish-runner-");
    expect(postPublish).toContain("download-artifact");
    expect(postPublish).toMatch(/path:\s*packages\/core/);
    expect(postPublish).toContain("--post-publish-two-pass");
    expect(postPublish).not.toMatch(/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.source_sha\s*\}\}/);
    expect(postPublish).not.toMatch(/pnpm install/);
    expect(postPublish).not.toMatch(/pnpm -w run build/);
  });
});
