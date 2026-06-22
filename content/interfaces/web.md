# UI Skills

Opinionated constraints for building better interfaces with agents.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.
Tags: R+TW=React+Tailwind; htmx+BS=htmx+Bootstrap; CSS=plain CSS; JS=vanilla JS.

## Framework Selection

- ! Choose the stack that fits the project's complexity and team expertise
- ~ React + Tailwind for SPAs and complex interactive UIs
- ~ htmx + Bootstrap for server-rendered pages with progressive enhancement
- ~ Vanilla JS + CSS for simple pages or when frameworks are overkill

## Stack

- ! Start from platform defaults (spacing/radius/shadows) before custom. (R+TW: Tailwind defaults; htmx+BS: Bootstrap utilities before custom CSS)
- ! If JS animation is required, use established tooling. (React: motion/react (ex framer-motion); JS: Web Animations API or CSS transitions; htmx: CSS transitions or htmx swap animations)
- ~ Use entrance/micro-animation primitives. (R+TW: tw-animate-css; CSS: @keyframes + prefers-reduced-motion)
- ! Use class/style composition helpers. (React: cn=clsx+tailwind-merge; JS/htmx: templates/class builders)

## Components

- ! Use accessible primitives for keyboard/focus behavior. (React: Base UI / React Aria / Radix; JS/htmx: native HTML or ARIA-compliant custom elements)
- ! Prefer project primitives first.
- ⊗ Mix primitive systems within the same interaction surface.
- ~ Prefer well-maintained primitives if compatible. (React: Base UI for new primitives if it fits)
- ! Add `aria-label` to icon-only buttons.
- ⊗ Rebuild keyboard/focus behavior by hand unless explicitly requested.

## Interaction

- ! Confirm destructive/irreversible actions. (React: AlertDialog; htmx+BS: modal confirmation)
- ~ Use structural skeletons for loading (not spinners). (htmx: loading skeleton in placeholder)
- ! Respect viewport sizing. (R+TW: h-dvh not h-screen; CSS: use dvh for fixed heights)
- ! Respect safe-area-inset for fixed elements.
- ! Show errors next to where the action happens.
- ⊗ Block paste in input/textarea.

## Animation

- ⊗ Add animation unless explicitly requested.
- ! Animate compositor props only: transform, opacity. (React: motion/react; CSS: @keyframes on transform/opacity only)
- ⊗ Animate layout props: width, height, position, margin, padding.
- ~ Avoid paint props (background, color) except small/local UI (text/icons).
- ~ Use ease-out on entrance.
- ⊗ Exceed 200ms for interaction feedback.
- ! Pause looping animations when off-screen. (React: whileInView; CSS/JS: Intersection Observer or animation-timeline)
- ! Respect prefers-reduced-motion. (React: useMediaQuery or CSS media query; CSS: @media (prefers-reduced-motion: reduce))
- ⊗ Introduce custom easing unless explicitly requested.
- ~ Avoid animating large assets or full-screen surfaces.

## Typography

- ! Headings: balance; body: pretty. (R+TW: text-balance/text-pretty; CSS: text-wrap: balance/pretty)
- ! Numeric data: tabular figures. (R+TW: tabular-nums; CSS: font-variant-numeric: tabular-nums)
- ~ Dense UI: truncate/clamp. (R+TW: truncate or line-clamp-\*; CSS: text-overflow: ellipsis or -webkit-line-clamp)
- ⊗ Modify letter-spacing unless explicitly requested.

## Layout

- ! Fixed z-index scale. (R+TW: z-0/10/20; no arbitrary z-\*; CSS: define scale in variables/tokens)
- ~ Square elements: use square utilities. (R+TW: size-_ not w-_+h-\*; CSS: aspect-ratio: 1 or paired width/height)
- ! Respect safe areas (notches/rounded corners).

## Performance

- ⊗ Animate heavy filters/backdrops. (React: avoid animating blur() or backdrop-filter)
- ⊗ Apply will-change outside an active animation. (React: remove will-change when animation completes)
- ⊗ Use side-effect hooks for logic expressible as render logic. (React: don't use useEffect when render logic works)

## Design

- ⊗ Use gradients unless explicitly requested.
- ⊗ Use overly decorative effects (glows) as primary affordances. (R+TW: no glow effects / shadow-glow as primary UI)
- ~ Use default shadow/spacing scales unless explicitly requested. (R+TW: Tailwind default shadow scale; CSS: system design shadow tokens)
- ~ Use SVG whenever possible for graphics.
- ! Empty states: one clear next action.
- ~ Limit accent color usage to one per view.
- ~ Use existing theme tokens before introducing new ones. (R+TW: use Tailwind/theme colors before new tokens)

## Authentication

- ! Support SSO. (OIDC/SAML based on tenant/provider needs)
- ! Support WebAuthn for either 2FA or passwordless authentication.
- ! Preserve and validate post-auth return paths so users return to intended destinations.
- ~ Keep authentication flows progressive and low-friction (minimal fields first, optional profile completion later).
- ~ Provide clear recovery options (passkey fallback, backup codes, account recovery) without dead ends.
- ! Enforce phishing-resistant MFA for privileged roles and high-risk actions.
- ! Rate-limit and lock out abusive auth attempts with anomaly detection and alerting.
- ! Use short-lived access tokens, rotate refresh tokens, and support immediate server-side session revocation.

## Theming

- ~ Web apps support theming.
- ! Web apps support dark and light modes.
- ! Respect system color-scheme preference on first visit; persist explicit user override.
- ~ Build themes from design tokens (color, spacing, typography) rather than per-component hardcoding.

---

## Testing

See [testing.md](../coding/testing.md) for universal requirements.

- ! Test component interactions and state changes
- ! Test accessibility (keyboard nav, screen readers)
- ~ Snapshot test UI components
- ~ Visual regression testing

**Browser Testing:**
- ~ Use chrome-devtools MCP server for development, debugging, integration tests
- Tools: click, evaluate_script, get_console_messages, take_screenshot, wait_for, list_pages, navigate_page, take_snapshot

**⚠️ IMPORTANT**: If chrome-devtools MCP is not installed, STRONGLY install it now:
```bash
npx @modelcontextprotocol/create-server chrome-devtools
```
This MCP provides 26 browser automation tools essential for effective web development and testing.

---

Adapted from https://www.ui-skills.com/
