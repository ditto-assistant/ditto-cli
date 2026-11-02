import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
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
  const writes = [];
  let interrupts = 0;
  let quiet = 0;
  const pty = { pid: 1, write(data) { writes.push(data); }, inject: async (...args) => { calls.push(args); await inject?.(...args); }, interrupt() { interrupts++; }, quietFor: () => quiet, exit: new Promise(() => {}), kill() {} };
  const session = new RemoteSession({ harness, mode, cwd, sessionId: "owned-session", apiKey: "ditto_mcp_test", baseUrl: stub.base, log() {}, quietFallbackMs: 400 }, { events });
  if (mode === "tui") session.attachTui(pty);
  t.after(async () => { session.stop(); await stub.close(); if (prior === undefined) delete process.env.DITTO_CONFIG_DIR; else process.env.DITTO_CONFIG_DIR = prior; await rm(cwd, { recursive: true, force: true }); });
  await session.start();
  const send = (turnId, extra = {}) => stub.send({ type: "turn.deliver", sessionId: "owned-session", turnId, text: turnId, ...extra });
  let toolSequence = 0;
  const permissionPayload = () => ({ session_id: "11111111-1111-4111-8111-111111111111", tool_use_id: `synthetic-${++toolSequence}`, tool_name: "Bash", tool_input: { command: "printf owned-permission" }, transcript_path: path.join(cwd, "11111111-1111-4111-8111-111111111111.jsonl") });
  const permission = (message = "Synthetic permission") => {
    const payload = permissionPayload();
    events.emit("hook", { source: "claude", event: "PreToolUse", payload });
    events.emit("hook", { source: "claude", event: "PermissionRequest", payload });
    events.emit("hook", { source: "claude", event: "Notification", payload: { session_id: payload.session_id, notification_type: "permission_prompt", message } });
    return payload;
  };
  const question = (options = [{ label: "Next" }]) => {
    const payload = { ...permissionPayload(), tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Synthetic question", options }] } };
    events.emit("hook", { source: "claude", event: "PreToolUse", payload });
    return payload;
  };
  const started = (id) => stub.waitFor((f) => f.type === "turn.started" && f.turnId === id);
  const finished = (id) => stub.waitFor((f) => f.type === "turn.finished" && f.turnId === id);
  return { stub, events, calls, writes, session, send, started, finished, permission, permissionPayload, question, interrupts: () => interrupts, quiet: () => { quiet = Infinity; }, busy: () => { quiet = 0; } };
}

test("Claude normal FIFO survives immediate steering and stale Stop cannot finish its replacement", async (t) => {
  const w = await world(t);
  const hello = w.stub.frames.find((f) => f.type === "hello");
  assert.deepEqual(hello.capabilities.promptDelivery, { queue: true, steer: true, interrupt: true, promptResolution: true });
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

test("late steered Stop cannot finish its normal successor after fallback", { timeout: 6000 }, async (t) => {
  const w = await world(t);
  w.send("steered", { deliveryMode: "steer" }); await w.started("steered");
  w.send("successor"); w.quiet(); await w.finished("steered");
  await w.started("successor"); w.busy();
  w.events.emit("hook", { source: "claude", event: "Stop" });
  await sleep(70);
  assert.equal(w.stub.frames.some((f) => f.type === "turn.finished" && f.turnId === "successor"), false, "late steered hook must not finish the successor");
  w.stub.send({ type: "turn.interrupt", turnId: "successor" });
  await sleep(20); assert.equal(w.interrupts(), 1, "physical Stop remains independent after hook distrust");
  w.quiet(); assert.equal((await w.finished("successor")).interrupted, true);
});

test("post-steer local keyboard activity drains queued input through bounded fallback", { timeout: 6000 }, async (t) => {
  const w = await world(t);
  w.send("steered", { deliveryMode: "steer" }); await w.started("steered");
  w.quiet(); await w.finished("steered"); w.busy();
  w.events.emit("hook", { source: "claude", event: "UserPromptSubmit", payload: { prompt: "local successor" } });
  w.send("after-local");
  await sleep(50); assert.equal(w.calls.length, 1);
  w.events.emit("hook", { source: "claude", event: "Stop" });
  await sleep(30); assert.equal(w.calls.length, 1, "unscoped hook cannot release the local hold");
  w.quiet(); await w.started("after-local"); await w.finished("after-local");
});

test("failed steering injection restores only an unsettled predecessor", { timeout: 6000 }, async (t) => {
  const w = await world(t, { inject: async (_text, mode) => { if (mode === "steer") throw new Error("synthetic write rejection"); } });
  w.send("prior"); await w.started("prior");
  w.send("rejected", { deliveryMode: "steer" });
  assert.match((await w.finished("rejected")).error, /synthetic write rejection/);
  w.events.emit("hook", { source: "claude", event: "Stop" });
  await w.finished("prior");
  assert.equal(w.stub.frames.find((f) => f.type === "turn.finished" && f.turnId === "prior").interrupted, undefined);
});

test("unsupported mode, non-prompt steering and pending permission never inject", async (t) => {
  const w = await world(t);
  w.send("unknown", { deliveryMode: "invented" });
  w.send("command", { deliveryMode: "steer", kind: "command", command: { name: "compact" } });
  for (const id of ["unknown", "command"]) assert.ok((await w.finished(id)).unsupported);
  w.permission();
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

test("Stop during paste aborts submission and does not report a started turn", { timeout: 6000 }, async (t) => {
  let release;
  const pasted = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const w = await world(t, { inject: async () => pasted });
  w.send("paste", { deliveryMode: "steer" });
  const injectDeadline = Date.now() + 2000;
  while (!w.calls.length && Date.now() < injectDeadline) await sleep(5);
  assert.equal(w.calls.length, 1, "paste injection should begin before the deadline");
  w.stub.send({ type: "turn.interrupt", turnId: "paste" });
  const interruptDeadline = Date.now() + 2000;
  while (!w.interrupts() && Date.now() < interruptDeadline) await sleep(5);
  assert.equal(w.interrupts(), 1, "interrupt should be delivered before the deadline");
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

test("Stop cancels a delivered steer waiting for the input lock before activation", { timeout: 6000 }, async (t) => {
  let release;
  const writing = new Promise((resolve) => { release = resolve; });
  const w = await world(t, { inject: async () => writing });
  w.send("first-paste");
  const deadline = Date.now() + 2000;
  while (!w.calls.length && Date.now() < deadline) await sleep(5);
  assert.equal(w.calls.length, 1);
  w.send("pending-steer", { deliveryMode: "steer" });
  await w.stub.waitFor((f) => f.type === "turn.ack" && f.turnId === "pending-steer");
  w.stub.send({ type: "turn.interrupt", turnId: "pending-steer" });
  await sleep(30); assert.equal(w.interrupts(), 1);
  release();
  assert.equal((await w.finished("pending-steer")).interrupted, true);
  assert.equal((await w.finished("first-paste")).interrupted, true);
  assert.equal(w.calls.length, 1, "cancelled pending steer must never paste or submit later");
});

test("Stop before delivery cancels only a later matching steer, never its unrelated current or normal queue", { timeout: 6000 }, async (t) => {
  const w = await world(t);
  w.send("actual"); await w.started("actual");
  w.stub.send({ type: "turn.interrupt", turnId: "late-steer" });
  w.send("late-steer", { deliveryMode: "steer" });
  await w.stub.waitFor(f => f.type === "turn.ack" && f.turnId === "late-steer");
  assert.equal(w.calls.length, 1, "a canceled future steer must not reach native injection");
  assert.equal((await w.finished("late-steer")).interrupted, true);
  assert.equal(w.calls.length, 1); assert.equal(w.interrupts(), 0, "unknown ID alone cannot interrupt an unrelated current turn");
  w.stub.send({ type: "turn.interrupt", turnId: "ordinary" });
  w.send("ordinary");
  w.events.emit("hook", { source: "claude", event: "Stop" }); await w.finished("actual");
  await w.started("ordinary");
  assert.equal(w.calls.length, 2, "cancellation intent applies only to steering, not normal queued prompts");
  w.events.emit("hook", { source: "claude", event: "Stop" }); await w.finished("ordinary");
});

test("invalid steering IDs cannot bypass pre-delivery cancellation bounds", { timeout: 3000 }, async (t) => {
  const w = await world(t);
  for (const id of ["", "x".repeat(257)]) {
    w.stub.send({ type: "turn.interrupt", turnId: id });
    w.send(id, { deliveryMode: "steer" });
    await w.stub.waitFor(f => f.type === "turn.ack" && f.turnId === id);
    assert.equal(w.calls.length, 0, "an unrememberable steering ID must not reach native injection");
    assert.match((await w.finished(id)).error, /Invalid steering turn ID/);
  }
  assert.equal(w.calls.length, 0);
  assert.equal(w.interrupts(), 0, "invalid unknown IDs must never interrupt the current native session");
});

test("paired pending-steer and predecessor Stop frames send one independent physical interrupt", { timeout: 6000 }, async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const w = await world(t, { inject: async (_text, mode) => { if (mode === "steer") await gate; } });
  w.send("predecessor"); await w.started("predecessor");
  w.send("preparing", { deliveryMode: "steer" });
  const injectDeadline = Date.now() + 2000;
  while (w.calls.length < 2 && Date.now() < injectDeadline) await sleep(5);
  assert.equal(w.calls.length, 2, "steering injection should begin before the deadline");
  w.stub.send({ type: "turn.interrupt", turnId: "preparing" });
  w.stub.send({ type: "turn.interrupt", turnId: "predecessor" });
  w.send("normal-barrier");
  await w.stub.waitFor(f => f.type === "turn.ack" && f.turnId === "normal-barrier");
  assert.equal(w.interrupts(), 1, "paired exact targets cannot generate duplicate Escape keys");
  release();
  assert.equal((await w.finished("preparing")).interrupted, true);
  assert.equal((await w.finished("predecessor")).interrupted, true);
  await w.started("normal-barrier");
  w.events.emit("hook", { source: "claude", event: "Stop" }); await w.finished("normal-barrier");
});

test("pre-delivery steering cancellation expires and remains bounded", { timeout: 6000 }, async (t) => {
  const w = await world(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  w.stub.send({ type: "turn.interrupt", turnId: "expired" });
  w.send("barrier"); await w.started("barrier");
  w.events.emit("hook", { source: "claude", event: "Stop" }); await w.finished("barrier");
  now += 5 * 60_000 + 1;
  w.send("expired", { deliveryMode: "steer" }); await w.started("expired");
  for (let i = 0; i <= 256; i++) w.stub.send({ type: "turn.interrupt", turnId: `bounded-${i}` });
  w.send("bounded-0", { deliveryMode: "steer" }); await w.started("bounded-0");
  w.send("bounded-256", { deliveryMode: "steer" });
  assert.equal((await w.finished("bounded-256")).interrupted, true);
  assert.equal(w.calls.length, 3, "expired and evicted intents release; retained intent cannot inject");
});

test("actual PTY submits Enter and observed Ctrl+Enter bytes while Stop remains Escape", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-send-keys-"));
  const chunks = [];
  const script = String.raw`process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("READY\n");process.stdin.on("data",b=>process.stdout.write("HEX:"+b.toString("hex")+"\n"));`;
  const pty = await spawnInPty(process.execPath, ["--input-type=module", "-e", script], { cwd, env: process.env, harness: "claude", attachTerminal: false, onOutput: (data) => chunks.push(data) });
  t.after(async () => { pty.kill(); await pty.exit; await rm(cwd, { recursive: true, force: true }); });
  const deadline = Date.now() + 2000;
  while (!/(?:^|[\r\n])READY[\r\n]/.test(chunks.join("")) && Date.now() < deadline) await sleep(5);
  assert.match(chunks.join(""), /(?:^|[\r\n])READY[\r\n]/);
  await pty.inject("normal"); await pty.inject("immediate", "steer"); pty.interrupt("claude");
  await sleep(60);
  const hex = [...chunks.join("").matchAll(/HEX:([0-9a-f]+)/g)].map((m) => m[1]).join("");
  assert.equal(hex, Buffer.from("\u001b[200~normal\u001b[201~\r\u001b[200~immediate\u001b[201~\u001b[13;5u\u001b").toString("hex"));
  const afterSubmit = new AbortController();
  await pty.inject("already submitted", "queue", afterSubmit.signal);
  await sleep(30);
  const submittedEnd = chunks.length;
  afterSubmit.abort(); await sleep(30);
  assert.equal(chunks.length, submittedEnd, "late abort must not clear a later native draft");
  const before = chunks.length;
  const stop = new AbortController();
  const injecting = pty.inject("cancelled\nline two\nline three", "steer", stop.signal);
  stop.abort(); await injecting; await sleep(30);
  const cancelled = [...chunks.slice(before).join("").matchAll(/HEX:([0-9a-f]+)/g)].map((m) => m[1]).join("");
  assert.equal(cancelled, Buffer.from("\u001b[200~cancelled\nline two\nline three\u001b[201~\u001f").toString("hex"), "only an owned unsubmitted paste is cleared before independent Stop");
});


test("canceled owned paste never undoes an intervening local stdin edit", { timeout: 8000 }, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-local-input-"));
  const ptyURL = new URL("../dist/remote/pty.js", import.meta.url).href;
  const echo = String.raw`process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("READY\n");process.stdin.on("data",b=>process.stdout.write("HEX:"+b.toString("hex")+"\n"));`;
  // A separate Node process owns stdin forwarding, so this test never changes
  // the test runner's terminal/raw-mode state or forwards real user input.
  const script = String.raw`
    import { spawnInPty } from ${JSON.stringify(ptyURL)};
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let pty;
    process.once("SIGTERM", () => pty?.kill());
    try {
      const chunks = [];
      pty = await spawnInPty(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(echo)}], { cwd: process.cwd(), env: process.env, harness: "claude", pasteDelayMs: 2000, onOutput: data => chunks.push(data) });
      const deadline = Date.now() + 2000;
      while (!chunks.join("").includes("READY") && Date.now() < deadline) await sleep(5);
      if (!chunks.join("").includes("READY")) throw new Error("owned PTY did not become ready");
      const localInput = new Promise(resolve => process.stdin.once("data", resolve));
      const stop = new AbortController();
      const injecting = pty.inject("owned paste", "steer", stop.signal);
      process.stdout.write("PASTE_PENDING\n");
      await localInput;
      stop.abort();
      await injecting;
      await sleep(40);
      const hex = [...chunks.join("").matchAll(/HEX:([0-9a-f]+)/g)].map(m => m[1]).join("");
      process.stdout.write("REPORT:" + JSON.stringify({ hex }) + "\n");
    } finally {
      pty?.kill();
      await pty?.exit;
    }
  `;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "", sent = false;
  const exited = new Promise(resolve => runner.once("exit", resolve));
  runner.stdout.on("data", data => {
    output += data;
    if (!sent && output.includes("PASTE_PENDING")) { sent = true; runner.stdin.end("local-edit"); }
  });
  runner.stderr.on("data", data => { errors += data; });
  t.after(async () => { if (runner.exitCode === null) runner.kill(); await exited; await rm(cwd, { recursive: true, force: true }); });
  assert.equal(await exited, 0, errors);
  const report = output.match(/REPORT:([^\r\n]+)/);
  assert.ok(report, output);
  assert.equal(JSON.parse(report[1]).hex, Buffer.from("\u001b[200~owned paste\u001b[201~local-edit").toString("hex"), "intervening local edit must suppress undo without submitting the canceled paste");
});

test("aborted owned paste never undoes an intervening public PTY write", { timeout: 6000 }, async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-public-input-"));
  const chunks = [];
  const echo = String.raw`process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("READY\n");process.stdin.on("data",b=>process.stdout.write("HEX:"+b.toString("hex")+"\n"));`;
  const pty = await spawnInPty(process.execPath, ["--input-type=module", "-e", echo], { cwd, env: process.env, harness: "claude", attachTerminal: false, pasteDelayMs: 200, onOutput: data => chunks.push(data) });
  t.after(async () => { pty.kill(); await pty.exit; await rm(cwd, { recursive: true, force: true }); });
  const until = async (ready, label) => {
    const deadline = Date.now() + 1500;
    while (!ready() && Date.now() < deadline) await sleep(5);
    assert.ok(ready(), label);
  };
  await until(() => chunks.join("").includes("READY"), "owned echo PTY ready");
  const stop = new AbortController();
  const injecting = pty.inject("owned paste", "steer", stop.signal);
  pty.write("permission-answer");
  stop.abort(); await injecting;
  const expected = Buffer.from("\u001b[200~owned paste\u001b[201~permission-answer").toString("hex");
  const hex = () => [...chunks.join("").matchAll(/HEX:([0-9a-f]+)/g)].map(m => m[1]).join("");
  await until(() => hex().length >= expected.length, "public write observed by actual PTY");
  assert.equal(hex(), expected, "foreign input must not be undone or submitted by cancellation");
  pty.interrupt("claude");
  await until(() => hex().length > expected.length, "independent Stop observed");
  assert.equal(hex(), expected + "1b", "physical Claude Stop remains Escape independently");
  assert.match(pty.inputBlockReason(), /terminal.*draft/i);
  const fresh = await spawnInPty(process.execPath, ["--input-type=module", "-e", echo], { cwd, env: process.env, harness: "claude", attachTerminal: false });
  t.after(async () => { fresh.kill(); await fresh.exit; });
  assert.equal(fresh.inputBlockReason(), undefined, "a new owned PTY is known fresh input state");
});

test("controller refuses queued paste after an aborted owned paste preserves foreign input", { timeout: 8000 }, async t => {
  const w = await world(t);
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-controller-input-"));
  const chunks = [];
  const echo = String.raw`process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("READY\n");process.stdin.on("data",b=>process.stdout.write("HEX:"+b.toString("hex")+"\n"));`;
  const pty = await spawnInPty(process.execPath, ["--input-type=module", "-e", echo], { cwd, env: process.env, harness: "claude", attachTerminal: false, pasteDelayMs: 200, onOutput: data => chunks.push(data) });
  t.after(async () => { pty.kill(); await pty.exit; await rm(cwd, { recursive: true, force: true }); });
  w.session.attachTui(pty);
  const until = async (ready, label) => { const deadline = Date.now() + 1500; while (!ready() && Date.now() < deadline) await sleep(5); assert.ok(ready(), label); };
  const hex = () => [...chunks.join("").matchAll(/HEX:([0-9a-f]+)/g)].map(m => m[1]).join("");
  await until(() => chunks.join("").includes("READY"), "owned PTY ready");
  w.send("cancel-owned", { deliveryMode: "steer" });
  await until(() => hex().includes(Buffer.from("cancel-owned").toString("hex")), "first owned paste reached actual PTY");
  w.permission();
  const pending = await w.stub.waitFor(f => f.type === "prompt.request");
  const beforeAnswer = hex();
  const answerFrom = w.stub.frames.length;
  w.stub.send({ type: "prompt.answer", sessionId: "owned-session", promptId: pending.promptId, value: "1" });
  w.stub.send({ type: "prompt.answer", sessionId: "owned-session", promptId: pending.promptId, value: "1" });
  w.stub.send({ type: "ping" }); await w.stub.waitFor(f => f.type === "pong", { from: answerFrom });
  await until(() => hex().length > beforeAnswer.length, "actual controller answer reached PTY public write");
  const answeredAt = Date.now();
  w.send("queued-after-cancel");
  await w.stub.waitFor(f => f.type === "turn.ack" && f.turnId === "queued-after-cancel");
  w.stub.send({ type: "turn.interrupt", turnId: "cancel-owned" });
  assert.equal((await w.finished("cancel-owned")).interrupted, true);
  const queued = await w.finished("queued-after-cancel");
  const facts = { queuedStarted: w.stub.frames.some(f => f.type === "turn.started" && f.turnId === "queued-after-cancel"), foreignWriteObserved: hex().includes(beforeAnswer + "31"), queuedPasteObserved: hex().includes(Buffer.from("queued-after-cancel").toString("hex")), undoObserved: hex().includes("1f") };
  assert.match(queued.error ?? "", /terminal.*draft/i, JSON.stringify(facts));
  assert.equal(w.stub.frames.some(f => f.type === "turn.started" && f.turnId === "queued-after-cancel"), false);
  assert.ok(hex().includes(beforeAnswer + "31"));
  await sleep(Math.max(0, answeredAt + 250 - Date.now()));
  assert.equal(hex().includes("0d"), false, "a delayed confirmation cannot submit the uncertain canceled editor");
  assert.equal(hex(), beforeAnswer + "31" + "1b", "duplicate same-ID answers produce exactly one PTY keypress and independent Stop");
  assert.equal(hex().includes(Buffer.from("queued-after-cancel").toString("hex")), false);
  assert.equal(hex().includes("1f"), false, "the foreign edit is never undone");
  const beforeStop = hex();
  w.stub.send({ type: "turn.interrupt", turnId: "cancel-owned" });
  await until(() => hex().length > beforeStop.length, "Stop remains available while latched without an active remote turn");
  assert.equal(hex(), beforeStop + "1b");
  w.events.emit("hook", { source: "claude", event: "UserPromptSubmit", payload: {} });
  assert.match(pty.inputBlockReason(), /terminal.*draft/i, "a late unscoped hook is not evidence of cleared input");
  w.send("steer-while-blocked", { deliveryMode: "steer" });
  assert.match((await w.finished("steer-while-blocked")).error, /terminal.*draft/i);
  assert.equal(hex().includes(Buffer.from("steer-while-blocked").toString("hex")), false);
  w.permission("Synthetic successor");
  const successor = await w.stub.waitFor(f => f.type === "prompt.request" && f.promptId !== pending.promptId);
  const staleFrom = w.stub.frames.length; const beforeStale = hex();
  w.stub.send({ type: "prompt.answer", sessionId: "owned-session", promptId: pending.promptId, value: "1" });
  w.stub.send({ type: "ping" }); await w.stub.waitFor(f => f.type === "pong", { from: staleFrom });
  // Observe delayed input as well as the synchronous WebSocket handler.
  await sleep(250);
  assert.equal(w.session.pending?.promptId, successor.promptId, "duplicate old answer cannot consume a successor");
  assert.equal(hex(), beforeStale, "old-ID replay writes no bytes into the successor dialog");
});


test("a question confirmation is scoped to its original prompt and operation", { timeout: 4000 }, async t => {
  const w = await world(t); const seen = new Set();
  const prompt = async () => {
    w.question();
    const next = await w.stub.waitFor(f => f.type === "prompt.request" && !seen.has(f.promptId)); seen.add(next.promptId); return next;
  };
  const answer = async p => { w.stub.send({ type: "prompt.answer", sessionId: "owned-session", promptId: p.promptId, value: "1" }); await w.stub.waitFor(f => f.resolvedPromptId === p.promptId); };
  await answer(await prompt());
  const next = await prompt();
  await sleep(220); assert.deepEqual(w.writes, ["1"], "old confirmation cannot answer a live successor dialog");
  await answer(next);
  await sleep(220); assert.deepEqual(w.writes, ["1", "1", "\r"], "ordinary current answer retains its confirmation");
  await answer(await prompt()); await answer(await prompt());
  await sleep(220); assert.deepEqual(w.writes, ["1", "1", "\r", "1", "1", "\r"], "a rapidly answered successor must not inherit the older confirmation timer");
  await answer(await prompt()); w.send("new-operation"); await w.started("new-operation");
  await sleep(220); assert.deepEqual(w.writes, ["1", "1", "\r", "1", "1", "\r", "1"], "old confirmation cannot submit into a new operation");
});

for (const menu of ["1. Yes\n2. No", "1. Yes\n2. Always allow\n3. No"]) {
  test(`Claude permissions use stable keys without delayed Enter (${menu.split("\n").length} options)`, { timeout: 8000 }, async t => {
    const w = await world(t);
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-permission-keys-"));
    const chunks = [];
    // Observed menu variants are synthetic fixtures. The production hook does
    // not provide that menu, so its unknown middle choices cannot be exposed.
    const echo = `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write(${JSON.stringify(menu + "\nREADY\n")});process.stdin.on("data",b=>process.stdout.write("HEX:"+b.toString("hex")+"\\n"));`;
    const pty = await spawnInPty(process.execPath, ["--input-type=module", "-e", echo], { cwd, env: process.env, harness: "claude", attachTerminal: false, onOutput: data => chunks.push(data) });
    t.after(async () => { pty.kill(); await pty.exit; await rm(cwd, { recursive: true, force: true }); });
    w.session.attachTui(pty);
    const until = async (ready, label) => { const deadline = Date.now() + 1500; while (!ready() && Date.now() < deadline) await sleep(5); assert.ok(ready(), label); };
    const hex = () => [...chunks.join("").matchAll(/HEX:([0-9a-f]+)/g)].map(m => m[1]).join("");
    await until(() => chunks.join("").includes("READY"), "actual PTY ready");
    const seen = new Set();
    const permission = async () => {
      w.permission();
      const prompt = await w.stub.waitFor(f => f.type === "prompt.request" && !seen.has(f.promptId)); seen.add(prompt.promptId);
      assert.deepEqual(prompt.options, [{ id: "1", label: "Yes once" }, { id: "cancel", label: "Cancel" }]);
      assert.equal("inputOrigin" in prompt, false, "opaque origin stays local");
      return prompt;
    };
    const answer = async (prompt, value) => {
      const from = w.stub.frames.length;
      w.stub.send({ type: "prompt.answer", sessionId: "owned-session", promptId: prompt.promptId, value });
      w.stub.send({ type: "ping" }); await w.stub.waitFor(f => f.type === "pong", { from });
    };
    const first = await permission();
    await answer(first, "3"); await answer(first, "2");
    assert.equal(w.session.pending?.promptId, first.promptId, "unadvertised numeric choices remain refused");
    assert.equal(hex(), "");
    await answer(first, "cancel"); await answer(first, "cancel");
    const successor = await permission();
    await answer(first, "cancel"); await sleep(250);
    assert.equal(hex(), "1b", "Cancel is one Escape; no Enter can approve a successor");
    assert.equal(w.session.pending?.promptId, successor.promptId);
    await answer(successor, "1"); await answer(successor, "1");
    await until(() => hex().length >= 4, "allow key observed");
    // Native can open a successor before a delayed Notification hook arrives.
    await sleep(250);
    assert.equal(hex(), "1b31", "Yes once is self-confirming; duplicates and delayed Enter add no input");
    const questionFrom = w.stub.frames.length;
    w.question();
    const question = await w.stub.waitFor(f => f.type === "prompt.request", { from: questionFrom });
    await answer(question, "1"); await sleep(250);
    assert.equal(hex(), "1b31310d", "ordinary question confirmation remains available");
  });
}

test("permission Cancel marks the active turn interrupted and preserves independent Stop", { timeout: 5000 }, async t => {
  const w = await world(t);
  w.send("active"); await w.started("active");
  w.permission();
  const prompt = await w.stub.waitFor(f => f.type === "prompt.request");
  w.send("retained"); await w.stub.waitFor(f => f.type === "turn.ack" && f.turnId === "retained");
  w.stub.send({ type: "prompt.answer", promptId: prompt.promptId, value: "cancel" });
  await w.stub.waitFor(f => f.resolvedPromptId === prompt.promptId);
  assert.equal(w.interrupts(), 1, "Cancel uses the ordinary physical interrupt path");
  w.quiet(); assert.equal((await w.finished("active")).interrupted, true);
  await w.started("retained"); w.busy();
  w.stub.send({ type: "turn.interrupt", turnId: "retained" });
  await sleep(30); assert.equal(w.interrupts(), 2, "independent Stop still targets the successor");
  w.quiet(); assert.equal((await w.finished("retained")).interrupted, true);
});

test("unbound and old-operation permission notifications cannot expose a successor dialog", { timeout: 5000 }, async t => {
  const w = await world(t);
  w.events.emit("hook", { source: "claude", event: "Notification", payload: { session_id: "11111111-1111-4111-8111-111111111111", notification_type: "permission_prompt" } });
  w.stub.send({ type: "ping" }); await w.stub.waitFor(f => f.type === "pong");
  assert.equal(w.stub.frames.some(f => f.type === "prompt.request"), false, "a notification alone proves no live operation");
  w.send("old"); await w.started("old");
  const oldTool = w.permissionPayload();
  w.events.emit("hook", { source: "claude", event: "PreToolUse", payload: oldTool });
  w.send("successor", { deliveryMode: "steer" }); await w.started("successor");
  w.events.emit("hook", { source: "claude", event: "PermissionRequest", payload: oldTool });
  const notification = { session_id: oldTool.session_id, notification_type: "permission_prompt" };
  w.events.emit("hook", { source: "claude", event: "Notification", payload: notification });
  w.events.emit("hook", { source: "claude", event: "UserPromptSubmit", payload: {} });
  w.events.emit("hook", { source: "claude", event: "Notification", payload: notification });
  w.question(); w.question([]);
  const from = w.stub.frames.length;
  w.stub.send({ type: "prompt.answer", promptId: "old-unbound", value: "cancel" });
  w.stub.send({ type: "ping" }); await w.stub.waitFor(f => f.type === "pong", { from });
  assert.equal(w.stub.frames.some(f => f.type === "prompt.request"), false, "late and post-steer terminal dialogs stay device-only");
  assert.deepEqual(w.writes, []); assert.equal(w.interrupts(), 0);
  w.stub.send({ type: "turn.interrupt", turnId: "successor" });
  await sleep(30); assert.equal(w.interrupts(), 1, "dialog refusal never disables independent Stop");
});

test("a captured permission operation cannot publish after a failed steer restores its predecessor", { timeout: 5000 }, async t => {
  let fail;
  const w = await world(t, { inject: (_text, mode) => mode === "steer" ? new Promise((_resolve, reject) => { fail = reject; }) : undefined });
  w.send("old"); await w.started("old"); w.send("failed", { deliveryMode: "steer" });
  const deadline = Date.now() + 1000;
  while (!fail && Date.now() < deadline) await sleep(5);
  assert.ok(fail);
  const tool = w.permissionPayload();
  w.events.emit("hook", { source: "claude", event: "PreToolUse", payload: tool });
  fail(new Error("synthetic pre-submit failure")); await w.finished("failed");
  w.events.emit("hook", { source: "claude", event: "PermissionRequest", payload: tool });
  w.events.emit("hook", { source: "claude", event: "Notification", payload: { session_id: tool.session_id, notification_type: "permission_prompt" } });
  const from = w.stub.frames.length; w.stub.send({ type: "ping" }); await w.stub.waitFor(f => f.type === "pong", { from });
  assert.equal(w.stub.frames.some(f => f.type === "prompt.request"), false, "token receipt cannot reassign its captured operation origin");
  assert.deepEqual(w.writes, []); assert.equal(w.interrupts(), 0);
});

for (const kind of ["permission", "choice", "question"]) {
  test(`${kind} answer snapshots cannot cross a failed-steer operation`, { timeout: 5000 }, async t => {
    let fail;
    const w = await world(t, { inject: (_text, mode) => mode === "steer" ? new Promise((_resolve, reject) => { fail = reject; }) : undefined });
    w.send("old"); await w.started("old");
    w.send("failed-steer", { deliveryMode: "steer" });
    const deadline = Date.now() + 1000;
    while (!fail && Date.now() < deadline) await sleep(5);
    assert.ok(fail, "steering paste reached controlled operation");
    if (kind === "permission") w.permission(); else w.question(kind === "question" ? [] : undefined);
    const prompt = await w.stub.waitFor(f => f.type === "prompt.request");
    fail(new Error("synthetic pre-submit failure"));
    assert.match((await w.finished("failed-steer")).error, /synthetic/);
    w.send("answer-rebound", { kind: "answer", answer: { promptId: prompt.promptId, value: kind === "question" ? "synthetic text" : "1" } });
    assert.match((await w.finished("answer-rebound")).error, /changed on the device/i);
    assert.deepEqual(w.writes, []); assert.equal(w.interrupts(), 0);
  });

  test(`${kind} actions are refused after successful steering even with a matching origin`, { timeout: 5000 }, async t => {
    let submit;
    const w = await world(t, { inject: (_text, mode) => mode === "steer" ? new Promise(resolve => { submit = resolve; }) : undefined });
    w.send("steer", { deliveryMode: "steer" });
    const deadline = Date.now() + 1000;
    while (!submit && Date.now() < deadline) await sleep(5);
    assert.ok(submit);
    if (kind === "permission") w.permission(); else w.question(kind === "question" ? [] : undefined);
    const prompt = await w.stub.waitFor(f => f.type === "prompt.request");
    submit(); await w.started("steer");
    w.send("answer-post-steer", { kind: "answer", answer: { promptId: prompt.promptId, value: kind === "question" ? "synthetic text" : "1" } });
    assert.match((await w.finished("answer-post-steer")).error, /changed on the device/i);
    assert.deepEqual(w.writes, []); assert.equal(w.interrupts(), 0);
  });
}

test("an unadvertised permission choice has an accurate error and leaves the prompt live", async t => {
  const w = await world(t); w.permission();
  const prompt = await w.stub.waitFor(f => f.type === "prompt.request");
  w.send("refused-choice", { kind: "answer", answer: { promptId: prompt.promptId, value: "3" } });
  assert.match((await w.finished("refused-choice")).error, /offered permission options/i);
  assert.equal(w.session.pending.promptId, prompt.promptId);
  assert.deepEqual(w.writes, []); assert.equal(w.interrupts(), 0);
});
