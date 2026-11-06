import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boundTrace, freezeAgentTrace, MAX_STEPS, MAX_STEPS_BYTES, readAgentTrace } from "../dist/review-trace.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO = { id: "33333333-3333-3333-3333-333333333333", fullName: "acme/project", enabled: true };
const RUN = "55555555-5555-5555-5555-555555555555";

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ditto-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const jsonl = rows => rows.map(r => JSON.stringify(r)).join("\n") + "\n";

const claudeSession = jsonl([
  { type: "custom-title", title: "x" },
  { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>meta</local-command-caveat>" } },
  { type: "user", message: { role: "user", content: "Implement DITTO-2434: block on unmet scope.\n<system-reminder>ignore me</system-reminder>" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Reading the  verdict\ncode." }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "pkg/verdict.go", old_string: "a", new_string: "b" } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
  { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "go test ./..." } }] } },
  { type: "user", message: { role: "user", content: "Also add the CLI flag." } },
]);

const codexRollout = jsonl([
  { type: "session_meta", payload: { id: "s" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix OPS-9 retries" }] } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<b>also</b> keep the logs" }] } },
  { type: "response_item", payload: { type: "reasoning", summary: [] } },
  { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["go", "test"] , cmd: "go test ./webhooks" }) } },
  { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: webhooks/retry.go" } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
]);

test("reads a Claude Code session: first real prompt, assistant text and tool calls, no thinking or sidechains", async t => {
  const dir = await tmp(t);
  const file = path.join(dir, "session.jsonl");
  await writeFile(file, claudeSession + '{"type":"assistant","message":{"content":[{"type":"text","text":"tor');
  const before = await stat(file);
  const trace = await readAgentTrace(file);
  assert.equal(trace.format, "claude-code");
  assert.equal(trace.initialPrompt, "Implement DITTO-2434: block on unmet scope.");
  assert.deepEqual(trace.steps, ["said: Reading the verdict code.", "tool Edit: file_path=pkg/verdict.go", "tool Bash: command=go test ./...", "user: Also add the CLI flag."]);
  // Read only: the agent's trace is left exactly as it was.
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await readFile(file, "utf8")).startsWith(claudeSession), true);
});

test("reads a Codex rollout, skipping injected AGENTS.md and environment turns", async t => {
  const dir = await tmp(t);
  const file = path.join(dir, "rollout.jsonl");
  await writeFile(file, codexRollout);
  const trace = await readAgentTrace(file);
  assert.equal(trace.format, "codex");
  assert.equal(trace.initialPrompt, "Fix OPS-9 retries");
  assert.deepEqual(trace.steps, ["user: <b>also</b> keep the logs", "tool shell: cmd=go test ./webhooks", "tool apply_patch: *** Begin Patch *** Update File: webhooks/retry.go", "said: Done."]);
});

test("reads the generic {initialPrompt, steps} JSON and rejects files with no prompt", async t => {
  const dir = await tmp(t);
  const generic = path.join(dir, "trace.json");
  await writeFile(generic, JSON.stringify({ format: "my-agent", initialPrompt: "Do DITTO-1", steps: ["edited a.go", 3, "ran\ntests"] }, null, 2));
  assert.deepEqual(await readAgentTrace(generic), { format: "my-agent", initialPrompt: "Do DITTO-1", steps: ["edited a.go", "ran tests"] });
  const empty = path.join(dir, "empty.jsonl");
  await writeFile(empty, jsonl([{ type: "assistant", message: { content: [{ type: "text", text: "no prompt" }] } }]));
  await assert.rejects(readAgentTrace(empty), /user prompt/);
  await assert.rejects(readAgentTrace(dir), /must name a file/);
});

test("long traces keep their first and last steps within the backend bounds", () => {
  const steps = Array.from({ length: 2000 }, (_, i) => `step ${i} ` + "x".repeat(200));
  const trace = boundTrace("claude-code", "p".repeat(20000), steps);
  assert.equal(trace.truncated, true);
  assert.ok(trace.steps.length <= MAX_STEPS);
  assert.ok(trace.steps.reduce((n, s) => n + Buffer.byteLength(s), 0) <= MAX_STEPS_BYTES);
  assert.match(trace.steps[0], /^step 0 /);
  assert.match(trace.steps.at(-1), /^step 1999 /);
  assert.ok(Buffer.byteLength(trace.initialPrompt) <= 16000);
  assert.equal(boundTrace("x", "p", ["a"]).truncated, undefined);
  // A multi-byte step is cut on a code point boundary.
  const cut = boundTrace("x", "p", ["é".repeat(3000)]).steps[0];
  assert.ok(Buffer.byteLength(cut) <= 2048 && !cut.includes("�"));
});

function git(cwd, ...args) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(out.status, 0, out.stderr);
}

async function stub(t, verdict) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      calls.push({ url: req.url, body: parsed });
      const json = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.url === "/api/v5/review") return json(200, { repositories: [REPO] });
      const admitted = calls.find(c => c.url === `/api/v5/review/repositories/${REPO.id}/local`)?.body;
      if (req.url === `/api/v5/review/repositories/${REPO.id}/local`) return json(202, { runId: RUN, status: "queued", profile: "quick", snapshotDigest: parsed.snapshot.digest, budgetCents: 25, maxSeconds: 90 });
      if (req.url === `/api/v5/review/local/runs/${RUN}`) {
        return json(200, { runId: RUN, status: "completed", profile: "quick", snapshotDigest: admitted.snapshot.digest, budgetCents: 25, maxSeconds: 90, result: {
          complete: true, findings: [], local: { contextComplete: true },
          scope: { source: "jira", key: "DITTO-2434", status: "checked", items: [
            { scope_item: "Emit per-item results", evidence_refs: ["app.ts:1"], met: true, required: true },
            { scope_item: "Exit non-zero on request changes", evidence_refs: [], met: false, required: true, reason: "No exit code change." },
            { scope_item: "Ship within two weeks", evidence_refs: [], met: false, required: false, reason: "A timeline." },
          ] },
          verdict,
        } });
      }
      json(404, { message: "unexpected route" });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

function run(root, base, args) {
  const child = spawn(process.execPath, [cli, "review", ...args], { cwd: root, env: { ...process.env, DITTO_API_KEY: "ditto_mcp_fixture", DITTO_API_BASE: base, DITTO_CONFIG_DIR: path.join(root, ".tmp", "config") }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

async function checkout(t) {
  const root = await tmp(t);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Review fixture"); git(root, "config", "user.email", "review@example.test");
  git(root, "remote", "add", "origin", "git@github.com:acme/project.git");
  await writeFile(path.join(root, "app.ts"), "export const count = 1;\n");
  git(root, "add", "."); git(root, "commit", "-m", "fixture");
  await writeFile(path.join(root, "app.ts"), "export const count = 2;\n");
  return root;
}

test("--trace and --issue reach the review, and an unmet written requirement exits 2 quoting it", async t => {
  const root = await checkout(t);
  const traceDir = await tmp(t);
  const traceFile = path.join(traceDir, "session.jsonl");
  await writeFile(traceFile, claudeSession);
  const service = await stub(t, { event: "REQUEST_CHANGES", blockingSeverity: "high", blockingFindings: 0, scopeKey: "DITTO-2434", scopeUnmet: [{ scope_item: "Exit non-zero on request changes", met: false, required: true }] });
  const out = await run(root, service.base, ["local", "--trace", traceFile, "--issue", "ditto-2434"]);
  assert.equal(out.code, 2, out.stderr);
  const admitted = service.calls.find(c => c.url.endsWith("/local")).body;
  assert.equal(admitted.issueKey, "DITTO-2434");
  assert.equal(admitted.trace.format, "claude-code");
  assert.equal(admitted.trace.initialPrompt, "Implement DITTO-2434: block on unmet scope.");
  assert.match(out.stdout, /Linked issue DITTO-2434: 1 of 2 written requirements met/);
  assert.match(out.stdout, /✗ Exit non-zero on request changes\n {6}No exit code change\./);
  assert.match(out.stdout, /- Ship within two weeks/);
  assert.match(out.stdout, /Verdict: changes requested — 1 written requirement of DITTO-2434 not met/);
  assert.match(out.stdout, /missing: "Exit non-zero on request changes"/);
  // The trace is still there, unchanged.
  assert.equal(await readFile(traceFile, "utf8"), claudeSession);
});

test("an approved local review exits 0; without --trace or --issue nothing new is sent", async t => {
  const root = await checkout(t);
  const service = await stub(t, { event: "APPROVE", blockingSeverity: "high", blockingFindings: 0 });
  const out = await run(root, service.base, ["local"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Verdict: approved/);
  const admitted = service.calls.find(c => c.url.endsWith("/local")).body;
  assert.equal("issueKey" in admitted, false);
  assert.equal("trace" in admitted, false);
  const bad = await run(root, service.base, ["local", "--issue", "not a key"]);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /--issue must be an issue key/);
});

test("preview reports the trace without uploading it", async t => {
  const root = await checkout(t);
  const traceDir = await tmp(t);
  const traceFile = path.join(traceDir, "rollout.jsonl");
  await writeFile(traceFile, codexRollout);
  const out = await run(root, "http://127.0.0.1:9", ["local", "--preview", "--trace", traceFile, "--output", "json"]);
  assert.equal(out.code, 0, out.stderr);
  const preview = JSON.parse(out.stdout);
  assert.deepEqual(preview.trace, { format: "codex", promptBytes: 17, steps: 4, truncated: false });
});

test("null content blocks are skipped and a Codex local shell call keeps its command", async t => {
  const dir = await tmp(t);
  const claude = path.join(dir, "claude.jsonl");
  await writeFile(claude, jsonl([
    { type: "user", message: { role: "user", content: [null, 7, { type: "text", text: "Do DITTO-9" }] } },
    { type: "assistant", message: { role: "assistant", content: [null, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
  ]));
  const a = await readAgentTrace(claude);
  assert.equal(a.initialPrompt, "Do DITTO-9");
  assert.deepEqual(a.steps, ["tool Bash: command=ls"]);
  const rollout = path.join(dir, "codex.jsonl");
  await writeFile(rollout, jsonl([
    { type: "response_item", payload: { type: "message", role: "user", content: [null, { type: "input_text", text: "Fix it" }] } },
    { type: "response_item", payload: { type: "local_shell_call", action: { type: "exec", command: ["go", "test", "./..."] } } },
  ]));
  const b = await readAgentTrace(rollout);
  assert.equal(b.initialPrompt, "Fix it");
  assert.deepEqual(b.steps, ["tool local_shell_call: command=go test ./..."]);
});

test("generic JSON needs a non-empty prompt and a string format", async t => {
  const dir = await tmp(t);
  const empty = path.join(dir, "empty.json");
  await writeFile(empty, JSON.stringify({ initialPrompt: "  ", format: 123 }));
  await assert.rejects(readAgentTrace(empty), /user prompt/);
  const odd = path.join(dir, "odd.json");
  await writeFile(odd, JSON.stringify({ initialPrompt: "Do it", format: 123 }));
  assert.equal((await readAgentTrace(odd)).format, "json");
  await writeFile(odd, JSON.stringify({ initialPrompt: "Do it", format: "x".repeat(80) }));
  assert.equal((await readAgentTrace(odd)).format.length, 40);
});

test("verbose early steps cannot crowd out the session's ending", () => {
  const steps = [...Array.from({ length: 150 }, (_, i) => `early ${i} ` + "x".repeat(2000)), ...Array.from({ length: 30 }, (_, i) => `late ${i}`)];
  const trace = boundTrace("x", "p", steps);
  assert.equal(trace.truncated, true);
  assert.ok(trace.steps.reduce((n, s) => n + Buffer.byteLength(s), 0) <= MAX_STEPS_BYTES);
  assert.match(trace.steps[0], /^early 0 /);
  assert.equal(trace.steps.at(-1), "late 29");
  assert.ok(trace.steps.includes("late 0"));
});

test("a frozen trace re-reads to exactly the trace that was sent", async t => {
  const long = boundTrace("claude-code", "Do DITTO-2434 <x>", Array.from({ length: 900 }, (_, i) => `step ${i} ` + "y".repeat(100)));
  assert.equal(long.truncated, true);
  const id = `test-${process.pid}-${Date.now()}`;
  const file = await freezeAgentTrace(long, id);
  t.after(() => rm(path.dirname(file), { recursive: true, force: true }));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readAgentTrace(file), long);
  // Each freeze is its own private file; another one never touches this one.
  const other = await freezeAgentTrace({ format: "x", initialPrompt: "other", steps: [] }, id);
  t.after(() => rm(path.dirname(other), { recursive: true, force: true }));
  assert.notEqual(other, file);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(await readAgentTrace(file), long);
});

test("non-string text blocks are skipped and cleaned steps re-read identically", async t => {
  const dir = await tmp(t);
  const file = path.join(dir, "s.jsonl");
  await writeFile(file, jsonl([
    { type: "user", message: { role: "user", content: [{ type: "text", text: 42 }, { type: "text", text: "Do it" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: { x: 1 } }, { type: "tool_use", name: "Bash", input: { command: "a <system-reminder>r</system-reminder> b" } }] } },
  ]));
  const trace = await readAgentTrace(file);
  assert.equal(trace.initialPrompt, "Do it");
  assert.deepEqual(trace.steps, ["tool Bash: command=a b"]);
  const frozen = await freezeAgentTrace(trace, "replay");
  t.after(() => rm(path.dirname(frozen), { recursive: true, force: true }));
  assert.deepEqual(await readAgentTrace(frozen), trace);
});
