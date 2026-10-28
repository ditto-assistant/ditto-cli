import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const node22 = process.env.DITTO_TEST_NODE22_BINARY;
test("unrelated Node22 CLI commands do not load experimental SQLite", { skip: !node22 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-node22-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "loaded-modules.json");
  const preload = path.join(root, "module-probe.mjs");
  await writeFile(preload, `import {writeFileSync} from "node:fs"; process.on("exit", () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.moduleLoadList.filter(name => name.toLowerCase().includes("sqlite")))));\n`);
  for (const [args, expectedStatus] of [[["--version"], 0], [["endpoints", "--help"], 0], [["status", "--output", "json"], 1]]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(node22, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../dist/cli.js", import.meta.url)), ...args], {
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "xdg"), CODEX_HOME: path.join(root, "codex"), DITTO_CONFIG_DIR: path.join(root, "ditto"), DITTO_API_BASE: "http://127.0.0.1:1", DITTO_API_KEY: "", DITTO_SERVICE_CREDENTIAL_FILE: "", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => stdout += data); child.stderr.on("data", (data) => stderr += data);
      child.on("error", reject); child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.doesNotMatch(result.stderr, /SQLite|ExperimentalWarning/u, "unrelated commands must not import the recovery database");
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), [], "early process.exit may suppress a queued warning, so inspect actual module loading too");
    assert.ok(result.stdout.trim());
  }
});
