#!/usr/bin/env node
import { runXbriefVerifyCli } from "@deftai/directive-core/xbrief";

const result = runXbriefVerifyCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
