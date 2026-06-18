/**
 * Encoding-gate constants, ported verbatim from the Python oracle
 * (`scripts/verify_encoding.py`, #798) so the TS port golden-diffs clean
 * against it. Any change here MUST be mirrored in the Python source and
 * re-validated through the parity harness (#1718).
 */

/**
 * Codepoint sequences that signal a Windows codepage round-trip corruption,
 * mapped to a short label naming the canonical codepoint that was corrupted.
 * Order matches the Python `MOJIBAKE_PATTERNS` dict.
 */
export const MOJIBAKE_PATTERNS: ReadonlyMap<string, string> = new Map([
  // CP437-as-UTF-8 (Windows DOS codepage; recurrence record PR #844 / fix #846).
  ["Γèù", "U+2297 (⊗) corrupted via cp437 read"],
  ["Γ£ô", "U+2713 (✓) corrupted via cp437 read"],
  ["ΓÇª", "U+2026 (…) corrupted via cp437 read"],
  ["ΓÇö", "U+2014 (—) corrupted via cp437 read"],
  ["ΓÇô", "U+2013 (–) corrupted via cp437 read"],
  ["ΓÇó", "U+2022 (•) corrupted via cp437 read"],
  ["ΓÇÖ", "U+2019 (’) corrupted via cp437 read"],
  ["ΓÇÿ", "U+2018 (‘) corrupted via cp437 read"],
  ["ΓÇ£", "U+201C (“) corrupted via cp437 read"],
  ["ΓÇØ", "U+201D (”) corrupted via cp437 read"],
  ["ΓåÆ", "U+2192 (→) corrupted via cp437 read"],
  // CP1252-as-UTF-8 (Windows ANSI codepage; recurrence record #236, #240, #283, PR #795).
  ["â€™", "U+2019 (’) corrupted via cp1252 read"],
  ["â€˜", "U+2018 (‘) corrupted via cp1252 read"],
  ["â€œ", "U+201C (“) corrupted via cp1252 read"],
  ["â€\x9d", "U+201D (”) corrupted via cp1252 read"],
  ["â€“", "U+2013 (–) corrupted via cp1252 read"],
  ["â€”", "U+2014 (—) corrupted via cp1252 read"],
  ["â€¦", "U+2026 (…) corrupted via cp1252 read"],
  ["â€¢", "U+2022 (•) corrupted via cp1252 read"],
  ["â†’", "U+2192 (→) corrupted via cp1252 read"],
  ["Â§", "U+00A7 (§) corrupted via cp1252 read"],
  ["Â°", "U+00B0 (°) corrupted via cp1252 read"],
  ["Â´", "U+00B4 (´) corrupted via cp1252 read"],
  ["Â\xad", "U+00AD (soft hyphen) corrupted via cp1252 read"],
  ["Â©", "U+00A9 (©) corrupted via cp1252 read"],
  ["Â®", "U+00AE (®) corrupted via cp1252 read"],
  ["Â±", "U+00B1 (±) corrupted via cp1252 read"],
]);

/** U+FFFD REPLACEMENT CHARACTER — the universal mojibake marker. */
export const REPLACEMENT_CHAR = "\ufffd";

/** UTF-8 BOM byte sequence (EF BB BF). */
export const UTF8_BOM: ReadonlyArray<number> = [0xef, 0xbb, 0xbf];

/** Extensions where a leading UTF-8 BOM is non-canonical and should be flagged. */
export const NO_BOM_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".txt",
]);

/** Control characters that must not hide inside decoded vBRIEF narratives. */
export const VBRIEF_CONTROL_CHAR_LABELS: ReadonlyMap<string, string> = new Map([
  ["\b", "U+0008 backspace in vBRIEF narrative"],
  ["\t", "U+0009 tab in vBRIEF narrative"],
  ["\v", "U+000B vertical tab in vBRIEF narrative"],
  ["\f", "U+000C form feed in vBRIEF narrative"],
]);

/** File extensions to scan by default (conservative; excludes binary). */
export const SCANNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".txt",
  ".py",
  ".sh",
  ".ps1",
  ".toml",
  ".cfg",
]);

/**
 * Path-glob patterns auto-skipped because the file legitimately contains
 * mojibake byte sequences as part of its purpose. Matched against the path's
 * POSIX form. Ported verbatim from the Python `BUILTIN_ALLOW_LIST`.
 */
export const BUILTIN_ALLOW_LIST: ReadonlyArray<string> = [
  "vbrief/active/*-798-*.vbrief.json",
  "vbrief/completed/*-798-*.vbrief.json",
  "vbrief/cancelled/*-798-*.vbrief.json",
  "vbrief/pending/*-798-*.vbrief.json",
  "vbrief/proposed/*-798-*.vbrief.json",
  ".deft/core/vbrief/active/*-798-*.vbrief.json",
  ".deft/core/vbrief/completed/*-798-*.vbrief.json",
  ".deft/core/vbrief/cancelled/*-798-*.vbrief.json",
  ".deft/core/vbrief/pending/*-798-*.vbrief.json",
  ".deft/core/vbrief/proposed/*-798-*.vbrief.json",
  "deft/vbrief/active/*-798-*.vbrief.json",
  "deft/vbrief/completed/*-798-*.vbrief.json",
  "deft/vbrief/cancelled/*-798-*.vbrief.json",
  "deft/vbrief/pending/*-798-*.vbrief.json",
  "deft/vbrief/proposed/*-798-*.vbrief.json",
  "history/archive/**",
  "history/archive/**/*",
  ".deft/core/history/archive/**",
  ".deft/core/history/archive/**/*",
  "deft/history/archive/**",
  "deft/history/archive/**/*",
  "scripts/verify_encoding.py",
  "tests/cli/test_verify_encoding.py",
  ".deft/core/scripts/verify_encoding.py",
  ".deft/core/tests/cli/test_verify_encoding.py",
  "deft/scripts/verify_encoding.py",
  "deft/tests/cli/test_verify_encoding.py",
];
