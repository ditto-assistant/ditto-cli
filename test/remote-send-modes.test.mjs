import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteSession } from "../dist/remote/controller.js";
import { spawnInPty } from "../dist/remote/pty.js";
import { startHostStub } from "./helpers/host-stub.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function world(t, { harness = "claude", mode = "tui", inject } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-send-modes-"));
  const prior = process.env.DITTO_CONFIG_DIR;
  process.env.DITTO_CONFIG_DIR = path.join(cwd, "config");
  const stub = await startHostStub();
  const events = new EventEmitter();
  const calls = [];
  let interrupts = 0;
  let quiet = 0;
  const pty = { pid: 1, write() {}, inject: async (...args) => { calls.push(args); await inject?.(...args); }, interrupt() { interrupts++; }, quietFor: () => quiet, exit: new Promise(() => {}), kill() {} };
  const session = new RemoteSession({ harness, mode, cwd, sessionId: "owned-session", apiKey: "ditto_mcp_test", baseUrl: stub.base, log() {}, quietFallbackMs: 400 }, { events });
  if (mode === "tui") session.attachTui(pty);
  t.after(async () => { session.stop(); await stub.close(); if (prior === undefined) delete process.env.DITTO_CONFIG_DIR; else process.env.DITTO_CONFIG_DIR = prior; await rm(cwd, { recursive: true, force: true }); });
  await session.start();
  const send = (turnId, extra = {}) => stub.send({ type: "turn.deliver", sessionId: "owned-session", turnId, text: turnId, ...extra });
  const started = (id) => stub.waitFor((f) => f.type === "turn.started" && f.turnId === id);
  const finished = (id) => stub.waitFor((f) => f.type === "turn.finished" && f.turnId === id);
  return { stub, events, calls, session, send, started, finished, interrupts: () => interrupts, quiet: () => { quiet = Infinity; } };
}

test("Claude normal FIFO survives immediate steering and stale Stop cannot finish its replacement", async (t) => {
  const w = await world(t);
  const hello = w.stub.frames.find((f) => f.type === "hello");
  assert.deepEqual(hello.capabilities.promptDelivery, { queue: true, steer: true, interrupt: true });
  w.send("first"); await w.started("first");
  w.send("queued"); await w.stub.waitFor((f) => f.type === "turn.ack" && f.turnId === "queued");
  assert.equal(w.calls.length, 1, "normal busy prompt stays in the host FIFO");
  w.send("steer", { deliveryMode: "steer" }); await w.started("steer");
  assert.equal((await w.finished("first")).interrupted, true);
  assert.deepEqual(w.calls.map(([text, mode]) => [text, mode]), [["first", undefined], ["steer", "steer"]]);
  w.stub.send({ type: "turn.interrupt", turnId: "first" });
  w.events.emit("hook", { source: "claude", event: "Stop", payload: { stop_hook_active: false } });
  await sleep(60);
  assert.equal(w.interrupts(), 0, "stale transport Stop does not escape the new turn");
  assert.equal(w.calls.length, 2, "old completion cannot drain queued input over the steered turn");
  assert.equal(w.stub.frames.some((f) => f.type === "turn.finished" && f.turnId === "steer"), false, "unscoped late native Stop is ignored");
  const newStart = w.stub.frames.findIndex((f) => f.type === "turn.started" && f.turnId === "steer");
  assert.equal(w.stub.frames.slice(newStart).some((f) => f.type === "session.status" && f.status === "idle"), false, "old finally does not publish a false idle state");
  w.stub.send({ type: "turn.interrupt", turnId: "steer" });
  await sleep(30); assert.equal(w.interrupts(), 1, "independent current Stop still sends Escape");
  w.quiet(); assert.equal((await w.finished("steer")).interrupted, true);
  await w.started("queued");
  assert.equal(w.calls[2][0], "queued");
  w.events.emit("hook", { source: "claude", event: "Stop" });
  await w.finished("queued");
});

test("a locally typed native prompt holds remote FIFO until its Stop hook", async (t) => {
  const w = await world(t);
  w.events.emit("hook", { source: "claude", event: "UserPromptSubmit", payload: { prompt: "local synthetic input" } });
  w.send("after-local");
  await w.stub.waitFor((f) => f.type === "turn.ack" && f.turnId === "after-local");
  await sleep(40);
  assert.equal(w.calls.length, 0, "busy native keyboard turn must not consume a remote receipt");
  w.events.emit("hook", { source: "claude", event: "Stop" });
  await w.started("after-local");
  assert.equal(w.calls[0][0], "after-local");
  w.events.emit("hook", { source: "claude", event: "Stop" });
  await w.finished("after-local");
});

test("unsupported mode, non-prompt steering and pending permission never inject", async (t) => {
  const w = await world(t);
  w.send("unknown", { deliveryMode: "invented" });
  w.send("command", { deliveryMode: "steer", kind: "command", command: { name: "compact" } });
  for (const id of ["unknown", "command"]) assert.ok((await w.finished(id)).unsupported);
  w.events.emit("hook", { source: "claude", event: "Notification", payload: { notification_type: "permission_prompt" } });
  w.send("permission", { deliveryMode: "steer" });
  assert.ok((await w.finished("permission")).unsupported);
  assert.equal(w.calls.length, 0);
});

test("headless and other harnesses explicitly refuse steering without downgrading", async (t) => {
  for (const options of [{ harness: "claude", mode: "headless" }, { harness: "codex" }]) {
    await t.test(JSON.stringify(options), async (sub) => {
      const w = await world(sub, options);
      assert.equal(w.stub.frames.find((f) => f.type === "hello").capabilities.promptDelivery.steer, false);
      w.send("unsupported", { deliveryMode: "steer" });
      assert.ok((await w.finished("unsupported")).unsupported);
      assert.equal(w.calls.length, 0);
    });
  }
});

test("Stop during paste aborts submission and does not report a started turn", async (t) => {
  let release;
  const pasted = new Promise((resolve) => { release = resolve; });
  const w = await world(t, { inject: async () => pasted });
  w.send("paste", { deliveryMode: "steer" });
  while (!w.calls.length) await sleep(5);
  w.stub.send({ type: "turn.interrupt", turnId: "paste" });
  while (!w.interrupts()) await sleep(5);
  assert.equal(w.calls[0][2].aborted, true);
  release();
  assert.equal((await w.finished("paste")).interrupted, true);
  assert.equal(w.stub.frames.some((f) => f.type === "turn.started" && f.turnId === "paste"), false);
});

test("Stop targeting the prior active receipt cancels a steering paste before Ctrl+Enter", async (t) => {
  let release;
  const pasted = new Promise((resolve) => { release = resolve; });
  const w = await world(t, { inject: async (_text, mode) => { if (mode === "steer") await pasted; } });
  w.send("prior"); await w.started("prior");
  w.send("new-paste", { deliveryMode: "steer" });
  const deadline = Date.now() + 2000;
  while (w.calls.length < 2 && Date.now() < deadline) await sleep(5);
  assert.equal(w.calls.length, 2);
  w.stub.send({ type: "turn.interrupt", turnId: "prior" });
  const stopDeadline = Date.now() + 2000;
  while (!w.interrupts() && Date.now() < stopDeadline) await sleep(5);
  assert.equal(w.interrupts(), 1);
  assert.equal(w.calls[1][2].aborted, true);
  release();
  assert.equal((await w.finished("prior")).interrupted, true);
  assert.equal((await w.finished("new-paste")).interrupted, true);
  assert.equal(w.stub.frames.some((f) => f.type === "turn.started" && f.turnId === "new-paste"), false);
});

test("actual PTY submits Enter and observed Ctrl+Enter bytes while Stop remains Escape", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-send-keys-"));
  const chunks = [];
  const script = String.raw`process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("READY\n");process.stdin.on("data",b=>process.stdout.write("HEX:"+b.toString("hex")+"\n"));`;
  const pty = await spawnInPty(process.execPath, ["--input-type=module", "-e", script], { cwd, env: process.env, attachTerminal: false, onOutput: (data) => chunks.push(data) });
  t.after(async () => { pty.kill(); await pty.exit; await rm(cwd, { recursive: true, force: true }); });
  const deadline = Date.now() + 2000;
  while (!/(?:^|[\r\n])READY[\r\n]/.test(chunks.join("")) && Date.now() < deadline) await sleep(5);
  assert.match(chunks.join(""), /(?:^|[\r\n])READY[\r\n]/);
  await pty.inject("normal"); await pty.inject("immediate", "steer"); pty.interrupt("claude");
  await sleep(60);
  const hex = [...chunks.join("").matchAll(/HEX:([0-9a-f]+)/g)].map((m) => m[1]).join("");
  assert.equal(hex, Buffer.from("\u001b[200~normal\u001b[201~\r\u001b[200~immediate\u001b[201~\u001b[13;5u\u001b").toString("hex"));
  const before = chunks.length;
  const stop = new AbortController();
  const injecting = pty.inject("cancelled", "steer", stop.signal);
  stop.abort(); await injecting; await sleep(30);
  const cancelled = [...chunks.slice(before).join("").matchAll(/HEX:([0-9a-f]+)/g)].map((m) => m[1]).join("");
  assert.equal(cancelled, Buffer.from("\u001b[200~cancelled\u001b[201~").toString("hex"), "cancelled paste must not submit after Stop");
});
