#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startupUpdate } from "./self-update.js";
import { executeSelectedCLI } from "./entry-runner.js";

// Select only a version installed by a PREVIOUS invocation. This process never
// replaces files or restarts a command that has already begun.
const bundledRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
let selected = bundledRoot;
try { selected = await startupUpdate(bundledRoot); } catch { /* update failures never break the CLI */ }
await executeSelectedCLI(selected, bundledRoot);
