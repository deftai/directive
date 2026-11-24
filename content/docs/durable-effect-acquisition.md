# Durable-effect acquisition (`verify:durable-effect-acquisition`)

Refs: #5080 · [Accepted design amendment](https://github.com/deftai/directive/issues/5080#issuecomment-5873701590) · [Consumer check contract](./consumer-check-contract.md)

Under a presentation ceiling, this gate detects newly acquired storage, cookie, non-GET network, non-admitted-origin network, and markup submission capabilities in changed `.html`, `.jsx`, and `.tsx` files. It compares the checked snapshot with merge-base. Same-origin GET, in-memory state, and standalone CSS are outside this gate's warrant. A pass establishes the bounded static policy below; it does not establish general behavioral equivalence.

## Ceiling records and authority

The gate recognizes the #5056 public shapes: `.deft/presentation-ceiling.json`, other repository files named `presentation-ceiling.json`, and `xbrief/{active,pending,proposed}/*.xbrief.json`. An xBRIEF can put `"presentation"` or a `{ "changeClass": "presentation" }` object at `plan["x-directive/changeClass"]` or `plan.metadata["x-directive/changeClass"]`. Every discovered restriction applies. Grants are intersected across restrictions, so a permissive record cannot override a restrictive one.

Merge-base restrictions survive deletion or weakening at head. New restrictions arm immediately, with no head-only grants. Changing an existing record's amendment fields in the same PR refuses. Missing records are distinct from malformed records or failed snapshot reads. The decoder follows #5056's public shapes as of its development commit `9d0455b8b`; this PR does not claim that the separate #5056 evaluator is integrated.

An amendment belongs inside its ceiling object and requires a typed human approval present at merge-base. The enclosing object binds the approval to its grants. A bare `humanOrigin` boolean never grants authority. This approval is presentation-ceiling amendment authority only; it is not an observable-scope or intent-constraint declaration (`scope:record-observable-scope` / `scope:record-intent-constraint` write `kind: "declared"` from any shell under #7031 and do not mint durable-effect grants).

```json
{
  "schema": "deft.presentation-ceiling.v1",
  "changeClass": "presentation",
  "admittedOrigins": ["https://example.com"],
  "admittedPackages": ["clsx"],
  "admittedGlobals": [{ "name": "approvedReader", "members": ["read"] }],
  "admittedPaths": ["src/approved-helper.ts"],
  "humanApproval": {
    "kind": "human",
    "actor": "David",
    "mintedAt": "2026-09-28T00:00:00Z",
    "mintedVia": "operator-tty"
  }
}
```

Origins are exact serialized origins, without paths or opaque `null` origins. Packages are exact import specifiers. Globals name an identifier and an explicit member list; an empty list permits no members. Paths are exact repository-relative paths with `/` separators and no `.` or `..` segments. They admit the named source file and imports that resolve to that exact path; relative imports resolve from their authoring file. Malformed amendment fields and unsupported fields refuse. #5056 extension/root metadata remains owned by that sibling gate and does not widen this gate's three file types.

## Snapshot and occurrence rules

Local checks read live working-tree bytes, including staged content unless superseded by another live edit. CI checks read the committed checkout in its working tree. Deletion is absence: neither the index nor HEAD resurrects a missing file. Git and I/O errors return a named configuration failure. The base snapshot is the resolved merge-base tree. Additions, deletions, edits, and renames use the same rules.

Acquisition facts preserve multiplicity and normalized source, arguments, receiver, and immutable dependencies. Adding a duplicate or changing a POST target refuses. Offsets do not identify facts, so comments, whitespace, and unrelated text inserted above an existing site do not make it new. HTML unions both scripting parse modes using the greater occurrence count per fact. Cross-file moves remain conservative and can appear as new acquisitions.

Inline CSS facts identify individual modeled fetch constructs and import statements, including their arguments and rule/property context. Unrelated declarations and outside comments/spacing do not change an existing occurrence. URL and quoted-string contents retain their bytes and case; equivalent quote delimiters normalize. HTML and JSX style attributes, style objects, and style elements share this bounded analysis. Escaped or unresolved CSS retains a conservative refusal; this is not a general CSS equivalence check.

## Supported static language

Every executable expression is analyzed, including JSX children, inert attributes, handlers, computed accesses, defaults, nested functions, and initializers. TypeScript lexical symbols separate shadowed bindings. Immutable aliases resolve with cycle detection; reassignment and mutations through aliases invalidate static provenance. Unknown globals, dynamic imports, reflection, unresolved receivers, and unsupported constructions refuse. Effect-free globals have explicit member allowlists. DOM/window/ref capabilities are conservative refusals. Declaring a local function does not exempt its body.

Whole-value parameter/member forwarding retains supplying-edge ownership. Invoking an unresolved supplied callable, constructor, or template tag refuses; forwarding its value does not invoke it. Defaults and in-class component suppliers are checked. Fetch permits a completely resolved same-origin GET and honors the last `method` property, including supported computed names and immutable options. Unresolved options, spreads, keys, or getters refuse. Unsupported callback escape of the fetch capability refuses. XHR and WebSocket acquisition is conservative, including XHR GET construction.

JavaScript string literals use JavaScript decoding. Quoted JSX attribute strings use TypeScript's JSX emitter decoding. Static templates assemble the complete value before URL classification. Known single-URL sinks can use a pinned path prefix with safe identity/member interpolation. URL lists and unknown component consumers require a complete static value or whole-value forwarding. Thus splitting `https://collector.example/p` across otherwise harmless template fragments still refuses.

## Markup rules and disclosed costs

Known native inert attributes such as title, alt, class/className, and ordinary ARIA text are exempt from URL-value analysis. Their expressions still execute and remain checked. Unknown attributes, namespaces, custom elements, and component props stay conservative; harmless numeric/boolean scalar values pass. Known single-URL sinks use the whole value. Lists and unknown consumers check the whole value plus whitespace/comma candidates against WHATWG URL parsing at `https://deft.invalid/`.

Both HTML scripting modes, template contents, and namespaces are covered. Inline scripts, handlers, style attributes, and JSX script/style children are checked. CSS escapes and fetch functions refuse. Non-GET forms, submitter overrides, `ping`, `srcdoc`, embedded documents, and non-benign meta directives refuse. A non-sentinel or unresolved document base in either snapshot refuses independently of acquisition deltas; a statically same-origin base passes.

This deliberately rejects some safe programs: arbitrary derived URL expressions, unknown string/object consumers, dynamic style values, unknown global/member APIs, escaped CSS, and unsupported provenance. `mailto:` and `tel:` are not request-capable schemes. Request-capable values with opaque (`null`) or non-admitted external origins refuse, including `data:` and `javascript:`. A `blob:` URL follows its parsed origin; a same-origin blob retains the in-memory exclusion. Absolute own-domain links require an admitted origin.

## Invocation

`deft verify:durable-effect-acquisition` is composed on framework and consumer `deft check`. Exit `0` means off-ceiling or pass, `1` means refused, and `2` means configuration or snapshot failure. Under an armed ceiling, skipped/N/A is not an exit. Same-PR changes to an existing durable-effect verifier refuse.
