import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isLaunchKeyName, parseAge, planPrune, unfinishedKeys } from "../dist/agents/prune.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");

function record(id, daysAgo, extra = {}) {
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  return {
    id,
    harness: "claude",
    endpointId: "ep-1",
    endpointSlug: "alpha",
    keyId: `key-${id}`,
    keyHint: "abcd",
    cwd: "/tmp/project",
    createdAt: at,
    lastLaunchedAt: at,
    endedAt: at,
    exitCode: 0,
    launches: 1,
    ...extra,
  };
}

test("parseAge reads minutes, hours, days, weeks, months and years", () => {
  assert.equal(parseAge("30m"), 30 * 60_000);
  assert.equal(parseAge("12h"), 12 * 3_600_000);
  assert.equal(parseAge("7d"), 7 * DAY);
  assert.equal(parseAge("2w"), 14 * DAY);
  assert.equal(parseAge("3mo"), 90 * DAY);
  assert.equal(parseAge("1y"), 365 * DAY);
  assert.throws(() => parseAge("7"), /--older-than/);
  assert.throws(() => parseAge("soon"), /--older-than/);
});

test("isLaunchKeyName matches only this host's default launch key names", () => {
  assert.equal(isLaunchKeyName("cli:claude:devbox", "devbox"), true);
  assert.equal(isLaunchKeyName("cli:grok:devbox", "devbox"), true);
  assert.equal(isLaunchKeyName("cli:claude:laptop", "devbox"), false);
  assert.equal(isLaunchKeyName("ci deploy key", "devbox"), false);
  assert.equal(isLaunchKeyName("cli::devbox", "devbox"), false);
});

test("planPrune forgets records past the cutoff and keeps the most recent ones", () => {
  const records = [record("a", 40), record("b", 20), record("c", 10), record("d", 1)];
  const plan = planPrune(records, { olderThanMs: 7 * DAY, keep: 1, now: NOW });
  assert.deepEqual(plan.prune.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(plan.kept.map((r) => r.id), ["d"]);
});

test("unfinishedKeys revokes only the keys of pruned records that never ended", () => {
  const records = [record("crashed", 30, { endedAt: undefined, exitCode: undefined }), record("clean", 30), record("fresh", 1)];
  const plan = planPrune(records, { olderThanMs: 7 * DAY, keep: 1, now: NOW });
  assert.deepEqual(unfinishedKeys(plan).map((k) => k.keyId), ["key-crashed"]);
});

test("sessions prune --dry-run lists old records and changes nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-prune-"));
  mkdirSync(path.join(dir, "sessions"));
  const now = Date.now();
  const at = (days) => new Date(now - days * DAY).toISOString();
  for (const [id, days] of [["recent", 1], ["stale", 40]]) {
    writeFileSync(
      path.join(dir, "sessions", `${id}.json`),
      JSON.stringify({ ...record(id, 0), createdAt: at(days), lastLaunchedAt: at(days), endedAt: at(days) }),
    );
  }
  const run = (args) =>
    spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: { ...process.env, DITTO_API_KEY: "", DITTO_CONFIG_DIR: dir } });

  const res = run(["sessions", "prune", "--dry-run", "--older-than", "7d", "--keep", "0"]);
  assert.equal(res.status, 0, res.stderr);

  const list = run(["sessions", "--json"]);
  assert.deepEqual(JSON.parse(list.stdout).map((r) => r.id).sort(), ["recent", "stale"]);
});
