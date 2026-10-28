// Test-only injection lives here, never in the CLI environment/command surface.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCodexApp } from "../../dist/agents/codexapp.js";

if (process.argv[2]) {
const options = JSON.parse(process.argv[2]);
let injected = false;
let failureThrown = false;
let occurrences = 0;
try {
  await runCodexApp(options.recover ? { recover: true } : { endpoint: "alpha", yes: true }, {
    async checkpoint(point) {
      if (options.failAt === point && !failureThrown) { failureThrown = true; throw new Error("injected initial failure"); }
      if (point !== options.point || injected) return;
      occurrences++;
      if (occurrences !== (options.occurrence ?? 1)) return;
      injected = true;
      if (options.edit) {
        writeFileSync(options.edit.file, options.edit.contents);
        return;
      }
      if (options.inspect) {
        const pending = path.join(process.env.CODEX_HOME, ".ditto-codex-app-recovery", "pending");
        writeFileSync(options.inspect, readFileSync(path.join(pending, "manifest.json")));
      }
      if (options.marker) writeFileSync(options.marker, point);
      if (options.kind === "kill") process.kill(process.pid, "SIGKILL");
      if (options.kind === "hold") await new Promise(() => setInterval(() => {}, 1000));
      throw new Error(`injected failure at ${point}`);
    },
  });
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
}
