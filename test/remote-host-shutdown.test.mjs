import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostClient } from "../dist/remote/host.js";
import { startHostStub } from "./helpers/host-stub.mjs";

test("host shutdown waits for its pending host ID write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-host-shutdown-"));
  const prior = process.env.DITTO_CONFIG_DIR;
  process.env.DITTO_CONFIG_DIR = root;
  const stub = await startHostStub();
  let release;
  let started;
  const writeStarted = new Promise((resolve) => { started = resolve; });
  const blockedWrite = new Promise((resolve) => { release = resolve; });
  const host = new HostClient({
    baseUrl: stub.base, apiKey: "ditto_mcp_test", capabilities: {},
    handlers: { onTurn() {}, onInterrupt() {}, onCheckpoint() {} },
    persistHostId: async (id) => { assert.equal(id, "host-1"); started(); await blockedWrite; },
  });
  t.after(async () => { release(); await host.closeAndWait(); await stub.close(); if (prior === undefined) delete process.env.DITTO_CONFIG_DIR; else process.env.DITTO_CONFIG_DIR = prior; await rm(root, { recursive: true, force: true }); });
  assert.equal(await host.start(), true);
  await writeStarted;
  let stopped = false;
  const closing = host.closeAndWait().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "shutdown must not return while its profile write is pending");
  release();
  await closing;
  assert.equal(stopped, true);
});

test("host shutdown is bounded when a profile write stalls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-host-timeout-"));
  const prior = process.env.DITTO_CONFIG_DIR;
  process.env.DITTO_CONFIG_DIR = root;
  const stub = await startHostStub();
  const messages = [];
  const host = new HostClient({
    baseUrl: stub.base, apiKey: "ditto_mcp_test", capabilities: {},
    handlers: { onTurn() {}, onInterrupt() {}, onCheckpoint() {} },
    persistHostId: () => new Promise(() => {}), hostIdWriteTimeoutMs: 10,
    log: (line) => messages.push(line),
  });
  t.after(async () => { host.close(); await stub.close(); if (prior === undefined) delete process.env.DITTO_CONFIG_DIR; else process.env.DITTO_CONFIG_DIR = prior; await rm(root, { recursive: true, force: true }); });
  assert.equal(await host.start(), true);
  await host.closeAndWait();
  assert.match(messages.join("\n"), /identity save is still pending/);
});
