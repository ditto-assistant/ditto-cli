import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DITTO_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "heyditto-notes-"));

const { holdNotesForTui, notesLogPath, pendingNoteCount, releaseNotes, writeNote } = await import("../dist/terminal-note.js");
const { HostClient } = await import("../dist/remote/host.js");
const { startHostStub } = await import("./helpers/host-stub.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Captures what reaches stderr (the terminal) while fn runs. */
async function captureStderr(fn) {
  const original = process.stderr.write;
  let out = "";
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    const cb = rest.find((a) => typeof a === "function");
    cb?.();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

test("notes: nothing reaches the terminal while a TUI owns it; held notes replay after it exits", async () => {
  let duringTui = "";
  const afterExit = await captureStderr(async () => {
    holdNotesForTui();
    duringTui = await captureStderr(async () => {
      writeNote("\u001b[2mditto:\u001b[22m remote control on\n", { transient: true });
      writeNote("ditto: remote control: disconnected (1012); reconnecting in the background\n");
    });
    assert.equal(pendingNoteCount(), 1, "the transient note is not held for replay");
    releaseNotes();
  });
  assert.equal(duringTui, "", "no byte is painted into the harness's screen");
  assert.equal(afterExit, "ditto: remote control: disconnected (1012); reconnecting in the background\n");
  const log = readFileSync(notesLogPath(), "utf8");
  assert.match(log, /Z ditto: remote control on\n/, "colour codes are stripped in the log");
  assert.match(log, /disconnected \(1012\)/);
  // With no TUI active, notes go straight through and are not logged.
  const direct = await captureStderr(() => writeNote("plain\n"));
  assert.equal(direct, "plain\n");
  assert.doesNotMatch(readFileSync(notesLogPath(), "utf8"), /plain/);
});

function client(stub, lines, quietReconnectMs) {
  return new HostClient({
    baseUrl: stub.base,
    apiKey: "ditto_mcp_test",
    capabilities: { harnesses: ["claude-code"], attachments: false, headless: false, teleport: false },
    handlers: { onTurn() {}, onInterrupt() {}, onCheckpoint() {} },
    log: (line) => lines.push(line),
    quietReconnectMs,
    reconnectBaseMs: 50,
    reconnectMaxMs: 100,
  });
}

test("host: a drop that recovers inside the quiet window prints nothing", async () => {
  const stub = await startHostStub();
  const lines = [];
  const host = client(stub, lines, 2000);
  try {
    assert.equal(await host.start(), true);
    const before = stub.frames.length;
    stub.dropClients();
    await stub.waitFor((f) => f.type === "hello", { from: before });
    await sleep(2500);
    assert.deepEqual(lines, []);
    assert.equal(host.isConnected, true);
  } finally {
    host.close();
    await stub.close();
  }
});

test("host: a lasting outage is reported once, then reconnected", async () => {
  const stub = await startHostStub();
  const lines = [];
  const host = client(stub, lines, 300);
  try {
    assert.equal(await host.start(), true);
    stub.refuseConnections(true);
    stub.dropClients();
    await sleep(1200);
    assert.deepEqual(lines, ["remote control: disconnected (1006); reconnecting in the background"], "one line, not one per failed retry");
    const before = stub.frames.length;
    stub.refuseConnections(false);
    await stub.waitFor((f) => f.type === "hello", { from: before });
    await sleep(100);
    assert.deepEqual(lines.slice(1), ["remote control: reconnected"]);
  } finally {
    host.close();
    await stub.close();
  }
});
