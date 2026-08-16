/**
 * Map hook tool invocations to authz operation classes (#2944).
 * Reuses #2711 push/merge shell classification; adds PR create/advance detection
 * for UAT denials without re-owning runtimeAuthority Shell matchers.
 *
 * Token walks are O(n) — no nested-quantifier regex on untrusted shell input
 * (CodeQL js/polynomial-redos).
 */

import {
  classifyMcpTool,
  classifyShellCommand,
  listShellOps,
  type RuntimeAuthorityShellOp,
} from "../policy/runtime-authority.js";
import type { AuthzOperation } from "./types.js";

export type AuthzClassifiedOp = AuthzOperation | "test" | "evidence" | "unknown";

/**
 * Split on whitespace without nested quantifiers (O(n)).
 * Newlines become `;` segment breaks so compound lists like
 * `scp …authz…\necho ok` keep the scp dest (#3213 Greptile residual).
 * Bare space/tab/CR still only separate tokens.
 */
function shellTokens(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (c === " " || c === "\t" || c === "\r") {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    if (c === "\n") {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      // Emit a segment break once (avoid runs of `;` from blank lines).
      if (out.length > 0 && out[out.length - 1] !== ";") {
        out.push(";");
      }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function normalizeToken(token: string): string {
  return token.replace(/['"\\]/g, "").toLowerCase();
}

function isEnvAssign(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

/**
 * Walk tokens looking for `gh [opts] <resource> <verb>` patterns (O(n)).
 * Returns the resource+verb pair when found.
 */
/** gh global flags that take a separate value token. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-a", "--app", "-h", "--hostname", "-p", "--jq"]);

function findGhResourceVerb(tokens: readonly string[]): { resource: string; verb: string } | null {
  let i = 0;
  while (i < tokens.length && isEnvAssign(tokens[i] as string)) i++;
  const wrap = tokens[i] !== undefined ? normalizeToken(tokens[i] as string) : "";
  if (wrap === "sudo" || wrap === "env" || wrap === "command") {
    i++;
    while (i < tokens.length && isEnvAssign(tokens[i] as string)) i++;
  }
  const bin = tokens[i] !== undefined ? normalizeToken(tokens[i] as string) : "";
  if (bin !== "gh" && bin !== "gh.exe") return null;
  i++;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    const n = normalizeToken(t);
    if (!n.startsWith("-")) break;
    // --flag=value form consumes one token.
    if (n.startsWith("--") && n.includes("=")) {
      i++;
      continue;
    }
    // Value-taking short/long flags: -R owner/repo, --repo owner/repo
    if (GH_VALUE_FLAGS.has(t) || GH_VALUE_FLAGS.has(n)) {
      i += 2;
      continue;
    }
    i++;
  }
  const resource = tokens[i] !== undefined ? normalizeToken(tokens[i] as string) : "";
  const verb = tokens[i + 1] !== undefined ? normalizeToken(tokens[i + 1] as string) : "";
  if (resource.length === 0 || verb.length === 0) return null;
  return { resource, verb };
}

const TEST_BINS = new Set(["vitest", "pytest", "cargo", "npm", "pnpm", "yarn", "task"]);
const TEST_SECOND = new Set(["test"]);
const DEPLOY_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["terraform", "apply"],
  ["helm", "upgrade"],
  ["kubectl", "apply"],
  ["fly", "deploy"],
  ["vercel", "deploy"],
];

function hasGoTest(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (
      normalizeToken(tokens[i] as string) === "go" &&
      normalizeToken(tokens[i + 1] as string) === "test"
    ) {
      return true;
    }
  }
  return false;
}

function hasTestRunner(tokens: readonly string[]): boolean {
  if (hasGoTest(tokens)) return true;
  for (let i = 0; i < tokens.length; i++) {
    const t = normalizeToken(tokens[i] as string);
    if (TEST_BINS.has(t)) {
      // vitest/pytest alone, or npm/pnpm/yarn/task/cargo + test
      if (t === "vitest" || t === "pytest") return true;
      const next = tokens[i + 1] !== undefined ? normalizeToken(tokens[i + 1] as string) : "";
      if (TEST_SECOND.has(next)) return true;
    }
  }
  return false;
}

function hasDeploy(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = normalizeToken(tokens[i] as string);
    const b = normalizeToken(tokens[i + 1] as string);
    for (const [bin, verb] of DEPLOY_PAIRS) {
      if (a === bin && b === verb) return true;
    }
  }
  return false;
}

function hasGhApiPath(tokens: readonly string[], needle: string): boolean {
  let sawGh = false;
  let sawApi = false;
  for (const raw of tokens) {
    const t = normalizeToken(raw);
    if (t === "gh" || t === "gh.exe") {
      sawGh = true;
      continue;
    }
    if (sawGh && t === "api") {
      sawApi = true;
      continue;
    }
    if (sawApi && t.includes(needle)) return true;
  }
  return false;
}

/**
 * Authz authority-mutating CLI verbs (#3110). Classified as **settings** so under
 * active UAT they deny without a prior human grant — never empty → shell-op-unclassifiable fail-open.
 */
const AUTHZ_MUTATING_SUBCOMMANDS = new Set(["grant", "uat-start", "uat-suspend", "revoke"]);

/**
 * Policy authority mutators that weaken merge / branch / directive gates (#3186).
 * Classified as **settings** — agents must not self-serve these under active UAT.
 */
const POLICY_AUTHORITY_MUTATORS = new Set([
  "allow-bot-merge",
  "allow-direct-commits",
  "disable-directive",
  "enable-directive",
]);

/** Kill-switch / permanent opt-out basenames agents must not plant under UAT (#3186 / #3039). */
const KILL_SWITCH_BASENAMES = [".deft-directive-disable", ".no-deft-directive"] as const;

/**
 * Downloaders / decoders / remote-copy tools that can plant files without shell
 * redirects (#3206 / #3213 / #3245). Not in INDIRECT_WRITE_BINS: those feed hasWriteShape
 * and would classify bare `curl $URL` as a store write via opaque-expansion heuristics.
 */
const DOWNLOADER_DECODER_BINS = new Set([
  "curl",
  "wget",
  "xxd",
  "openssl",
  // #3213 residual after #3206: alternate downloaders / remote copy.
  "scp",
  "aria2c",
  "certutil",
  // #3245 residual after #3213: archive extractors + further alt downloaders.
  "tar",
  "bsdtar",
  "unzip",
  "7z",
  "7za",
  "7zr",
  "rclone",
  "axel",
  "fetch",
  "socat",
  "lftp",
  // #3288 residual after #3245: crypto / alt-download / pipe / archive bins.
  "gpg",
  "age",
  "zstd",
  "unzstd",
  "sftp",
  "wget2",
  "http",
  "https",
  "yt-dlp",
  "ytdlp",
  "aria2",
  "mbuffer",
  "cpio",
  // #3311 residual after #3288: versioned / alternate write bins.
  "gpg2",
  "gpg1",
  "rage",
  "xh",
  "httpie",
  "wcurl",
  "curlie",
  "uudecode",
  "iconv",
  "gtar",
  "star",
  "gnutar",
  "pax",
  // #3336 residual after #3311: further write bins (oras/ncat/patch peers).
  "oras",
  "lwp-download",
  "ncat",
  "patch",
  "base32",
  "lrzip",
  "unar",
  "cabextract",
  "ditto",
  "dpkg-deb",
  "hg",
  "msguniq",
  // #3354 residual after #3336: nc/7zz/msgfmt peers + plant writers.
  "nc",
  "netcat",
  "7zz",
  "msgfmt",
  "msgcat",
  "lz4",
  "lzop",
  "unrar",
  "rar",
  "aunpack",
  "atool",
  "ftpget",
  "tftp",
  "sqlite3",
  "crane",
  "objcopy",
  // #3382 residual after #3354: dest forms that are not generic -o/--output/--outfile.
  "cmake",
  "script",
  "gallery-dl",
  "megadl",
  "ncftpget",
  "svn",
  "fossil",
  "bzr",
  "cvs",
  "darcs",
  "ed",
  "nvim",
  "nano",
  "vim",
  "vi",
]);

/**
 * Archive extractors / alt writers that can plant via pathish operands without
 * shell redirects (#3245 / #3288 / #3311 / #3336 / #3354 / #3382). Used for pathish authz/kill scans (prefer deny)
 * and write-shape residual under UAT — not bare curl-class URL fetches.
 */
const ARCHIVE_ALT_WRITE_BINS = new Set([
  "tar",
  "bsdtar",
  "unzip",
  "7z",
  "7za",
  "7zr",
  "rclone",
  "axel",
  "fetch",
  "socat",
  "lftp",
  // #3288 residual after #3245.
  "gpg",
  "age",
  "zstd",
  "unzstd",
  "sftp",
  "wget2",
  "http",
  "https",
  "yt-dlp",
  "ytdlp",
  "aria2",
  "mbuffer",
  "cpio",
  // #3311 residual after #3288.
  "gpg2",
  "gpg1",
  "rage",
  "xh",
  "httpie",
  "wcurl",
  "curlie",
  "uudecode",
  "iconv",
  "gtar",
  "star",
  "gnutar",
  "pax",
  // #3336 residual after #3311.
  "oras",
  "lwp-download",
  "ncat",
  "patch",
  "base32",
  "lrzip",
  "unar",
  "cabextract",
  "ditto",
  "dpkg-deb",
  "hg",
  "msguniq",
  // #3354 residual after #3336.
  "nc",
  "netcat",
  "7zz",
  "msgfmt",
  "msgcat",
  "lz4",
  "lzop",
  "unrar",
  "rar",
  "aunpack",
  "atool",
  "ftpget",
  "tftp",
  "sqlite3",
  "crane",
  "objcopy",
  // #3382 residual: dedicated dest-form writers (not general-purpose cmake/git/editors).
  "gallery-dl",
  "megadl",
  "ncftpget",
]);

/**
 * Bins whose pathish operands are scanned for authz/kill destinations (#3213 / #3245 / #3288 / #3311 / #3336 / #3354 / #3382).
 * Prefer a Set over a long `||` chain so coverage counts one membership check, not N branches.
 */
const PROTECTED_POSITIONAL_BINS = new Set([
  "scp",
  "certutil",
  "rclone",
  "tar",
  "bsdtar",
  "unzip",
  "7z",
  "7za",
  "7zr",
  "socat",
  "lftp",
  // #3288 residual.
  "sftp",
  "cpio",
  "gpg",
  "age",
  "zstd",
  "unzstd",
  "mbuffer",
  // #3311 residual: versioned crypto + archive/decoder peers.
  "gpg2",
  "gpg1",
  "rage",
  "uudecode",
  "iconv",
  "gtar",
  "star",
  "gnutar",
  "pax",
  // #3336 residual: positional dest writers (ditto/dpkg-deb/hg/lwp-download).
  "oras",
  "lwp-download",
  "ncat",
  "patch",
  "base32",
  "lrzip",
  "unar",
  "cabextract",
  "ditto",
  "dpkg-deb",
  "hg",
  "msguniq",
  // #3354 residual: positional dest writers (nc/7zz/unrar/ftpget/crane/objcopy/sqlite3).
  "nc",
  "netcat",
  "7zz",
  "msgfmt",
  "msgcat",
  "lz4",
  "lzop",
  "unrar",
  "rar",
  "aunpack",
  "atool",
  "ftpget",
  "tftp",
  "sqlite3",
  "crane",
  "objcopy",
  // #3382 residual: positional dest writers (cmake copy / script / VCS / editors).
  "cmake",
  "script",
  "gallery-dl",
  "megadl",
  "ncftpget",
  "svn",
  "fossil",
  "bzr",
  "cvs",
  "darcs",
  "ed",
  "nvim",
  "nano",
  "vim",
  "vi",
]);

/** wget family (directory-prefix dest flags). */
const WGET_FAMILY_BINS = new Set(["wget", "wget2"]);
/** aria2 family (dir dest flags). */
const ARIA2_FAMILY_BINS = new Set(["aria2c", "aria2"]);
/** 7z family (attached -oDIR only). Includes 7zz (#3354). */
const SEVEN_Z_FAMILY_BINS = new Set(["7z", "7za", "7zr", "7zz"]);
/** aunpack / atool extract-to dest flags (#3354). */
const ATOOL_FAMILY_BINS = new Set(["aunpack", "atool"]);
const ATOOL_DIR_DEST_FLAGS = new Set(["-x", "--extract-to"]);
/** sqlite3 meta-commands that plant a file dest (#3354). */
const SQLITE3_OUTPUT_META = [".output", ".once"] as const;
/** tar family (chdir -C / --directory). Includes GNU/Schily aliases (#3311). */
const TAR_FAMILY_BINS = new Set(["tar", "bsdtar", "gtar", "star", "gnutar"]);
/** xh / httpie family (download-dir dest flags) (#3311). */
const XH_FAMILY_BINS = new Set(["xh", "httpie"]);
/** gallery-dl dest-dir flags (#3382). */
const GALLERY_DL_FAMILY_BINS = new Set(["gallery-dl", "gallery_dl"]);
const GALLERY_DL_DIR_DEST_FLAGS = new Set(["-d", "--destination", "--dest"]);
/** megadl dest-path flags (#3382). */
const MEGADL_FAMILY_BINS = new Set(["megadl"]);
const MEGADL_PATH_DEST_FLAGS = new Set(["--path"]);
/**
 * Extra dest flags harvested on unknown write-shaped bins when dest is protected (#3382).
 * Not merged into DOWNLOADER_FILE_DEST_FLAGS: curl `-d` is POST data, not a file dest.
 */
const GENERIC_PROTECTED_EXTRA_DEST_FLAGS = new Set([
  "-d",
  "--dir",
  "--destination",
  "--dest",
  "--path",
  "--directory",
]);

/**
 * File destination flags for downloaders/decoders (#3206).
 * normalizeToken lowercases, so wget `-O` and curl `-o` share `-o`.
 * scp: `-o` is an SSH option — excluded in isDownloaderDestFlag.
 * 7z: `-oDIR` is attached-only (no separate value token).
 */
const DOWNLOADER_FILE_DEST_FLAGS = new Set([
  "-o",
  "--output",
  "--output-document",
  "--output-file",
  "-out",
  "--out",
  "--outfile",
  // unar single-dash long form; GNU/others use --output-directory.
  "-output-directory",
  "--output-directory",
]);

/** Directory destination flags (curl --output-dir / wget -P / aria2c -d); bin-scoped below. */
const CURL_DIR_DEST_FLAGS = new Set(["--output-dir"]);
const WGET_DIR_DEST_FLAGS = new Set(["-p", "--directory-prefix"]);
const ARIA2C_DIR_DEST_FLAGS = new Set(["-d", "--dir"]);
/**
 * tar/bsdtar extract directory (#3245).
 * Case-sensitive: POSIX tar uses capital `-C` for chdir; lower `-c` is create and is NOT dest.
 */
const TAR_DIR_DEST_FLAGS_EXACT = new Set(["-C"]);
const TAR_DIR_DEST_FLAGS_LOWER = new Set(["--directory"]);
/** unzip / cabextract extract directory (#3245 / #3336). */
const UNZIP_DIR_DEST_FLAGS = new Set(["-d"]);
const UNZIP_DIR_DEST_BINS = new Set(["unzip", "cabextract"]);
/** xh / httpie download directory (#3311). */
const XH_DIR_DEST_FLAGS = new Set(["--download-dir"]);
/**
 * cpio chdir before extract/create (#3288).
 * Case-sensitive short form: POSIX cpio uses capital `-D`; lower `-d` is a create option bit.
 * Long form `--directory` is accepted lowercased.
 */
const CPIO_DIR_DEST_FLAGS_EXACT = new Set(["-D"]);
const CPIO_DIR_DEST_FLAGS_LOWER = new Set(["--directory"]);
/**
 * Symlink / hard-link plant bins (#3213). Absent from prior killWriteBins →
 * `ln -sf … .deft-directive-disable` classified empty → UAT fail-open.
 */
const SYMLINK_PLANT_BINS = new Set(["ln", "link", "mklink"]);

/** socat address prefixes that open a write target (#3245). */
const SOCAT_WRITE_ADDR_PREFIXES = [
  "open:",
  "create:",
  "creat:",
  "append:",
  "owronly:",
  "oappend:",
] as const;
/** Final path segment of a token (path-qualified bins / .exe). */
function binBareName(token: string): string {
  const pathish = token.replace(/['"]/g, "").toLowerCase().replace(/\\/g, "/");
  const base = pathish.includes("/") ? pathish.slice(pathish.lastIndexOf("/") + 1) : pathish;
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/** True when token names a downloader/decoder bin (bare or path-qualified). */
function isDownloaderDecoderBin(token: string): boolean {
  const n = normalizeToken(token);
  if (n.startsWith("-")) return false;
  return DOWNLOADER_DECODER_BINS.has(binBareName(token));
}

/**
 * True when `flag` (normalized lower) or `rawFlag` (original token) is a dest flag for `bin`.
 * tar `-C` must use raw case: lowercased `-c` is create-archive, not chdir (#3245).
 * 7z uses attached `-oDIR` only — separate `-o PATH` is not a 7z dest form (handled elsewhere).
 */
function isDownloaderDestFlag(flag: string, bin: string, rawFlag?: string): boolean {
  // scp: `-o` is OpenSSH option (ProxyCommand, …), not a file dest flag.
  if (bin === "scp") return false;
  // 7z family: only attached `-oDIR` (parsed in attached-short branch), not separate `-o PATH`.
  if (SEVEN_Z_FAMILY_BINS.has(bin)) {
    return false;
  }
  // #3288: cpio `-o` is copy-out (create archive), not a file dest; dest is `-D` / `--directory`.
  if (bin === "cpio") {
    if (rawFlag !== undefined && CPIO_DIR_DEST_FLAGS_EXACT.has(rawFlag)) return true;
    // Long form is case-insensitive via normalizeToken (`flag` already lowercased).
    if (CPIO_DIR_DEST_FLAGS_LOWER.has(flag)) return true;
    return false;
  }
  if (DOWNLOADER_FILE_DEST_FLAGS.has(flag)) return true;
  if (bin === "curl" && CURL_DIR_DEST_FLAGS.has(flag)) return true;
  if (WGET_FAMILY_BINS.has(bin) && WGET_DIR_DEST_FLAGS.has(flag)) return true;
  if (ARIA2_FAMILY_BINS.has(bin) && ARIA2C_DIR_DEST_FLAGS.has(flag)) return true;
  if (TAR_FAMILY_BINS.has(bin)) {
    if (rawFlag !== undefined && TAR_DIR_DEST_FLAGS_EXACT.has(rawFlag)) return true;
    if (TAR_DIR_DEST_FLAGS_LOWER.has(flag)) return true;
    // Exact match on raw when normalize collapsed case for long flags only.
    if (rawFlag !== undefined && TAR_DIR_DEST_FLAGS_LOWER.has(normalizeToken(rawFlag))) return true;
    return false;
  }
  if (UNZIP_DIR_DEST_BINS.has(bin) && UNZIP_DIR_DEST_FLAGS.has(flag)) return true;
  if (XH_FAMILY_BINS.has(bin) && XH_DIR_DEST_FLAGS.has(flag)) return true;
  if (ATOOL_FAMILY_BINS.has(bin) && ATOOL_DIR_DEST_FLAGS.has(flag)) return true;
  if (GALLERY_DL_FAMILY_BINS.has(bin) && GALLERY_DL_DIR_DEST_FLAGS.has(flag)) return true;
  if (MEGADL_FAMILY_BINS.has(bin) && MEGADL_PATH_DEST_FLAGS.has(flag)) return true;
  return false;
}
/**
 * OpenSSH/scp flags that take a separate value token (`-o ProxyCommand=…`, `-i key`, `-P port`).
 * Not dest flags — must skip so value tokens are not mistaken for write destinations (#3213).
 * Case-sensitive where needed: scp `-P` (port) takes a value; `-p` (preserve) does not.
 */
const SCP_VALUE_FLAGS_LOWER = new Set(["-o", "-i", "-c", "-s", "-j", "-f", "-l", "-b"]);
const SCP_VALUE_FLAGS_EXACT = new Set(["-P", "-F", "-S", "-J"]);

/** Shell metacharacters that end a command segment (compound lists / pipelines). */
function isShellSegmentBreak(token: string): boolean {
  const t = token.trim();
  if (t.length === 0) return false;
  if (t === ";" || t === "|" || t === "||" || t === "&&" || t === "&") return true;
  // Trailing operator glued to a prior token is handled by pathish stripping; bare ops here.
  return false;
}

/**
 * First unquoted, unescaped shell-list operator (`;` `&` `|`) in a token, or -1.
 * Quoted operators (e.g. `'file;name'`) and escaped unquoted ops (e.g. `path\;file`)
 * are literal data and must not end scp segments (#3213 Greptile residual).
 * O(n). Unquoted / double-quoted `\` escapes the next char; single-quoted `\` is literal.
 */
function firstUnquotedShellOpIndex(raw: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let k = 0; k < raw.length; k++) {
    const ch = raw[k] as string;
    // Outside single quotes, backslash escapes the next character (POSIX-ish).
    if (ch === "\\" && k + 1 < raw.length && !inSingle) {
      k++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === ";" || ch === "&" || ch === "|") return k;
  }
  return -1;
}

/**
 * Destinations from curl/wget/xxd/openssl/scp/aria2c/certutil via -o/--output/-O/-out/
 * --output-dir/-P/-d/--dir (separate, =value, or attached short form), xxd -r path-like
 * write positionals (#3206), positional dests for scp/certutil (#3213), and #3245 residual
 * archive/alt bins (tar -C, unzip -d, 7z -oDIR, rclone positionals, socat OPEN:, axel/fetch -o).
 * openssl uses flags only (no positional dests — avoids treating -in paths as writes).
 * Segment stops at shell operators so compound `scp …authz…; echo` cannot overwrite dests.
 * O(n) token walk — no nested-quantifier regex on untrusted input.
 */
function downloaderDecoderDestinations(tokens: readonly string[]): string[] {
  const dests: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isDownloaderDecoderBin(tokens[i] as string)) {
      i++;
      continue;
    }
    const bin = binBareName(tokens[i] as string);
    i++;
    // xxd reverse mode writes; without -r, path positionals are dump inputs (read).
    let xxdReverse = false;
    // scp / certutil / rclone / archive extractors: collect pathish operands in this segment.
    // Fail-closed under UAT: any pathish mentioning protected store/kill paths is a dest
    // candidate (scp source-or-dest of `.deft/authz` is treated as settings — prefer deny
    // over source/dest thrash). Last pathish remains the ordinary write dest.
    // Segment breaks (`;`/`\n`/glued ops) prevent following-command overwrite.
    let lastPositionalPath: string | null = null;
    const protectedPathish: string[] = [];
    const collectsProtectedPositionals = PROTECTED_POSITIONAL_BINS.has(bin);
    while (i < tokens.length) {
      const raw = tokens[i] as string;
      const n = normalizeToken(raw);

      // Bare shell ops end this bin's segment. Do NOT use normalizeToken here —
      // quoted `';'` becomes `;` after strip and would cut before the real authz dest
      // (Greptile P1 residual #3213). Glued ops are handled by firstUnquotedShellOpIndex.
      if (isShellSegmentBreak(raw)) {
        break;
      }

      // New bare bin starts another command segment (not pathish ./wget operands).
      if (
        !n.startsWith("-") &&
        !raw.includes("/") &&
        !raw.includes("\\") &&
        isDownloaderDecoderBin(raw)
      ) {
        break;
      }

      if (bin === "xxd" && (n === "-r" || n === "--reverse")) {
        xxdReverse = true;
        i++;
        continue;
      }

      // Skip openssl/xxd input flags + value so -in PATH is not a write dest.
      if (n === "-in" || n === "--in" || n === "-inform" || n === "--inform") {
        const next = tokens[i + 1];
        if (next !== undefined && !String(next).startsWith("-")) {
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // scp: skip OpenSSH value-taking flags + their values (-o Option=Value, -i key, -P port).
      if (
        bin === "scp" &&
        (SCP_VALUE_FLAGS_LOWER.has(n) ||
          SCP_VALUE_FLAGS_EXACT.has(raw) ||
          SCP_VALUE_FLAGS_EXACT.has(n))
      ) {
        const next = tokens[i + 1];
        if (next !== undefined && !String(next).startsWith("-") && !isShellSegmentBreak(next)) {
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // --flag=value (and rare -out=value); scp -oOption=Value attached form also lands here.
      // tar --directory=PATH also lands here.
      if (n.includes("=") && (n.startsWith("-") || n.startsWith("--"))) {
        const eq = raw.indexOf("=");
        const flagRaw = raw.slice(0, eq);
        const flag = normalizeToken(flagRaw);
        if (isDownloaderDestFlag(flag, bin, flagRaw)) {
          dests.push(pathishToken(raw.slice(eq + 1)));
        }
        // scp attached -oProxyCommand=… is not a file dest — skip without recording.
        i++;
        continue;
      }

      // Attached short: -oPATH / -OPATH (after lowercasing both are -opath…)
      // Skip for scp (OpenSSH -oOption=Value attached forms are not file dests).
      // 7z requires attached -oDIR (#3245).
      if (bin !== "scp" && n.startsWith("-") && !n.startsWith("--") && n.length > 2) {
        if (n.startsWith("-out") && n.length > 4 && !n.startsWith("-output")) {
          dests.push(pathishToken(raw.slice(4)));
          i++;
          continue;
        }
        // cpio `-o` is copy-out create mode, not a file dest (#3288).
        if (bin !== "cpio" && n.startsWith("-o") && !n.startsWith("-out") && n.length > 2) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
        // wget / wget2 attached -Pdir
        if (
          WGET_FAMILY_BINS.has(bin) &&
          n.startsWith("-p") &&
          n.length > 2 &&
          !n.startsWith("-proxy")
        ) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
        // aria2c / aria2 attached -dDIR (#3213 / #3288)
        if (ARIA2_FAMILY_BINS.has(bin) && n.startsWith("-d") && n.length > 2) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
        // gallery-dl attached -dDIR (#3382)
        if (GALLERY_DL_FAMILY_BINS.has(bin) && n.startsWith("-d") && n.length > 2) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
        // unzip / cabextract attached -dDIR (#3245 / #3336)
        if (UNZIP_DIR_DEST_BINS.has(bin) && n.startsWith("-d") && n.length > 2) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
        // aunpack / atool attached -XDIR (#3354)
        if (ATOOL_FAMILY_BINS.has(bin) && n.startsWith("-x") && n.length > 2) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
        // tar attached -CDIR (rare; capital C required)
        if (TAR_FAMILY_BINS.has(bin) && raw.startsWith("-C") && raw.length > 2) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
        // cpio attached -DDIR (#3288; capital D required)
        if (bin === "cpio" && raw.startsWith("-D") && raw.length > 2) {
          dests.push(pathishToken(raw.slice(2)));
          i++;
          continue;
        }
      }

      // Separate value: -o PATH / --output PATH / -out PATH / --output-dir / -P / -d / -C DIR
      if (isDownloaderDestFlag(n, bin, raw)) {
        const next = tokens[i + 1];
        if (next !== undefined && !String(next).startsWith("-") && !isShellSegmentBreak(next)) {
          dests.push(pathishToken(next));
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // xxd -r only: path-like write positionals (not http(s) URLs). openssl: flags only.
      if (bin === "xxd" && xxdReverse && !n.startsWith("-")) {
        const p = pathishToken(raw);
        if (
          (p.includes("/") || p.startsWith(".") || p.includes("\\")) &&
          !p.startsWith("http:") &&
          !p.startsWith("https:") &&
          !p.startsWith("ftp:")
        ) {
          dests.push(p);
        }
      }

      // socat write address forms: OPEN:path, CREATE:path, APPEND:path (#3245).
      if (bin === "socat" && !n.startsWith("-")) {
        const p = pathishToken(raw);
        for (const prefix of SOCAT_WRITE_ADDR_PREFIXES) {
          if (p.startsWith(prefix) && p.length > prefix.length) {
            const dest = p.slice(prefix.length);
            dests.push(dest);
            if (
              dest.includes(".deft/authz") ||
              dest.includes(".deft-directive-disable") ||
              dest.includes(".no-deft-directive")
            ) {
              protectedPathish.push(dest);
            }
            break;
          }
        }
      }

      // sqlite3 `.output` / `.once` dest (separate token or `.output PATH` in one token) (#3354).
      if (bin === "sqlite3") {
        const meta = sqlite3MetaDest(raw, tokens[i + 1]);
        if (meta !== null) {
          dests.push(meta.dest);
          if (pathishIsAuthzDir(meta.dest) || pathishMentionsKillSwitch(meta.dest)) {
            protectedPathish.push(meta.dest);
          }
          i += meta.consumedNext ? 2 : 1;
          continue;
        }
      }

      // scp / certutil / rclone / archive extractors: pathish operands (quote-aware glued-op cut).
      // Under UAT: any `.deft/authz` / kill-switch pathish is fail-closed settings
      // (read vs write thrash deferred — prefer deny over dest-parser perfection; #3213 / #3245).
      if (collectsProtectedPositionals && !n.startsWith("-")) {
        const cut = firstUnquotedShellOpIndex(raw);
        const cleaned = cut >= 0 ? raw.slice(0, cut) : raw;
        const p = pathishToken(cleaned);
        if (p.length > 0) {
          lastPositionalPath = p;
          // Fail-closed: protected store/kill basenames anywhere in pathish.
          if (
            p.includes(".deft/authz") ||
            p.includes(".deft-directive-disable") ||
            p.includes(".no-deft-directive")
          ) {
            protectedPathish.push(p);
          }
        }
        if (cut >= 0) {
          i++;
          break;
        }
      }
      i++;
    }
    // Prefer protected pathish (fail-closed) then last ordinary dest.
    for (const p of protectedPathish) {
      dests.push(p);
    }
    if (lastPositionalPath !== null && !protectedPathish.includes(lastPositionalPath)) {
      dests.push(lastPositionalPath);
    }
  }
  // #3354: fail-closed dest flags on unknown write-shaped bins (not named-peer only).
  for (const dest of genericProtectedDests(tokens)) {
    dests.push(dest);
  }
  return dests;
}
function authzSubcommandFromToken(token: string): string | null {
  const t = normalizeToken(token);
  if (t.startsWith("authz:")) {
    const sub = t.slice("authz:".length);
    return AUTHZ_MUTATING_SUBCOMMANDS.has(sub) ? sub : null;
  }
  return AUTHZ_MUTATING_SUBCOMMANDS.has(t) ? t : null;
}

function policyMutatorFromToken(token: string): string | null {
  const t = normalizeToken(token);
  if (t.startsWith("policy:")) {
    const sub = t.slice("policy:".length);
    return POLICY_AUTHORITY_MUTATORS.has(sub) ? sub : null;
  }
  return POLICY_AUTHORITY_MUTATORS.has(t) ? t : null;
}

/**
 * Detect `deft|task|directive authz:grant` / `authz grant` (and wrappers) in shell tokens.
 * O(n) token walk — no nested-quantifier regex on untrusted input.
 */
function hasAuthzMutatingCli(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw === undefined) break;
    const t = normalizeToken(raw);
    // Combined form anywhere: authz:grant / authz:uat-suspend / …
    if (authzSubcommandFromToken(t) !== null && t.startsWith("authz:")) {
      return true;
    }
    // Separated form: … authz grant|uat-start|uat-suspend|revoke
    // Also path-ish bins ending in /authz or \authz (node …/authz.js grant).
    const isAuthzBin =
      t === "authz" ||
      t.endsWith("/authz") ||
      t.endsWith("\\authz") ||
      t.endsWith("/authz.js") ||
      t.endsWith("\\authz.js") ||
      t.endsWith("/authz.ts") ||
      t.endsWith("\\authz.ts");
    if (!isAuthzBin) continue;
    const next = tokens[i + 1] !== undefined ? normalizeToken(tokens[i + 1] as string) : "";
    if (authzSubcommandFromToken(next) !== null) return true;
  }
  return false;
}

/**
 * Detect `policy:allow-bot-merge` / `policy allow-direct-commits` / peers (#3186).
 * O(n) token walk — no nested-quantifier regex on untrusted input.
 */
function hasPolicyAuthorityMutator(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    if (raw === undefined) break;
    const t = normalizeToken(raw);
    if (policyMutatorFromToken(t) !== null && t.startsWith("policy:")) {
      return true;
    }
    const isPolicyBin =
      t === "policy" ||
      t.endsWith("/policy") ||
      t.endsWith("\\policy") ||
      t.endsWith("/policy.js") ||
      t.endsWith("\\policy.js") ||
      t.endsWith("/policy.ts") ||
      t.endsWith("\\policy.ts");
    if (!isPolicyBin) continue;
    const next = tokens[i + 1] !== undefined ? normalizeToken(tokens[i + 1] as string) : "";
    if (policyMutatorFromToken(next) !== null) return true;
  }
  return false;
}

/** True when pathish token names a kill-switch basename (quote-strip resistant). */
function pathishIsProtectedDest(pathish: string): boolean {
  return pathishIsAuthzDir(pathish) || pathishMentionsKillSwitch(pathish);
}

function isGenericProtectedDestFlag(flag: string): boolean {
  return DOWNLOADER_FILE_DEST_FLAGS.has(flag) || GENERIC_PROTECTED_EXTRA_DEST_FLAGS.has(flag);
}

/**
 * Fail-closed dest harvest for write-shaped Shell under UAT (#3354 / #3382).
 * Named-bin parsers above are not the only path: any token that looks like
 * `-o` / `--output` / `--outfile` / `--output-file` / `-d` / `--dir` /
 * `--destination` / `--path` / `--directory` (or attached `-oDIR` / `-dDIR`)
 * whose dest is authz/kill-switch is collected even when the bin is unknown.
 * scp `-o` (OpenSSH option) and cpio `-o` (copy-out) stay excluded.
 */
function genericProtectedDests(tokens: readonly string[]): string[] {
  const dests: string[] = [];
  // Track the current command bin — scp `-o` is OpenSSH option, cpio `-o` is copy-out.
  // Skipping only when the current token itself is `scp`/`cpio` missed later `-o` values (#3354).
  let currentBin = "";
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i] as string;
    const n = normalizeToken(raw);
    if (isShellSegmentBreak(raw)) {
      currentBin = "";
      continue;
    }
    if (!n.startsWith("-")) {
      if (isDownloaderDecoderBin(raw)) {
        currentBin = binBareName(raw);
      } else if (
        currentBin.length === 0 &&
        !raw.includes("/") &&
        !raw.includes("\\") &&
        n.length > 0
      ) {
        currentBin = binBareName(raw);
      }
    }
    if (currentBin === "scp" || currentBin === "cpio") continue;
    if (n.includes("=") && (n.startsWith("-") || n.startsWith("--"))) {
      const eq = raw.indexOf("=");
      const flag = normalizeToken(raw.slice(0, eq));
      if (isGenericProtectedDestFlag(flag)) {
        const dest = pathishToken(raw.slice(eq + 1));
        if (pathishIsProtectedDest(dest)) dests.push(dest);
      }
      continue;
    }
    if (
      n.startsWith("-") &&
      !n.startsWith("--") &&
      n.startsWith("-o") &&
      !n.startsWith("-out") &&
      n.length > 2
    ) {
      const dest = pathishToken(raw.slice(2));
      if (pathishIsProtectedDest(dest)) dests.push(dest);
      continue;
    }
    if (n.startsWith("-") && !n.startsWith("--") && n.startsWith("-d") && n.length > 2) {
      const dest = pathishToken(raw.slice(2));
      if (pathishIsProtectedDest(dest)) dests.push(dest);
      continue;
    }
    if (isGenericProtectedDestFlag(n)) {
      const next = tokens[i + 1];
      if (next !== undefined && !String(next).startsWith("-") && !isShellSegmentBreak(next)) {
        const dest = pathishToken(next);
        if (pathishIsProtectedDest(dest)) dests.push(dest);
      }
    }
  }
  return dests;
}

function sqlite3MetaDest(
  raw: string,
  next: string | undefined,
): { dest: string; consumedNext: boolean } | null {
  const p = pathishToken(raw);
  for (const meta of SQLITE3_OUTPUT_META) {
    if (p === meta) {
      if (next !== undefined && !String(next).startsWith("-") && !isShellSegmentBreak(next)) {
        return { dest: pathishToken(next), consumedNext: true };
      }
      return null;
    }
    if (p.startsWith(`${meta} `) || p.startsWith(`${meta}\t`)) {
      const dest = p.slice(meta.length).trim();
      if (dest.length > 0 && dest !== "|") return { dest, consumedNext: false };
    }
  }
  return null;
}

function pathishMentionsKillSwitch(pathish: string): boolean {
  for (const name of KILL_SWITCH_BASENAMES) {
    if (pathish === name || pathish.endsWith(`/${name}`) || pathish.includes(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Shell write targeting `.deft-directive-disable` / `.no-deft-directive` (#3186 / #3039 / #3213).
 * Planting the kill-switch under UAT would full-bypass subsequent gates without operator recovery.
 * Includes symlink plant bins (`ln`/`link`/`mklink`) and quote-split-resistant basename checks.
 */
function hasKillSwitchShellWrite(command: string, tokens: readonly string[]): boolean {
  const lower = command.toLowerCase().replace(/\\/g, "/");
  // Quote-stripped form so `'.deft'-directive-disable`-class splits still match (#3213).
  const stripped = lower.replace(/['"]/g, "");
  let mentionsKill = false;
  for (const name of KILL_SWITCH_BASENAMES) {
    if (lower.includes(name) || stripped.includes(name)) {
      mentionsKill = true;
      break;
    }
  }
  if (!mentionsKill) {
    for (const t of tokens) {
      if (pathishMentionsKillSwitch(pathishToken(t))) {
        mentionsKill = true;
        break;
      }
    }
  }
  if (!mentionsKill) return false;

  // Redirect dest region after each `>` / `>>` (O(n)); check raw + quote-stripped.
  for (const hay of [lower, stripped]) {
    for (let i = 0; i < hay.length; i++) {
      if (hay[i] !== ">") continue;
      let j = i + 1;
      if (j < hay.length && hay[j] === ">") j++;
      let end = j;
      while (
        end < hay.length &&
        hay[end] !== "|" &&
        hay[end] !== ";" &&
        hay[end] !== "&" &&
        hay[end] !== "\n"
      ) {
        end++;
      }
      const dest = hay.slice(j, end);
      for (const name of KILL_SWITCH_BASENAMES) {
        if (dest.includes(name)) return true;
      }
    }
  }

  // Downloader/decoder destinations: curl -o .deft-directive-disable, scp, … (#3206 / #3213).
  for (const dest of downloaderDecoderDestinations(tokens)) {
    if (pathishMentionsKillSwitch(dest)) return true;
  }

  // Write/destructive + symlink plant + archive/alt-write bins with a kill-switch path
  // argument (#3213 ln/link/mklink; #3245 tar/axel/rclone/socat residual).
  const killWriteBins = new Set([
    ...INDIRECT_WRITE_BINS,
    ...SYMLINK_PLANT_BINS,
    ...ARCHIVE_ALT_WRITE_BINS,
    "touch",
    "new-item",
    "ni",
    "echo",
    "printf",
    "type",
  ]);
  for (let ti = 0; ti < tokens.length; ti++) {
    const binTok = normalizeToken(tokens[ti] as string);
    const bare = binBareName(tokens[ti] as string);
    if (!killWriteBins.has(binTok) && !killWriteBins.has(bare)) continue;
    for (let tj = ti + 1; tj < tokens.length; tj++) {
      const p = pathishToken(tokens[tj] as string);
      if (pathishMentionsKillSwitch(p)) return true;
      // socat OPEN:.deft-directive-disable — path after address prefix (#3245).
      for (const prefix of SOCAT_WRITE_ADDR_PREFIXES) {
        if (p.startsWith(prefix) && pathishMentionsKillSwitch(p.slice(prefix.length))) {
          return true;
        }
      }
    }
  }
  // Bare `touch .deft-directive-disable` / `ln -sf x .deft-directive-disable` — path later.
  for (const t of tokens) {
    const p = pathishToken(t);
    for (const name of KILL_SWITCH_BASENAMES) {
      // Exact basename or ends with /basename
      if (p === name || p.endsWith(`/${name}`)) {
        // Require some write shape (redirect already handled; touch/ni/echo/ln/…)
        if (
          hasWriteShape(command, tokens) ||
          lower.includes("touch") ||
          lower.includes("new-item") ||
          SYMLINK_PLANT_BINS.has(binBareName(tokens[0] as string)) ||
          tokens.some((tok) => SYMLINK_PLANT_BINS.has(binBareName(tok)))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * True when a token is a write-capable language/runtime interpreter (#3186).
 * Matches bare names, versioned bins (`python3.11`), and path-qualified forms
 * (`/usr/bin/python3`, `C:\Python311\python.exe`) — exact Set membership alone
 * would fail-open on absolute/versioned paths (Greptile P1).
 */
function isProgrammaticWriteBinToken(token: string): boolean {
  const t = normalizeToken(token);
  if (t.length === 0) return false;
  // Path-qualified: keep final path segment after / or \ (normalizeToken strips quotes only).
  const pathish = token.replace(/['"]/g, "").toLowerCase().replace(/\\/g, "/");
  const base = pathish.includes("/") ? (pathish.slice(pathish.lastIndexOf("/") + 1) as string) : t;
  const bare = base.endsWith(".exe") ? base.slice(0, -4) : base;

  if (
    bare === "python" ||
    bare === "python3" ||
    bare === "node" ||
    bare === "nodejs" ||
    bare === "perl" ||
    bare === "ruby" ||
    bare === "pwsh" ||
    bare === "powershell"
  ) {
    return true;
  }
  // Versioned: python3.11, python3.12, node18, …
  if (bare.startsWith("python3.") || bare.startsWith("python2.")) return true;
  if (/^python\d+(\.\d+)*$/.test(bare)) return true;
  if (/^node\d+$/.test(bare)) return true;
  return false;
}

/**
 * True when `needle` occurs in `haystack` outside single/double-quoted regions (O(n)).
 * Escaped quotes (`\'` / `\"`) stay inside the string. Used so `print('.write(')` is not
 * a write API while `open(p,'w').write('x')` still matches `.write(` (Greptile conf residual).
 */
function includesOutsideQuotes(haystack: string, needle: string): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < haystack.length; i++) {
    const c = haystack[i] as string;
    if (c === "\\" && i + 1 < haystack.length && (inSingle || inDouble)) {
      i++; // skip escaped char inside quotes
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (haystack.startsWith(needle, i)) return true;
  }
  return false;
}

/**
 * True when command uses a programmatic bin with a **write** API, optionally with
 * path-obfuscation markers (base64/bytes/chr). Pure reads / print-only stay unclassifiable.
 *
 * Chosen rule (#3186): classify write-capable programmatic Shell as **settings** so
 * active UAT fails closed (not shell-op-unclassifiable allow) even when the path is
 * built at runtime without a literal `.deft/authz` substring. Outside UAT, evaluate
 * still returns authz-inactive allow — classification alone is not a hard deny.
 *
 * Read-only `open(...).read()` does **not** count as writeish (Greptile P1).
 * Quoted data containing `.write(` does **not** count (Greptile conf residual).
 * Obfuscation alone without a write API does **not** classify (avoid deny on decode-only).
 */
function hasWriteCapableProgrammaticShell(command: string, tokens: readonly string[]): boolean {
  let hasProg = false;
  for (const t of tokens) {
    if (isProgrammaticWriteBinToken(t)) {
      hasProg = true;
      break;
    }
  }
  if (!hasProg) return false;

  const lower = command.toLowerCase();
  // Shell wrappers put whole scripts in "…" after -c/-e, so long API names (writeFileSync)
  // use full-string includes. Short ambiguous `.write(` uses quote-aware match so
  // `print('.write(')` is not a write API (Greptile conf residual).
  const writeApi =
    lower.includes("writefilesync") ||
    lower.includes("writefile") ||
    lower.includes("writetext") ||
    lower.includes("set-content") ||
    lower.includes("out-file") ||
    lower.includes("fs.write") ||
    lower.includes("createwritestream") ||
    lower.includes("path.write(") ||
    lower.includes("file.write(") ||
    lower.includes("spurt") ||
    lower.includes(">>") ||
    lower.includes("unlink(") ||
    lower.includes("rmsync") ||
    lower.includes("rm_rf") ||
    lower.includes("shutil.rmtree") ||
    lower.includes("os.remove(") ||
    lower.includes("os.unlink(") ||
    lower.includes("fs.unlink") ||
    lower.includes("fs.rm(") ||
    lower.includes("fs.rmsync") ||
    // Short `.write(` only counts outside quotes (avoids print('.write(') false positive).
    // Also match when it appears after a shell -c/-e opening quote as code (common PoC shape):
    // if the command has write mode open or other write API, those already hit above.
    includesOutsideQuotes(lower, ".write(") ||
    // Script body after -c/-e often sits in one double-quoted region: still detect `.write(`
    // as code when paired with an assignment/call shape (f.write / .write(x)).
    (lower.includes(".write(") &&
      (lower.includes("open(") || lower.includes("=open") || lower.includes("fs.")));

  // open(..., 'w' / "w" / 'a' / '>') — mode tokens are quoted; match on full command.
  const openWriteMode =
    lower.includes("open(") &&
    (lower.includes(",'w") ||
      lower.includes(',"w') ||
      lower.includes(", 'w") ||
      lower.includes(', "w') ||
      lower.includes(",'a") ||
      lower.includes(',"a') ||
      lower.includes(", 'a") ||
      lower.includes(', "a') ||
      lower.includes(",'>") ||
      lower.includes(',">') ||
      lower.includes(", '>") ||
      lower.includes(', ">') ||
      lower.includes("mode='w") ||
      lower.includes('mode="w') ||
      lower.includes("mode='a") ||
      lower.includes('mode="a') ||
      lower.includes("mode=w"));

  const writeish = writeApi || openWriteMode;

  // Path construction that hides the destination from literal classifiers.
  const obfuscatedPath =
    lower.includes("base64") ||
    lower.includes("fromcharcode") ||
    lower.includes("bytes([") ||
    lower.includes("bytearray") ||
    lower.includes("buffer.from") ||
    lower.includes("codecs.decode") ||
    lower.includes("unhexlify") ||
    lower.includes("fromhex") ||
    lower.includes("string.fromcharcode") ||
    lower.includes("atob(") ||
    lower.includes("btoa(") ||
    lower.includes("chr(");

  // Fail-closed residual: write-ish programmatic shell (obfuscation alone not enough).
  if (writeish) return true;
  void obfuscatedPath;
  return false;
}

/**
 * Path-ish normalize: keep separators (do not strip `\` like normalizeToken).
 */
function pathishToken(token: string): string {
  return token.replace(/['"]/g, "").toLowerCase().replace(/\\/g, "/");
}

/**
 * True when a pathish string targets `.deft/authz` (after quote strip / slash normalize).
 * Quote-split forms like `'.deft/'authz'/grants/x'` become `.deft/authz/grants/x` via pathishToken.
 */
function pathishIsAuthzDir(pathish: string): boolean {
  return pathish.includes(".deft/authz");
}

/**
 * Shell **write** targeting `.deft/authz/` (#3110 AC-3 / #3206 / #3213).
 * Pure reads (`cat .deft/authz/state.json`) stay unclassifiable — use `authz:show`.
 * Redirects only count when the destination region contains `.deft/authz`.
 * Pathish/token checks run even when the raw command lacks contiguous `.deft/authz`
 * text (quote-split residual: `cp x '.deft/'authz'/grants/y'`).
 */
function hasAuthzDirShellWrite(command: string, tokens: readonly string[]): boolean {
  const lower = command.toLowerCase().replace(/\\/g, "/");
  // Quote-stripped contiguous form for redirect dest checks (#3213).
  const stripped = lower.replace(/['"]/g, "");

  // Redirect dest region after each `>` / `>>` (O(n); no nested-quantifier regex).
  // Check both raw and quote-stripped so quote-split dests still match.
  for (const hay of [lower, stripped]) {
    for (let i = 0; i < hay.length; i++) {
      if (hay[i] !== ">") continue;
      let j = i + 1;
      if (j < hay.length && hay[j] === ">") j++;
      // Dest until pipe/semicolon/ampersand/newline.
      let end = j;
      while (
        end < hay.length &&
        hay[end] !== "|" &&
        hay[end] !== ";" &&
        hay[end] !== "&" &&
        hay[end] !== "\n"
      ) {
        end++;
      }
      if (hay.slice(j, end).includes(".deft/authz")) return true;
    }
  }

  // Write/destructive + symlink plant + archive/alt-write bins with an authz path argument
  // (pathish = quote-strip resistant). Always run — do not gate on contiguous `.deft/authz`
  // in the raw command (#3213 / #3245). SYMLINK_PLANT_BINS: `ln -s forged .deft/authz/grants/x`
  // must not fail-open as unclassifiable (SLizard residual). ARCHIVE_ALT_WRITE_BINS: tar/rclone
  // residual pathish without dest-flag perfection thrash.
  for (let ti = 0; ti < tokens.length; ti++) {
    const bare = binBareName(tokens[ti] as string);
    const n = normalizeToken(tokens[ti] as string);
    if (
      !INDIRECT_WRITE_BINS.has(n) &&
      !INDIRECT_WRITE_BINS.has(bare) &&
      !SYMLINK_PLANT_BINS.has(bare) &&
      !ARCHIVE_ALT_WRITE_BINS.has(bare)
    ) {
      continue;
    }
    for (let tj = ti + 1; tj < tokens.length; tj++) {
      const p = pathishToken(tokens[tj] as string);
      if (pathishIsAuthzDir(p)) return true;
      for (const prefix of SOCAT_WRITE_ADDR_PREFIXES) {
        if (p.startsWith(prefix) && pathishIsAuthzDir(p.slice(prefix.length))) {
          return true;
        }
      }
    }
  }

  // Downloader/decoder destinations under .deft/authz (#3206 / #3213 / #3245 archive+alt).
  for (const dest of downloaderDecoderDestinations(tokens)) {
    if (pathishIsAuthzDir(dest)) return true;
  }
  // Contiguous mention without write shape stays false (reads like cat .deft/authz/…).
  return false;
}

/** Write/destructive shell bins (token match after normalizeToken). */
const INDIRECT_WRITE_BINS = new Set([
  "dd",
  "sed",
  "tee",
  "cp",
  "mv",
  "rsync",
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
  "chmod",
  "chown",
  "install",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "pwsh",
  "powershell",
  "set-content",
  "out-file",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "ri",
  "ni",
  "sc",
  "mi",
]);

/**
 * O(n): true when command expands `$…` / `` `…` `` / `%VAR%`
 * (no nested-quantifier regex). Includes command substitution and positional `$1`.
 */
function hasEnvExpansion(command: string): boolean {
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "`") return true;
    if (c === "$" && i + 1 < command.length) {
      const n = command[i + 1] as string;
      // $VAR / ${VAR} / $(cmd) / $1 / $@ / $* / $? / $'…' (ANSI-C)
      if (
        n === "{" ||
        n === "(" ||
        n === "_" ||
        n === "'" ||
        n === "@" ||
        n === "*" ||
        n === "?" ||
        n === "#" ||
        n === "!" ||
        (n >= "0" && n <= "9") ||
        (n >= "A" && n <= "Z") ||
        (n >= "a" && n <= "z")
      ) {
        return true;
      }
    }
    if (c === "%" && i + 1 < command.length) {
      const n = command[i + 1] as string;
      if (n === "_" || (n >= "A" && n <= "Z") || (n >= "a" && n <= "z")) {
        return true;
      }
    }
  }
  return false;
}

function hasWriteShape(command: string, tokens: readonly string[]): boolean {
  if (command.includes(">")) return true;
  for (const t of tokens) {
    const bare = binBareName(t);
    if (INDIRECT_WRITE_BINS.has(normalizeToken(t)) || INDIRECT_WRITE_BINS.has(bare)) return true;
    // #3245: archive extractors / alt downloaders are write-shaped (defense-in-depth for
    // unclassifiable plant paths under UAT — not bare curl $URL which stays non-write-shaped).
    if (ARCHIVE_ALT_WRITE_BINS.has(bare)) return true;
  }
  return false;
}
/**
 * Split-path containment: `.deft` and `authz` both appear (e.g. `cd .deft && … authz/…`).
 * O(n) substring checks — no nested-quantifier regex.
 */
function hasSplitAuthzPath(command: string): boolean {
  const lower = command.toLowerCase().replace(/\\/g, "/");
  if (!lower.includes("authz")) return false;
  return lower.includes(".deft") || lower.includes("/deft/") || lower.includes("deft/");
}

/**
 * Last non-flag token is a pure expansion dest (`$STORE`, `${STORE}`, `%TEMP%`)
 * with no trailing path segment (`$HOME/out` is NOT pure — ordinary user write).
 */
function lastTokenIsOpaqueExpansion(tokens: readonly string[]): boolean {
  let last = "";
  for (const t of tokens) {
    if (t.startsWith("-")) continue;
    last = t;
  }
  if (last.length === 0) return false;
  const n = last.replace(/['"]/g, "");
  // Path after expansion → ordinary dest, not opaque store alias.
  if (n.includes("/") || n.includes("\\")) return false;
  if (n.startsWith("$") && n.length > 1) return true;
  if (n.startsWith("%") && n.endsWith("%") && n.length > 2) return true;
  return false;
}

/** Env / path tokens that are ordinary non-store destinations (not authz containment). */
const ORDINARY_EXPANSION_PREFIXES = [
  "home",
  "tmpdir",
  "temp",
  "tmp",
  "pwd",
  "user",
  "username",
  "userprofile",
  "xdg_",
  "path",
  "psmodulepath",
  "appdata",
  "localappdata",
  "programfiles",
  "systemroot",
  "windir",
  "shell",
  "term",
  "color",
  "lang",
  "lc_",
  "editor",
  "visual",
  "pager",
  "browser",
  "http",
  "https",
  "proxy",
  "npm_",
  "pnpm_",
  "yarn_",
  "node_",
  "python",
  "virtual_env",
  "conda",
  "cargo",
  "go",
  "java",
  "ssh",
  "gpg",
  "git_",
  "gh_",
  "github_",
  "ci",
  "tf_",
  "aws_",
  "azure",
  "gcloud",
];

/**
 * True when the expansion name itself suggests authz / grant store
 * (e.g. $AUTHZ_DIR, $DEFT_AUTHZ_ROOT, %GRANT_STORE%) — residual path without keywords.
 */
function hasAuthzPlausibleExpansionName(command: string): boolean {
  const lower = command.toLowerCase();
  // O(n) scan for $NAME / ${NAME} / %NAME% containing authz/grant/store store-ish tokens.
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i];
    if (c === "$" && i + 1 < lower.length) {
      let j = i + 1;
      if (lower[j] === "{" || lower[j] === "(") j++;
      let name = "";
      while (j < lower.length) {
        const ch = lower[j] as string;
        if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_") {
          name += ch;
          j++;
          continue;
        }
        break;
      }
      if (nameLooksAuthzStore(name)) return true;
    }
    if (c === "%" && i + 1 < lower.length) {
      let j = i + 1;
      let name = "";
      while (j < lower.length && lower[j] !== "%") {
        const ch = lower[j] as string;
        if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_") {
          name += ch;
          j++;
          continue;
        }
        break;
      }
      if (nameLooksAuthzStore(name)) return true;
    }
  }
  return false;
}

function nameLooksAuthzStore(name: string): boolean {
  if (name.length === 0) return false;
  if (
    name.includes("authz") ||
    name.includes("grant") ||
    name === "store" ||
    name.endsWith("_store") ||
    name.startsWith("store_") ||
    name.includes("deft_auth") ||
    name.includes("auth_store")
  ) {
    // Exclude ordinary false friends if any appear later.
    return true;
  }
  return false;
}

/**
 * Programmatic env write to store: python/node open(os.environ[...]) / process.env patterns
 * that lack shell `$` expansion but still hit authz paths (#3110 residual).
 */
function hasProgrammaticAuthzEnvWrite(command: string, tokens: readonly string[]): boolean {
  const lower = command.toLowerCase();
  let hasProg = false;
  for (const t of tokens) {
    const n = normalizeToken(t);
    if (
      n === "python" ||
      n === "python3" ||
      n === "node" ||
      n === "nodejs" ||
      n === "perl" ||
      n === "ruby" ||
      n === "pwsh" ||
      n === "powershell"
    ) {
      hasProg = true;
      break;
    }
  }
  if (!hasProg) return false;
  // Must look like a write (open/write/writefile/set-content) not a pure read.
  const writeish =
    lower.includes("open(") ||
    lower.includes(".write") ||
    lower.includes("writefile") ||
    lower.includes("writetext") ||
    lower.includes("set-content") ||
    lower.includes("out-file") ||
    lower.includes("fs.write") ||
    lower.includes("createwritestream") ||
    lower.includes(">>") ||
    lower.includes("mode='w'") ||
    lower.includes('mode="w"') ||
    lower.includes(",'w'") ||
    lower.includes(',"w"');
  if (!writeish) return false;
  // Authz-store target only — bare `state.json` alone is ordinary app state (#3110 residual).
  if (
    lower.includes("authz") ||
    lower.includes("/grants/") ||
    lower.includes("grant-") ||
    lower.includes("deft_auth") ||
    lower.includes("auth_store") ||
    lower.includes(".deft/authz") ||
    lower.includes(".deft\\authz")
  ) {
    return true;
  }
  // os.environ / process.env + authz-store-ish key (not generic "auth"/"store" alone).
  if (
    lower.includes("os.environ") ||
    lower.includes("process.env") ||
    lower.includes("$env:") ||
    lower.includes("getenv")
  ) {
    if (
      lower.includes("authz") ||
      lower.includes("grant") ||
      lower.includes("deft_auth") ||
      lower.includes("auth_store")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Indirect shell FS mutation that can plausibly hit the authz store (#3110).
 * Narrower than "any write + any expansion" (avoids denying `echo > $HOME/out` under UAT)
 * but still catches opaque `$STORE` dest, `rm -rf $STORE`, authz-named expansions,
 * and programmatic os.environ writes. Does **not** flag ordinary cleanup `rm $TMP/x`.
 * O(n) walks — no polynomial regex on input.
 */
function hasIndirectAuthzStoreWrite(command: string, tokens: readonly string[]): boolean {
  if (hasProgrammaticAuthzEnvWrite(command, tokens)) return true;
  if (!hasWriteShape(command, tokens)) return false;
  const lower = command.toLowerCase().replace(/\\/g, "/");
  // Authz-plausible destination text (literal or expanded path segments).
  // Bare `state.json` alone is ordinary app state — require authz/grants/.deft context
  // (Greptile residual: do not deny unrelated expanded state-file writes under UAT).
  if (
    lower.includes("authz") ||
    lower.includes("/grants/") ||
    lower.includes("grant-") ||
    lower.includes(".deft/authz") ||
    (lower.includes("state.json") &&
      (lower.includes("authz") ||
        lower.includes(".deft") ||
        lower.includes("/grants/") ||
        hasAuthzPlausibleExpansionName(command)))
  ) {
    // Require write shape already true; still need expansion OR already handled by literal path.
    // When expansion is absent, hasAuthzDirShellWrite covers literals; here catch expanded.
    if (hasEnvExpansion(command) || hasAuthzPlausibleExpansionName(command)) return true;
  }
  if (!hasEnvExpansion(command)) return false;
  // Expansion var **name** suggests store (e.g. $AUTHZ_DIR without "authz" path text after).
  if (hasAuthzPlausibleExpansionName(command)) return true;
  // Destructive bins: only pure-opaque dest or authz-named expansion — not `rm $TMP/build`.
  let destructive = false;
  for (const t of tokens) {
    const n = normalizeToken(t);
    if (
      n === "rm" ||
      n === "rmdir" ||
      n === "unlink" ||
      n === "shred" ||
      n === "remove-item" ||
      n === "ri"
    ) {
      destructive = true;
      break;
    }
  }
  if (destructive && lastTokenIsOpaqueExpansion(tokens)) return true;
  // cp/mv/tee/redirect dest is only `$VAR` / `%VAR%` (opaque absolute store path).
  // Skip ordinary well-known env prefixes ($HOME, $TMPDIR, …).
  if (lastTokenIsOpaqueExpansion(tokens)) {
    const last = [...tokens].reverse().find((t) => !t.startsWith("-")) ?? "";
    const bare = last.replace(/['"%${}]/g, "").toLowerCase();
    if (!ORDINARY_EXPANSION_PREFIXES.some((p) => bare === p || bare.startsWith(p))) {
      return true;
    }
  }
  return false;
}

/** Best-effort shell classification for UAT-sensitive ops beyond push/merge. */
export function classifyShellAuthzOps(command: string): AuthzClassifiedOp[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [];

  const found = new Set<AuthzClassifiedOp>();
  for (const op of listShellOps(cmd)) {
    found.add(op);
  }

  const tokens = shellTokens(cmd);
  const gh = findGhResourceVerb(tokens);
  if (gh !== null) {
    if (
      gh.resource === "pr" &&
      (gh.verb === "create" || gh.verb === "edit" || gh.verb === "ready" || gh.verb === "reopen")
    ) {
      found.add("pr");
    }
    // Surface merge when listShellOps misses global flags like --repo (#2711 compose).
    if (gh.resource === "pr" && gh.verb === "merge") {
      found.add("merge");
    }
    if (gh.resource === "issue" && gh.verb === "create") {
      found.add("issue_mutation");
    }
    if (gh.resource === "repo" && gh.verb === "edit") {
      found.add("settings");
    }
  }
  if (hasGhApiPath(tokens, "/issues")) found.add("issue_mutation");
  if (hasGhApiPath(tokens, "/settings")) found.add("settings");
  if (hasTestRunner(tokens)) found.add("test");
  if (hasDeploy(tokens)) found.add("deployment");
  // #3110: authz authority CLI + store **writes** (literal / split / $VAR / rm) → settings.
  if (hasAuthzMutatingCli(tokens)) found.add("settings");
  if (hasAuthzDirShellWrite(cmd, tokens)) found.add("settings");
  // #3186: kill-switch plant + policy authority mutators → settings (UAT fail-closed).
  if (hasKillSwitchShellWrite(cmd, tokens)) found.add("settings");
  if (hasPolicyAuthorityMutator(tokens)) found.add("settings");
  // Split path write: `cd .deft && echo x > authz/state.json` OR `cd .deft/authz && echo x > state.json`
  // OR `cd .deft/authz && cp … grants/x` (write bin without redirect).
  // When the command cds into an authz path, any write shape is settings (relative dest has no "authz" text).
  {
    let cdsIntoAuthz = false;
    for (let ti = 0; ti < tokens.length - 1; ti++) {
      const bin = normalizeToken(tokens[ti] as string);
      if (bin !== "cd" && bin !== "pushd" && bin !== "set-location" && bin !== "sl") continue;
      const dest = pathishToken(tokens[ti + 1] as string);
      if (dest.includes("authz")) {
        cdsIntoAuthz = true;
        break;
      }
    }
    if (cdsIntoAuthz && hasWriteShape(cmd, tokens)) {
      found.add("settings");
    } else if (hasSplitAuthzPath(cmd) && cmd.includes(">")) {
      // Scan every `>` region — not only the last — so a later `> /tmp/x` cannot hide an earlier store write.
      const lower = cmd.toLowerCase().replace(/\\/g, "/");
      for (let i = 0; i < lower.length; i++) {
        if (lower[i] !== ">") continue;
        let j = i + 1;
        if (j < lower.length && lower[j] === ">") j++;
        let end = j;
        while (
          end < lower.length &&
          lower[end] !== "|" &&
          lower[end] !== ";" &&
          lower[end] !== "&" &&
          lower[end] !== "\n"
        ) {
          end++;
        }
        if (lower.slice(j, end).includes("authz")) {
          found.add("settings");
          break;
        }
      }
    }
  }
  if (hasIndirectAuthzStoreWrite(cmd, tokens)) found.add("settings");
  // #3186: programmatic write/obfuscated-path shells fail closed as settings (not unclassifiable allow).
  // Always merge settings even when other ops already matched (e.g. `pytest && python -c '…write…'`)
  // so a compound safe prefix cannot hide a write-capable residual (SLizard residual).
  if (hasWriteCapableProgrammaticShell(cmd, tokens)) {
    found.add("settings");
  }

  return [...found];
}

/** Map a PreToolUse tool name + optional shell command to authz ops. */
export function classifyHookAuthzOps(input: {
  readonly toolName: string;
  readonly shellCommand: string | null;
  readonly isDirectWrite: boolean;
  readonly mcpArgsText?: string | null;
}): AuthzClassifiedOp[] {
  const { toolName, shellCommand, isDirectWrite } = input;
  if (isDirectWrite) return ["edit"];

  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower === "run_terminal_cmd") {
    // Missing command string: fail open (host gap) — same posture as #2711.
    if (shellCommand === null) return [];
    // Empty classification (git status, tests without product verbs, …) is not gated.
    return classifyShellAuthzOps(shellCommand);
  }

  // MCP / bare names via #2711 classifier + PR heuristics (token-ish name checks).
  const mcpOp: RuntimeAuthorityShellOp | null = classifyMcpTool(
    toolName,
    input.mcpArgsText ?? null,
  );
  if (mcpOp !== null) return [mcpOp];

  const name = lower.replace(/[^a-z0-9_]/g, "_");
  if (
    name.includes("create_pull_request") ||
    name.includes("pull_request_create") ||
    name.includes("pr_create") ||
    name === "create_pull_request"
  ) {
    return ["pr"];
  }
  if (name.includes("create_issue") || name.includes("issue_create")) {
    return ["issue_mutation"];
  }

  // Unrelated tools — not gated by Wave 1 authz (prefer fail-open over false deny).
  return [];
}

/** Re-export #2711 classifiers for composition docs/tests. */
export { classifyMcpTool, classifyShellCommand, listShellOps };
