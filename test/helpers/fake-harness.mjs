import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fake `claude` and `codex` binaries for Remote Control tests. They behave
 * like the real TUIs where it matters to the host: raw-mode stdin, bracketed
 * paste + Enter submits a prompt, Esc (Claude) / Ctrl+C (Codex) interrupts a
 * running turn, Ctrl+C when idle exits; and they run the same hooks the real
 * harnesses run — Claude's `--settings` hooks (UserPromptSubmit, Stop,
 * Notification) with the JSON payload on stdin, Codex's `-c notify=[…]`
 * command with the JSON payload as the last argument.
 *
 * Headless: `claude -p` prints stream-json lines and exits; `codex exec`
 * prints one line and exits. Every invocation and every submitted prompt is
 * appended to FAKE_HARNESS_LOG as JSON lines.
 *
 * A prompt containing "[ask]" makes fake Claude raise a permission prompt
 * mid-turn (Notification hook, notification_type permission_prompt) and wait
 * for a digit keystroke before finishing the turn. FAKE_TURN_MS sets the turn
 * duration (default 300 ms).
 */

const FAKE = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const bin = process.argv[2];
const args = process.argv.slice(3);
const turnMs = Number(process.env.FAKE_TURN_MS || 300);
const record = (entry) => appendFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify({ bin, ...entry }) + "\n");

function claudeHooks() {
  const i = args.indexOf("--settings");
  if (i === -1) return {};
  try {
    const settings = JSON.parse(args[i + 1]);
    const out = {};
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      out[event] = groups.flatMap((g) => g.hooks.map((h) => h.command));
    }
    return out;
  } catch {
    return {};
  }
}

function codexNotify() {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c" && args[i + 1]?.startsWith("notify=")) {
      try {
        return JSON.parse(args[i + 1].slice("notify=".length));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function runClaudeHook(hooks, event, payload) {
  return Promise.all(
    (hooks[event] ?? []).map(
      (command) =>
        new Promise((resolve) => {
          const child = spawn("sh", ["-c", command], { stdio: ["pipe", "ignore", "ignore"] });
          child.on("exit", resolve);
          child.on("error", resolve);
          child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "fake", ...payload }));
        }),
    ),
  );
}

function runCodexNotify(notify, payload) {
  if (!notify || notify.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn(notify[0], [...notify.slice(1), JSON.stringify(payload)], { stdio: "ignore" });
    child.on("exit", resolve);
    child.on("error", resolve);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function headless() {
  if (bin === "claude") {
    const prompt = args[args.indexOf("-p") + 1];
    record({ mode: "headless", args, prompt });
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake" }) + "\n");
    await sleep(turnMs);
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fake answer to " + prompt }] } }) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "done: " + prompt }) + "\n");
    return 0;
  }
  const prompt = args[args.length - 1];
  record({ mode: "headless", args, prompt });
  await sleep(turnMs);
  process.stdout.write("fake codex exec: " + prompt + "\n");
  await runCodexNotify(codexNotify(), { type: "agent-turn-complete", "turn-id": "fake", "last-assistant-message": "ok" });
  return 0;
}

async function tui() {
  const hooks = bin === "claude" ? claudeHooks() : {};
  const notify = bin === "codex" ? codexNotify() : undefined;
  record({ mode: "tui", args, hooks: Object.keys(hooks), notify: Boolean(notify) });
  process.stdout.write("fake " + bin + " ready\r\n> ");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let buf = "";
  let pasting = false;
  let paste = "";
  let line = "";
  let turn = null; // { interrupted, waitingKey }
  let exitCode = null;

  const finishTurn = async (prompt, interrupted) => {
    record({ event: "turn-finished", prompt, interrupted });
    // Idle again before the hook runs, like the real TUI: keys typed while
    // the Stop hook is still running must not be dropped.
    turn = null;
    process.stdout.write("\r\n> ");
    if (bin === "claude") await runClaudeHook(hooks, "Stop", { stop_hook_active: false });
    else await runCodexNotify(notify, { type: "agent-turn-complete", "turn-id": "fake", "last-assistant-message": "ok" });
  };

  const runTurn = async (prompt) => {
    record({ event: "prompt", prompt });
    turn = { interrupted: false, waitingKey: null, prompt };
    process.stdout.write("\r\nthinking about: " + prompt.split("\n")[0] + "\r\n");
    if (bin === "claude") await runClaudeHook(hooks, "UserPromptSubmit", { prompt });
    if (bin === "claude" && prompt.includes("[ask]")) {
      await sleep(100);
      process.stdout.write("Bash(npm test) — allow? 1. Yes 2. Always 3. No\r\n");
      const answered = new Promise((resolve) => {
        turn.waitingKey = resolve;
      });
      await runClaudeHook(hooks, "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash", title: "Permission" });
      await answered;
    }
    const started = Date.now();
    while (Date.now() - started < turnMs && turn && !turn.interrupted) {
      process.stdout.write(".");
      await sleep(50);
    }
    await finishTurn(prompt, Boolean(turn?.interrupted));
  };

  process.stdin.on("data", (chunk) => {
    buf += chunk;
    while (buf.length > 0) {
      if (pasting) {
        const end = buf.indexOf("\u001b[201~");
        if (end === -1) {
          paste += buf;
          buf = "";
          return;
        }
        paste += buf.slice(0, end);
        buf = buf.slice(end + 6);
        pasting = false;
        line += paste;
        paste = "";
        continue;
      }
      if (buf.startsWith("\u001b[200~")) {
        pasting = true;
        buf = buf.slice(6);
        continue;
      }
      const ch = buf[0];
      buf = buf.slice(1);
      if (turn) {
        if (turn.waitingKey && /[0-9yna]/.test(ch)) {
          record({ event: "answer", key: ch });
          process.stdout.write("answered " + ch + "\r\n");
          const resolve = turn.waitingKey;
          turn.waitingKey = null;
          resolve();
          continue;
        }
        if ((bin === "claude" && ch === "\u001b") || (bin === "codex" && ch === "\u0003")) {
          turn.interrupted = true;
          continue;
        }
        continue; // typing during a turn is ignored, like a busy TUI
      }
      if (ch === "\u0003") {
        exitCode = 0;
        process.stdout.write("\r\nbye\r\n");
        process.exit(0);
      }
      if (ch === "\r") {
        const prompt = line;
        line = "";
        if (prompt.trim()) void runTurn(prompt);
        continue;
      }
      line += ch;
    }
  });
  await new Promise(() => undefined);
  return exitCode ?? 0;
}

const isHeadless = bin === "claude" ? args.includes("-p") : args[0] === "exec";
(isHeadless ? headless() : tui()).then((code) => process.exit(code ?? 0));
`;

export function createFakeHarnesses() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-fake-harness-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "harness.log");
  writeFileSync(log, "");
  const impl = path.join(dir, "fake-harness.mjs");
  writeFileSync(impl, FAKE);
  for (const name of ["claude", "codex"]) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "${name}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  return {
    dir,
    bin,
    log,
    /** Env additions: fakes first on PATH (git and node stay reachable), log path. */
    env: (extra = {}) => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_HARNESS_LOG: log, ...extra }),
    entries: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
