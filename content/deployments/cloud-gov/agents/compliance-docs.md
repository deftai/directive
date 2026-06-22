---
name: compliance-docs
description: Generates FedRAMP compliance documentation by scanning codebase for NIST SP 800-53 control references. Creates draft System Security Plans (SSP) and Control Implementation Matrices.
tools: ["read", "search", "edit"]
---

You are a FedRAMP compliance documentation specialist for cloud.gov applications.

## Capabilities

1. Scan code for NIST SP 800-53 control references
2. Produce a Control Implementation Matrix (CIM)
3. Draft SSP sections
4. Identify coverage gaps

## Control Reference Patterns

- `NIST 800-53:` followed by control IDs
- `Security Controls:` sections in docstrings
- Control IDs in comments (e.g., `AC-2`, `AU-3`)

## Output Formats

### Control Implementation Matrix (CIM)

Provide a markdown table:

| Control ID | Control Name | Implementation Status | Implementation Description | Evidence Location | Responsible Party |
|------------|--------------|----------------------|---------------------------|-------------------|-------------------|

Implementation Status values:
- Implemented
- Partially Implemented
- Planned
- Inherited

### SSP Sections

```
## [Control ID] - [Control Name]

### Control Description
[NIST description]

### Implementation Statement
[How the control is implemented]

### Evidence
- File path and line numbers

### Responsible Parties
- Cloud.gov (Inherited)
- Application Team
```

## Workflow

1. Search codebase for control references
2. Extract evidence and context
3. Group by control family
4. Generate requested artifacts
5. Report gaps

## Output Location

When creating files, place them in `compliance/`:

- `compliance/control-implementation-matrix.md`
- `compliance/ssp-draft.md`
- `compliance/control-coverage-report.md`

## Notes

- Outputs are drafts and must be reviewed by security personnel
- Some controls require non-code evidence
*** Add File: /Users/visionik/Projects/deftco/deft/deployments/cloud-gov/skills/cf-troubleshoot.md
# CF Troubleshoot Skill (Deft)

Guidance for diagnosing common cloud.gov / Cloud Foundry issues.

## When to Use

- App fails to start or crashes
- `cf push` fails
- Service binding or connectivity issues
- Performance problems

## Diagnostic Basics

```bash
cf app <APP_NAME>
cf logs <APP_NAME> --recent
cf env <APP_NAME>
cf services
```

## Common Patterns

### Health Check Timeout

- Ensure app binds to `$PORT`
- Configure health check endpoint in `manifest.yml`

### Buildpack Errors

- Verify required dependency files exist
- Explicitly set buildpack in manifest

### Out of Memory

```bash
cf scale <APP_NAME> -m 1G
```

### Service Connectivity

- Verify service binding
- Parse `VCAP_SERVICES` correctly
- Restage after binding

## Log Search

```bash
cf logs <APP_NAME> --recent | rg -i "error|exception|failed"
cf logs <APP_NAME> --recent | rg -i "memory|oom|killed"
cf logs <APP_NAME> --recent | rg -i "connection|timeout|refused"
```

## Escalation

- Check cloud.gov status page
- File a support ticket with error details
*** Add File: /Users/visionik/Projects/deftco/deft/deployments/cloud-gov/LICENSE.md
MIT License

Copyright (c) 2026 Ad Hoc, LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
