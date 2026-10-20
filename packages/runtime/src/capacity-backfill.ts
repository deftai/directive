#!/usr/bin/env node
import { runCapacityBackfillCli } from "@deftai/directive-core/capacity";

const result = await runCapacityBackfillCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
