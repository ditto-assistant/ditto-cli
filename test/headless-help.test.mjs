import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DITTO_API_KEY: "", DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-help-")) },
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
}

// The machine-readable flag differs per harness — Claude Code takes
// --output-format, Codex takes --json. Documenting the wrong one sends people
// straight to "error: unexpected argument", which is what `heyditto codex
// --help` did: it advertised --output-format, which codex exec rejects.
test("codex help documents --json, never --output-format", async () => {
  const help = await run(["codex", "--help"]);
  assert.match(help, /--json/, "codex's machine-readable flag must be named");
  assert.doesNotMatch(help, /--output-format/, "codex exec rejects --output-format");
});

test("claude help documents --output-format, never a bare --json", async () => {
  const help = await run(["claude", "--help"]);
  assert.match(help, /--output-format json/, "claude's machine-readable flag must be named");
  assert.doesNotMatch(help, /pair with --json/, "claude takes --output-format, not --json");
});

test("each harness's example uses its own flag", async () => {
  const codex = await run(["codex", "--help"]);
  assert.match(codex, /heyditto codex -p "summarize this repo" --json/);
  const claude = await run(["claude", "--help"]);
  assert.match(claude, /heyditto claude -p "summarize this repo" --output-format json/);
});
