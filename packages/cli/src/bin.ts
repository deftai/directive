#!/usr/bin/env node
import { routeAndDispatch } from "./cli-router/index.js";

const code = await routeAndDispatch(process.argv.slice(2));
process.exit(code);
