#!/usr/bin/env node
import { runLauncher } from "./launcher.js";

const code = runLauncher(process.argv.slice(2));
process.exit(code);
