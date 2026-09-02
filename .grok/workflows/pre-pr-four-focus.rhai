let meta = #{
    name: "pre-pr-four-focus",
    description: "Four-focus pre-PR review: A acceptance+tests, B bug hunt, C stealth/secrets/log leaks, D regression+extra scope",
    when_to_use: "Before pushing a branch for PR creation, after local commits exist",
    phases: [
        #{ title: "Collect", detail: "resolve merge-base" },
        #{ title: "Focus", detail: "four read-only specialists in parallel" },
        #{ title: "Synthesize", detail: "merge evidenced findings" },
    ],
};

let base_schema = #{
    "type": "object",
    "required": ["merge_base"],
    "properties": #{
        "merge_base": #{ "type": "string" },
    },
};

let findings_schema = #{
    "type": "object",
    "required": ["pass", "findings"],
    "properties": #{
        "pass": #{ "type": "string" },
        "findings": #{
            "type": "array",
            "maxItems": 16,
            "items": #{
                "type": "object",
                "required": ["severity", "file", "line", "issue", "evidence"],
                "properties": #{
                    "severity": #{ "type": "string" },
                    "file": #{ "type": "string" },
                    "line": #{ "type": "integer" },
                    "issue": #{ "type": "string" },
                    "evidence": #{ "type": "string" },
                },
            },
        },
    },
};

fn pass_prompt(letter, title, lens, merge_base) {
    let p = "You are Pass ";
    p += letter;
    p += " (";
    p += title;
    p += ") of a four-focus pre-PR review. Merge-base SHA: ";
    p += merge_base;
    p += ". Run git diff ";
    p += merge_base;
    p += "..HEAD and git diff --name-only ";
    p += merge_base;
    p += "..HEAD. Read the changed files and surrounding call sites with read_file/grep — do not answer from memory. ";
    p += "ONLY report findings in this lens: ";
    p += lens;
    p += " Do NOT report issues that belong to another pass. ";
    p += "Each finding MUST include non-empty evidence (hunk, call site, or test name you actually read). ";
    p += "Empty findings is valid only after you inspected the diff. Severity: P0 must-fix before push, P1 must-fix or file-and-justify, P2 advisory. ";
    p += "Return JSON {pass: \"";
    p += letter;
    p += "\", findings: [{severity, file, line, issue, evidence}]}.";
    p
}

phase("Collect");
let base = ();
if args != () {
    if args.base != () { base = args.base; }
}
if base == () {
    let collected = agent(
        "Find the git merge-base of HEAD with origin/main, or origin/master if origin/main is missing. Run git merge-base. Return JSON {merge_base: \"<full sha>\"}. Do not review the diff.",
        #{ label: "collect-merge-base", capability_mode: "read-only", output_schema: base_schema },
    );
    if collected == () || !collected.success || collected.output.merge_base == () || collected.output.merge_base == "" {
        pause("verification", "Could not resolve merge-base. Pass args.base as the merge-base SHA.");
    }
    base = collected.output.merge_base;
}

phase("Focus");
let jobs = [
    #{
        prompt: pass_prompt("A", "Acceptance + tests", "Every active xBRIEF/spec acceptance criterion is met or explicitly deferred; new behavior has tests that would fail without the change; both sides of new branches; coverage headroom above the project floor. Not secrets, not extra-scope, not latent bugs.", base),
        label: "pass-A",
        capability_mode: "read-only",
        output_schema: findings_schema,
    },
    #{
        prompt: pass_prompt("B", "Bug hunt", "Adversarial correctness only: off-by-one, null, races, swallowed errors, wrong defaults, broken types, missing await, inverted conditions. Read call sites around the diff. Not missing tests, not secrets, not scope.", base),
        label: "pass-B",
        capability_mode: "read-only",
        output_schema: findings_schema,
    },
    #{
        prompt: pass_prompt("C", "Stealth / secrets / log leaks", "Secrets, tokens, PATs, cookies, keys, connection strings in the diff/fixtures/screenshots/.env; log/error/telemetry/transcript leaks of PII, request bodies, env, prompts; debug leftovers that disclose internal process. Not missing tests, not extra-scope.", base),
        label: "pass-C",
        capability_mode: "read-only",
        output_schema: findings_schema,
    },
    #{
        prompt: pass_prompt("D", "Regression + extra scope", "Files/behavior outside the active xBRIEF; tests deleted/skipped/weakened solely to go green; missing CHANGELOG Unreleased; whitespace-only drift hiding the real change. Do not expand the PR to absorb extra-scope — report it.", base),
        label: "pass-D",
        capability_mode: "read-only",
        output_schema: findings_schema,
    },
];
let results = parallel(jobs);

phase("Synthesize");
let confirmed = [];
let dropped = 0;
let i = 0;
for r in results {
    if r == () || !r.success || r.output.findings == () {
        dropped += 1;
    } else {
        for f in r.output.findings {
            if f.evidence == () || f.evidence == "" || f.issue == () || f.issue == "" {
                dropped += 1;
            } else {
                confirmed.push(#{
                    pass: r.output.pass,
                    severity: f.severity,
                    file: f.file,
                    line: f.line,
                    issue: f.issue,
                    evidence: f.evidence,
                });
            }
        }
    }
    i += 1;
}

let p0 = 0;
let p1 = 0;
let p2 = 0;
for f in confirmed {
    if f.severity == "P0" { p0 += 1; }
    if f.severity == "P1" { p1 += 1; }
    if f.severity == "P2" { p2 += 1; }
}

log(confirmed.len().to_string() + " evidenced findings (P0=" + p0.to_string() + " P1=" + p1.to_string() + " P2=" + p2.to_string() + "); dropped unverified=" + dropped.to_string());

let report = "# Four-focus pre-PR report\n\n";
report += "- Merge-base: " + base + "\n";
report += "- Evidenced findings: " + confirmed.len().to_string() + "\n";
report += "- P0: " + p0.to_string() + " P1: " + p1.to_string() + " P2: " + p2.to_string() + "\n";
report += "- Unverified dropped: " + dropped.to_string() + "\n\n";
if confirmed.len() == 0 {
    report += "No evidenced findings. Gate is clean.\n";
} else {
    report += "## Findings\n\n";
    for f in confirmed {
        report += "- **" + f.pass + " " + f.severity + "** `" + f.file + ":" + f.line.to_string() + "` — " + f.issue + "\n";
        report += "  - Evidence: " + f.evidence + "\n";
    }
}
let path = write_scratch_file("four-focus-report.md", report);
complete(#{
    path: path,
    merge_base: base,
    p0: p0,
    p1: p1,
    p2: p2,
    findings: confirmed,
    clean: p0 == 0 && p1 == 0,
});
