#!/usr/bin/env node
import { runXbriefCreateCli } from "@deftai/directive-core/xbrief";

const result = runXbriefCreateCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
