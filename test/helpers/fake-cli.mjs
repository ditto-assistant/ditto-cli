import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A PATH sandbox of fake platform CLIs. Each fake records its argv and stdin
 * to a log, so tests can prove the plaintext key travelled on stdin and never
 * through argv — the whole security property of `endpoints keys create`.
 *
 * PATH is replaced (not prepended) so a real `gh` or `aws` on the developer's
 * machine can never be reached, and a binary left out of `bins` is genuinely
 * missing as far as the CLI is concerned.
 */

const FAKE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

// The shim passes the name it was invoked as, then the real arguments.
const bin = process.argv[2];
const args = process.argv.slice(3);
let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  stdin = "";
}
appendFileSync(process.env.FAKE_CLI_LOG, \`\${JSON.stringify({ bin, args, stdin })}\\n\`);
const fail = process.env.FAKE_CLI_FAIL;
if (fail && args.join(" ").includes(fail)) {
  process.stderr.write(\`\${bin}: refusing "\${fail}" (fake failure)\\n\`);
  process.exit(1);
}
process.exit(0);
`;

export function createFakeCLIs(bins) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-fake-cli-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "calls.log");
  writeFileSync(log, "");
  const impl = path.join(dir, "fake.mjs");
  writeFileSync(impl, FAKE);
  for (const name of bins) {
    const file = path.join(bin, name);
    // A shim rather than a copy, so every fake shares one implementation.
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "${name}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  return {
    dir,
    log,
    /** Env additions that put only these fakes on PATH. */
    env: (extra = {}) => ({ PATH: bin, FAKE_CLI_LOG: log, ...extra }),
    /** Every recorded invocation, in order. */
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    /** Invocations that stored something, i.e. anything with stdin content. */
    writes: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((call) => call.stdin !== ""),
  };
}
