#!/usr/bin/env node
import { runProjectionRegistryCli } from "@deftai/directive-core/codebase";

const result = runProjectionRegistryCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
