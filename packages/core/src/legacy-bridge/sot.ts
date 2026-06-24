/**
 * sot.ts -- Tier-0 single source of truth for the frozen final Go-installer
 * version, the legacy stage-1 bridge (#1912).
 *
 * SEMANTICS: null-until-frozen.
 *
 *   - TODAY (and on every branch until the operator cuts the final Go
 *     installer) `LAST_GO_INSTALLER` is `null`. `isFrozen()` returns `false`.
 *     The freeze gate (`verify:go-freeze`) is advisory-only in this state --
 *     Go-installer development is still allowed up to the cut.
 *   - AT FREEZE TIME the OPERATOR pins the value here -- and ONLY here -- to the
 *     exact tag of the final published Go installer (e.g. `"v0.32.5"`). From
 *     that point `isFrozen()` is `true`, the freeze gate enforces the line, and
 *     every other surface that documents or consumes the bridge version reads
 *     this module instead of hardcoding a number.
 *
 * This module is the ONE place the bridge version is allowed to live as a
 * literal. Every other surface (UPGRADING.md two-step wording, the `deft doctor`
 * legacy-layout signpost, the pinned legacy-bridge e2e) MUST reference the SoT
 * rather than restate the number -- the cross-surface drift gate
 * (`verify:bridge-drift`) enforces that via the sentinel marker below.
 *
 * SENTINEL MARKER (cross-surface drift contract, #1912): any surface that
 * STATES the frozen bridge version carries the marker token
 * `deft:last-go-installer` on the stating line. `verify:bridge-drift` asserts no
 * marked line outside this module hardcodes a Go-installer semver -- the value
 * must come from `lastGoInstaller()` / `LAST_GO_INSTALLER`. This module is the
 * sole exemption: it is where the literal legitimately lives.
 *
 * deft:last-go-installer -- anchor; the value is the constant below, never an
 * inline number on this comment line.
 */

/**
 * The frozen final Go-installer tag, or `null` while unfrozen.
 *
 * OPERATOR FREEZE STEP: set this to the published tag string (e.g. `"v0.32.5"`)
 * at freeze time. Leave it `null` otherwise. This is the only edit required to
 * pin the bridge version; the freeze + drift gates pick it up automatically.
 */
export const LAST_GO_INSTALLER: string | null = null;

/** Returns the frozen final Go-installer tag, or `null` while unfrozen. */
export function lastGoInstaller(): string | null {
  return LAST_GO_INSTALLER;
}

/** Returns `true` once the final Go installer has been frozen (SoT pinned). */
export function isFrozen(): boolean {
  return LAST_GO_INSTALLER !== null;
}
