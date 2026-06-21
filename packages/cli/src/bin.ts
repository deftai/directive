#!/usr/bin/env node
import { dispatch } from "./dispatch.js";

const code = await dispatch(process.argv.slice(2));
process.exit(code);
