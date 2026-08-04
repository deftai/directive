import { describe, expect, it } from "vitest";
import { classifyHookAuthzOps, classifyShellAuthzOps } from "./classify.js";

describe("classifyShellAuthzOps (#2944)", () => {
  it("classifies push/merge via #2711 reuse", () => {
    expect(classifyShellAuthzOps("git push origin HEAD")).toContain("push");
    expect(classifyShellAuthzOps("gh pr merge 1 --squash")).toContain("merge");
  });

  it("classifies PR create/ready/edit without nested-quantifier regex", () => {
    expect(classifyShellAuthzOps("gh pr create --title t")).toContain("pr");
    expect(classifyShellAuthzOps("gh pr ready 12")).toContain("pr");
    expect(classifyShellAuthzOps("gh.exe pr edit 3")).toContain("pr");
  });

  it("classifies issue create and test runners", () => {
    expect(classifyShellAuthzOps("gh issue create --title d")).toContain("issue_mutation");
    expect(classifyShellAuthzOps("pnpm test")).toContain("test");
    expect(classifyShellAuthzOps("vitest run")).toContain("test");
    expect(classifyShellAuthzOps("go test ./...")).toContain("test");
  });

  it("classifies settings and deploy heuristics", () => {
    expect(classifyShellAuthzOps("gh repo edit --visibility private")).toContain("settings");
    expect(classifyShellAuthzOps("terraform apply -auto-approve")).toContain("deployment");
    expect(classifyShellAuthzOps("fly deploy")).toContain("deployment");
  });

  it("returns empty for unclassifiable non-product shell", () => {
    expect(classifyShellAuthzOps("git status")).toEqual([]);
    expect(classifyShellAuthzOps("")).toEqual([]);
    expect(classifyShellAuthzOps("   ")).toEqual([]);
  });

  it("maps hook tools", () => {
    expect(
      classifyHookAuthzOps({
        toolName: "Write",
        shellCommand: null,
        isDirectWrite: true,
      }),
    ).toEqual(["edit"]);
    expect(
      classifyHookAuthzOps({
        toolName: "Bash",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual([]);
    expect(
      classifyHookAuthzOps({
        toolName: "Bash",
        shellCommand: "git push",
        isDirectWrite: false,
      }),
    ).toContain("push");
    expect(
      classifyHookAuthzOps({
        toolName: "create_pull_request",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["pr"]);
    expect(
      classifyHookAuthzOps({
        toolName: "create_issue",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["issue_mutation"]);
    expect(
      classifyHookAuthzOps({
        toolName: "Read",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual([]);
  });

  it("classifies gh with -R/--repo value flags before resource verb", () => {
    expect(classifyShellAuthzOps("gh -R owner/repo pr create --title t")).toContain("pr");
    expect(classifyShellAuthzOps("gh --repo owner/repo pr merge 1")).toContain("merge");
  });

  it("covers deploy/settings/api and env-prefixed shell", () => {
    expect(classifyShellAuthzOps("FOO=1 gh issue create --title t")).toContain("issue_mutation");
    expect(classifyShellAuthzOps("env FOO=1 cargo test")).toContain("test");
    expect(classifyShellAuthzOps("npm test")).toContain("test");
    expect(classifyShellAuthzOps("yarn test")).toContain("test");
    expect(classifyShellAuthzOps("task test")).toContain("test");
    expect(classifyShellAuthzOps("helm upgrade chart")).toContain("deployment");
    expect(classifyShellAuthzOps("kubectl apply -f x.yaml")).toContain("deployment");
    expect(classifyShellAuthzOps("vercel deploy")).toContain("deployment");
    expect(classifyShellAuthzOps("gh api repos/o/r/issues")).toContain("issue_mutation");
    expect(classifyShellAuthzOps("gh api repos/o/r/settings")).toContain("settings");
    expect(classifyShellAuthzOps("gh pr reopen 1")).toContain("pr");
    expect(
      classifyHookAuthzOps({
        toolName: "Shell",
        shellCommand: "git status",
        isDirectWrite: false,
      }),
    ).toEqual([]);
    expect(
      classifyHookAuthzOps({
        toolName: "mcp__github__merge_pull_request",
        shellCommand: null,
        isDirectWrite: false,
        mcpArgsText: "{}",
      }),
    ).toContain("merge");
  });

  it("classifies authz:grant / uat-* / revoke as settings (#3110)", () => {
    for (const cmd of [
      "deft authz:grant -- --operations edit --cohort x",
      "task authz:grant -- --operations edit,push",
      "directive authz:grant --template finish-loop",
      "pnpm exec deft authz:grant -- --operations edit",
      "npx deft authz grant --operations edit",
      "deft authz:uat-start -- --campaign uat-1",
      "task authz:uat-suspend",
      "deft authz:revoke -- grant-abc",
      "env FOO=1 deft authz:grant --operations edit",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Read-only show stays unclassifiable (not authority mutation).
    expect(classifyShellAuthzOps("deft authz:show")).toEqual([]);
  });

  it("classifies shell writes under .deft/authz as settings (#3110 containment)", () => {
    expect(classifyShellAuthzOps('echo {"x":1} > .deft/authz/grants/evil.json')).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("cp /tmp/g.json .deft/authz/grants/g.json")).toContain("settings");
    expect(classifyShellAuthzOps("mv grant.json .deft/authz/state.json")).toContain("settings");
    expect(
      classifyShellAuthzOps("Set-Content -Path .deft\\authz\\state.json -Value '{}'"),
    ).toContain("settings");
    // General-purpose writers (not only redirect + write-bin allowlist).
    expect(classifyShellAuthzOps("dd if=/tmp/x of=.deft/authz/state.json")).toContain("settings");
    expect(classifyShellAuthzOps("sed -i s/a/b/ .deft/authz/state.json")).toContain("settings");
    expect(
      classifyShellAuthzOps("python -c \"open('.deft/authz/grants/x.json','w').write('{}')\""),
    ).toContain("settings");
    // Pure reads stay unclassifiable (inspect via authz:show / host Read).
    expect(classifyShellAuthzOps("cat .deft/authz/state.json")).toEqual([]);
    // Redirect **from** store to backup is not a store write (dest is /tmp).
    expect(classifyShellAuthzOps("cat .deft/authz/state.json > /tmp/backup")).toEqual([]);
    // Indirect $VAR expansion (opaque names included — residual fail-open closed).
    expect(classifyShellAuthzOps("echo '{}' > \"$AUTHZ_DIR/state.json\"")).toContain("settings");
    expect(classifyShellAuthzOps("cp /tmp/g.json $AUTHZ_HOME/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("printf '{}' > \"$STORE\"")).toContain("settings");
    // Ordinary expanded writes outside authz store stay unclassifiable.
    expect(classifyShellAuthzOps('echo hi > "$HOME/out"')).toEqual([]);
    expect(classifyShellAuthzOps('cp x "$TMPDIR/y"')).toEqual([]);
    // Command substitution destinations (no contiguous .deft/authz literal).
    expect(classifyShellAuthzOps('cp /tmp/evil.json "$(echo .deft)/authz/state.json"')).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("cp /tmp/x `pwd`/grants/y.json")).toContain("settings");
    // Destructive + opaque var; split path; positional expansion toward store.
    expect(classifyShellAuthzOps("rm -rf $STORE")).toContain("settings");
    expect(classifyShellAuthzOps("cd .deft && echo x > authz/state.json")).toContain("settings");
    // Later redirect must not hide an earlier split-path store write.
    expect(
      classifyShellAuthzOps("cd .deft && echo x > authz/state.json && echo y > /tmp/z"),
    ).toContain("settings");
    expect(classifyShellAuthzOps("echo '{}' > $1/state.json")).toContain("settings");
    // Programmatic os.environ / process.env write (no shell $ expansion).
    expect(
      classifyShellAuthzOps(
        "python -c \"import os; open(os.environ['DEFT_AUTHZ_ROOT']+'/state.json','w').write('{}')\"",
      ),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps(
        "node -e \"require('fs').writeFileSync(process.env.AUTHZ_DIR+'/grants/x.json','{}')\"",
      ),
    ).toContain("settings");
    // Ordinary cleanup / non-store opaque dest stays unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("rm -rf $TMPDIR/build")).toEqual([]);
    expect(classifyShellAuthzOps("rm -rf $HOME/.cache/tmp")).toEqual([]);
    // Unrelated app state.json via environ is NOT an authz settings mutation.
    expect(
      classifyShellAuthzOps(
        "python -c \"import os; open(os.environ['APP_DIR']+'/state.json','w').write('{}')\"",
      ),
    ).toEqual([]);
  });

  it("covers gh flag forms and hook name variants (#2986)", () => {
    // --flag=value form and remaining GH_VALUE_FLAGS spellings.
    expect(classifyShellAuthzOps("gh --repo=owner/repo pr create --title t")).toContain("pr");
    expect(classifyShellAuthzOps("gh --hostname github.com pr merge 1")).toContain("merge");
    expect(classifyShellAuthzOps("gh -a app pr create --title t")).toContain("pr");
    expect(classifyShellAuthzOps("gh --app app pr edit 3")).toContain("pr");
    expect(classifyShellAuthzOps("gh --jq . pr ready 2")).toContain("pr");
    expect(classifyShellAuthzOps("sudo gh pr create --title t")).toContain("pr");
    expect(classifyShellAuthzOps("command gh pr merge 9")).toContain("merge");
    expect(classifyShellAuthzOps("pytest")).toContain("test");
    // Boolean short flags before resource are skipped without consuming a value.
    expect(classifyShellAuthzOps("gh --json pr merge 4")).toContain("merge");

    expect(
      classifyHookAuthzOps({
        toolName: "run_terminal_cmd",
        shellCommand: "git push origin HEAD",
        isDirectWrite: false,
      }),
    ).toContain("push");
    expect(
      classifyHookAuthzOps({
        toolName: "pull_request_create",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["pr"]);
    expect(
      classifyHookAuthzOps({
        toolName: "mcp__x__pr_create",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["pr"]);
    expect(
      classifyHookAuthzOps({
        toolName: "issue_create",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["issue_mutation"]);
    expect(
      classifyHookAuthzOps({
        toolName: "mcp__github__create_issue",
        shellCommand: null,
        isDirectWrite: false,
      }),
    ).toEqual(["issue_mutation"]);
  });
});
