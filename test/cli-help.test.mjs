import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageJSON = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DITTO_API_KEY: "",
      DITTO_CONFIG_DIR: "/tmp/heyditto-cli-help-tests",
    },
  });
}

test("global --help prints command list", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: heyditto/);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /\bsave\b/);
  assert.match(result.stdout, /\bsearch\b/);
  assert.match(result.stdout, /\bgraphs\b/);
});

test("global -h prints help", () => {
  const result = run(["-h"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: heyditto/);
});

test("help command prints global help", () => {
  const result = run(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: heyditto/);
});

test("search --help prints command help without auth", () => {
  const result = run(["search", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: heyditto search/);
  assert.match(result.stdout, /--include-public/);
  assert.match(result.stdout, /--filter-username/);
  assert.equal(result.stderr, "");
});

test("save -h prints source options", () => {
  const result = run(["save", "-h"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--source/);
  assert.match(result.stdout, /--source-context/);
});

test("update --help prints file and revision options", () => {
  const result = run(["update", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--content-file/);
  assert.match(result.stdout, /--edits-file/);
  assert.match(result.stdout, /--base-revision/);
});

test("graphs --help prints graph subcommands", () => {
  const result = run(["graphs", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /create/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /add/);
  assert.match(result.stdout, /remove/);
  assert.match(result.stdout, /subscribers/);
});

test("graphs add --help prints subcommand help", () => {
  const result = run(["graphs", "add", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: heyditto graphs add/);
});

test("--version prints package version", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${packageJSON.version}\n`);
});

test("-v prints package version", () => {
  const result = run(["-v"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${packageJSON.version}\n`);
});

test("unknown search option fails with commander error", () => {
  const result = run(["search", "--definitely-not-real"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option '--definitely-not-real'/);
});
