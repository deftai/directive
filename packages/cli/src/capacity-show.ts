#!/usr/bin/env node
import { runCapacityShowCli } from "@deftai/core/capacity";

const result = runCapacityShowCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
