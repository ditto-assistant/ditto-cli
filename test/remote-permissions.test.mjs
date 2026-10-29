import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureClaudeToolResultAnchor, readClaudeToolResults } from "../dist/remote/claude-tool-results.js";
import { RemoteSession } from "../dist/remote/controller.js";
import { startHostStub } from "./helpers/host-stub.mjs";

const native = "11111111-1111-4111-8111-111111111111";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = (id, isError = false, sessionId = native) => JSON.stringify({ type: "user", sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "private tool output" }] } }) + "\n";

async function transcript(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-permission-"));
  const config = path.join(root, "config"); const project = path.join(config, "projects", "owned-project");
  await mkdir(project, { recursive: true });
  const file = path.join(project, native + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "assistant", sessionId: native }) + "\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config, project, file };
}

test("tool-result reader accepts only new complete exact-session/ID user metadata", async t => {
  const f = await transcript(t);
  await appendFile(f.file, result("same-id"));
  const anchor = await captureClaudeToolResultAnchor(f.file, native, f.config); assert.ok(anchor);
  assert.deepEqual(await readClaudeToolResults(anchor, ["same-id"]), [], "old result before capture cannot resolve a new permission");
  await appendFile(f.file, result("other-id") + result("same-id", true, "22222222-2222-4222-8222-222222222222"));
  const sidechain = JSON.parse(result("same-id")); sidechain.isSidechain = true;
  await appendFile(f.file, JSON.stringify(sidechain) + "\n" + JSON.stringify({ type: "assistant", sessionId: native, message: { role: "assistant", content: [{ type: "tool_result", tool_use_id: "same-id" }] } }) + "\n");
  assert.deepEqual(await readClaudeToolResults(anchor, ["same-id"]), []);
  const complete = result("same-id", true);
  await appendFile(f.file, complete.slice(0, -1));
  assert.deepEqual(await readClaudeToolResults(anchor, ["same-id"]), [], "incomplete append is not evidence");
  await appendFile(f.file, "\n");
  assert.deepEqual(await readClaudeToolResults(anchor, ["same-id"]), [{ toolUseId: "same-id", isError: true }]);
});

test("tool-result anchor refuses path escape, symlinks, rewrites and file replacement", async t => {
  const f = await transcript(t);
  const outside = path.join(f.root, native + ".jsonl"); await writeFile(outside, result("id"));
  assert.equal(await captureClaudeToolResultAnchor(outside, native, f.config), undefined);
  const anchor = await captureClaudeToolResultAnchor(f.file, native, f.config); assert.ok(anchor);
  const original = await readFile(f.file);
  await rename(f.file, f.file + ".old"); await writeFile(f.file, Buffer.concat([original, Buffer.from(result("id"))]));
  assert.deepEqual(await readClaudeToolResults(anchor, ["id"]), [], "same-name replacement has a different identity");
  await rm(f.file); await symlink(outside, f.file);
  assert.equal(await captureClaudeToolResultAnchor(f.file, native, f.config), undefined);
  await rm(f.file); await writeFile(f.file, "X".repeat(100) + "\n");
  const rewritten = await captureClaudeToolResultAnchor(f.file, native, f.config); assert.ok(rewritten);
  await writeFile(f.file, "Y".repeat(100) + "\n" + result("id"));
  assert.deepEqual(await readClaudeToolResults(rewritten, ["id"]), [], "rewritten capture boundary is not an append");
});

test("tool-result reader stays bounded and fails closed on an oversized matching row", async t => {
  const f = await transcript(t); const anchor = await captureClaudeToolResultAnchor(f.file, native, f.config); assert.ok(anchor);
  await appendFile(f.file, JSON.stringify({ type: "user", sessionId: native, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "huge", content: "x".repeat(300000) }] } }) + "\n");
  assert.deepEqual(await readClaudeToolResults(anchor, ["huge"]), []);
  await appendFile(f.file, result("tail"));
  assert.deepEqual(await readClaudeToolResults(anchor, ["tail"]), [{ toolUseId: "tail", isError: false }]);
});

async function world(t) {
  const f = await transcript(t); const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, DITTO_CONFIG_DIR: process.env.DITTO_CONFIG_DIR };
  process.env.CLAUDE_CONFIG_DIR = f.config; process.env.DITTO_CONFIG_DIR = path.join(f.root, "ditto");
  const stub = await startHostStub(); const events = new EventEmitter(); let quiet = 0; let interrupts = 0;
  const session = new RemoteSession({ harness: "claude", sessionId: native, cwd: f.root, mode: "tui", baseUrl: stub.base, apiKey: "ditto_mcp_test", quietFallbackMs: 100, log() {} }, { events });
  session.attachTui({ pid: 1, write() {}, inject: async () => {}, interrupt() { interrupts++; }, quietFor: () => quiet, exit: new Promise(() => {}), kill() {} });
  t.after(async () => { session.stop(); await stub.close(); for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await session.start();
  const hook = (event, payload = {}) => events.emit("hook", { source: "claude", event, payload: { session_id: native, ...payload } });
  const payload = id => ({ tool_name: "Bash", tool_input: { command: "synthetic", description: "fixture" }, tool_use_id: id, transcript_path: f.file });
  const pre = async id => {
    hook("PreToolUse", payload(id));
    // Fence actual filesystem capture, not a mocked lifecycle completion.
    await Promise.all([...session.claudePermissions.operations.values()].map(operation => operation.anchor));
  };
  const permission = async id => { await pre(id); hook("PermissionRequest", payload(id)); hook("Notification", { notification_type: "permission_prompt" }); return stub.waitFor(frame => frame.type === "prompt.request"); };
  const send = (id, deliveryMode) => stub.send({ type: "turn.deliver", sessionId: native, turnId: id, text: "synthetic input", ...(deliveryMode ? { deliveryMode } : {}) });
  const started = id => stub.waitFor(frame => frame.type === "turn.started" && frame.turnId === id);
  return { ...f, session, stub, hook, pre, payload, permission, send, started, quiet: () => { quiet = Infinity; }, busy: () => { quiet = 0; }, interrupts: () => interrupts };
}

test("observed native 2.1.312 builtin lifecycle without UserPromptSubmit does not hold FIFO", { timeout: 3000 }, async t => {
  const w = await world(t);
  // Actual /model then /clear observation: no UserPromptSubmit or provider call.
  w.hook("SessionStart", { source: "startup" }); w.hook("SessionEnd"); w.hook("SessionStart", { source: "clear" });
  w.send("after-builtin"); await w.started("after-builtin");
});

test("correlated PostToolUse releases a terminal-answered permission after steering; stale Stop does not", { timeout: 6000 }, async t => {
  const w = await world(t); w.send("steer", "steer"); await w.started("steer"); w.hook("UserPromptSubmit");
  const pending = await w.permission("allow-id"); w.send("queued"); w.quiet(); w.hook("Stop");
  await sleep(350); assert.equal(w.stub.frames.some(f => f.type === "turn.started" && f.turnId === "queued"), false);
  w.hook("PostToolUse", w.payload("wrong-id")); await sleep(150);
  assert.equal(w.stub.frames.some(f => f.resolvedPromptId === pending.promptId), false);
  w.hook("PostToolUse", { ...w.payload("allow-id"), agent_id: "subagent-other" }); await sleep(100);
  assert.equal(w.stub.frames.some(f => f.resolvedPromptId === pending.promptId), false);
  w.hook("PostToolUse", { ...w.payload("allow-id"), tool_input: { description: "fixture", command: "synthetic" } }); await w.started("queued");
  assert.ok(w.stub.frames.some(f => f.type === "session.status" && f.resolvedPromptId === pending.promptId));
  assert.equal(w.interrupts(), 0, "permission recovery never sends a physical key");
});

test("native No tool_result releases only the exact current input epoch", { timeout: 7000 }, async t => {
  const w = await world(t); w.send("steer", "steer"); await w.started("steer"); w.hook("UserPromptSubmit");
  await w.pre("old-id"); w.hook("UserPromptSubmit"); const pending = await w.permission("deny-id");
  w.send("queued"); w.quiet(); w.hook("Stop"); w.hook("PostToolUse", w.payload("old-id"));
  await appendFile(w.file, result("old-id", true)); await sleep(700);
  assert.equal(w.stub.frames.some(f => f.resolvedPromptId === pending.promptId), false);
  assert.equal(w.stub.frames.some(f => f.type === "turn.started" && f.turnId === "queued"), false);
  await appendFile(w.file, result("deny-id", true)); await w.started("queued");
  assert.ok(w.stub.frames.some(f => f.resolvedPromptId === pending.promptId));
});

test("PermissionRequest holds FIFO before notification and resolved IDs replay after reconnect", { timeout: 8000 }, async t => {
  const w = await world(t); w.send("steer", "steer"); await w.started("steer"); w.hook("UserPromptSubmit");
  await w.pre("early-id"); w.hook("PermissionRequest", w.payload("early-id")); w.send("queued"); w.quiet(); w.hook("Stop");
  await sleep(350); assert.equal(w.stub.frames.some(f => f.type === "turn.started" && f.turnId === "queued"), false, "a native dialog is live before its delayed notification");
  w.hook("Notification", { notification_type: "permission_prompt" });
  const pending = await w.stub.waitFor(f => f.type === "prompt.request");
  await appendFile(w.file, result("early-id", true)); await w.started("queued");
  const from = w.stub.frames.length; w.stub.dropClients();
  await w.stub.waitFor(f => f.type === "session.status" && f.resolvedPromptId === pending.promptId, { from });
});

test("local permission completion rearms quiet fallback without overtaking TTY activity or a later tool", { timeout: 7000 }, async t => {
  const w = await world(t); w.hook("UserPromptSubmit"); const pending = await w.permission("local-id");
  w.send("queued"); w.quiet(); await sleep(350);
  assert.equal(w.stub.frames.some(f => f.type === "turn.started"), false, "still-live dialog holds FIFO even on a quiet screen");
  w.busy(); await appendFile(w.file, result("local-id", true));
  await w.stub.waitFor(f => f.resolvedPromptId === pending.promptId); await sleep(350);
  assert.equal(w.stub.frames.some(f => f.type === "turn.started"), false, "TTY activity must prevent quiet release");
  await w.pre("later-tool"); w.quiet(); await sleep(350);
  assert.equal(w.stub.frames.some(f => f.type === "turn.started"), false, "a later tool must hold the timer");
  w.hook("PostToolUse", w.payload("later-tool")); await w.started("queued");
});

test("ambiguous parallel tool inputs fail closed until an explicit answer", { timeout: 6000 }, async t => {
  const w = await world(t); w.send("steer", "steer"); await w.started("steer"); w.hook("UserPromptSubmit");
  await w.pre("one"); await w.pre("two"); w.hook("PermissionRequest", w.payload("one")); w.hook("Notification", { notification_type: "permission_prompt" });
  const pending = await w.stub.waitFor(f => f.type === "prompt.request"); w.send("queued"); w.quiet();
  await appendFile(w.file, result("one") + result("two")); w.hook("PostToolUse", w.payload("one")); w.hook("Stop"); await sleep(700);
  assert.equal(w.stub.frames.some(f => f.type === "turn.started" && f.turnId === "queued"), false);
  w.stub.send({ type: "prompt.answer", sessionId: native, promptId: pending.promptId, value: "1" }); await w.started("queued");
});


test("incomplete AskUserQuestion cannot discard an existing answerable permission token", { timeout: 6000 }, async t => {
  const w = await world(t); w.send("steer", "steer"); await w.started("steer"); w.hook("UserPromptSubmit");
  // Ambiguous metadata requires the original explicit answer to release FIFO.
  await w.pre("one"); await w.pre("two");
  w.hook("PermissionRequest", w.payload("one"));
  w.hook("Notification", { notification_type: "permission_prompt" });
  const pending = await w.stub.waitFor(f => f.type === "prompt.request");
  w.send("queued"); w.quiet();
  w.hook("PreToolUse", { tool_name: "AskUserQuestion", tool_input: {} });
  w.stub.send({ type: "prompt.answer", sessionId: native, promptId: pending.promptId, value: "1" });
  await w.started("queued");
  assert.ok(w.stub.frames.some(f => f.resolvedPromptId === pending.promptId));
});

test("a usable replacement prompt is sent without inventing resolution of the old dialog", { timeout: 6000 }, async t => {
  const w = await world(t); w.hook("UserPromptSubmit");
  const first = await w.permission("original-permission");
  w.hook("PreToolUse", {
    ...w.payload("replacement-question"), tool_name: "AskUserQuestion",
    tool_input: { questions: [{ header: "Synthetic choice", question: "Which fixture?", options: [{ label: "Next" }] }] },
  });
  const next = await w.stub.waitFor(f => f.type === "prompt.request" && f.promptId !== first.promptId);
  assert.equal(next.kind, "choice"); assert.equal(next.text, "Synthetic choice: Which fixture?");
  assert.equal(next.options[0].label, "Next");
  assert.equal(w.stub.frames.some(f => f.resolvedPromptId === first.promptId), false, "a replacement is not an authoritative tool outcome");
  w.stub.send({ type: "prompt.answer", sessionId: native, promptId: first.promptId, value: "1" });
  w.stub.send({ type: "ping" }); await w.stub.waitFor(f => f.type === "pong");
  assert.equal(w.session.pending?.promptId, next.promptId, "answer to the old ID cannot consume the current question");
  w.stub.send({ type: "prompt.answer", sessionId: native, promptId: next.promptId, value: "1" });
  await w.stub.waitFor(f => f.resolvedPromptId === next.promptId);
  assert.equal(w.stub.frames.some(f => f.resolvedPromptId === first.promptId), false);
});
