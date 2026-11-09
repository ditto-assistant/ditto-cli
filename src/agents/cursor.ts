import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_DENY_HEADER } from "./claude-deny.js";
import { MCP_KEY_ENV, type McpAttachment, sweepStaleSettings } from "./claude-mcp.js";
import type { HarnessPlan, PlanInput } from "./types.js";

/**
 * Cursor CLI (`cursor-agent`) through Ditto.
 *
 * Cursor's own service runs inference, so Ditto supplies only the endpoint's
 * tools, as native MCP servers. Cursor has no per-launch MCP flag, but it
 * loads a plugin directory per launch (`--plugin-dir`), and a plugin's
 * `.mcp.json` declares servers, so the attachment goes there and nothing is
 * written to ~/.cursor. Cursor names a plugin's servers after the plugin
 * directory, `plugin-ditto-<server>`. The key stays out of the file: Cursor
 * expands `${env:DITTO_ROUTER_MCP_KEY}` in headers.
 */

/** The plugin directory's name, which Cursor puts in every server's name. */
export const CURSOR_PLUGIN_NAME = "ditto";

/** Rule that refuses every gated tool on Ditto's side (toolgate class:gated). */
const DENY_GATED = "class:gated";

/**
 * The plugin's `.mcp.json`. Cursor's permission rules live only in its own
 * config files, so an unattended run (`-p`, which needs --force to call MCP
 * tools at all) cannot be told to ask about the calls Ditto would have held.
 * Those are refused by Ditto instead, through the tighten-only deny header:
 * nobody is there to approve them, and --yolo said to run them.
 */
export function cursorMcpConfig(mcp: McpAttachment, opts: { unattended?: boolean } = {}): string {
  const denyGated = Boolean(opts.unattended) && mcp.ask.length > 0;
  const mcpServers: Record<string, unknown> = {};
  for (const server of mcp.attached) {
    const headers: Record<string, string> = { Authorization: `Bearer \${env:${MCP_KEY_ENV}}`, ...server.headers };
    if (denyGated) headers[TOOL_DENY_HEADER] = [headers[TOOL_DENY_HEADER], DENY_GATED].filter(Boolean).join(",");
    mcpServers[server.name] = { url: server.url, headers };
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Plugin directories made by this process, removed when it exits. */
const pluginRoots: string[] = [];
const PLUGIN_PREFIX = "ditto-cursor-";

/**
 * Writes the launch's plugin into a private temporary directory and returns
 * its path. It holds no secret, but it is the session's tool wiring, so it is
 * 0700 and removed when the CLI exits; one a killed CLI left behind is swept
 * by a later launch once its process is gone, like Claude's settings copies.
 */
export function writeCursorPlugin(mcp: McpAttachment, opts: { unattended?: boolean } = {}, tmp: string = os.tmpdir()): string {
  if (pluginRoots.length === 0) sweepStaleSettings(tmp, undefined, undefined, PLUGIN_PREFIX);
  const root = mkdtempSync(path.join(tmp, `${PLUGIN_PREFIX}${process.pid}-`));
  chmodSync(root, 0o700);
  if (pluginRoots.push(root) === 1) process.once("exit", () => { for (const dir of pluginRoots) rmSync(dir, { recursive: true, force: true }); });
  const dir = path.join(root, CURSOR_PLUGIN_NAME);
  mkdirSync(path.join(dir, ".cursor-plugin"), { recursive: true });
  writeFileSync(path.join(dir, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: CURSOR_PLUGIN_NAME, version: "1.0.0", description: "Ditto endpoint tools" }, null, 2));
  writeFileSync(path.join(dir, ".mcp.json"), cursorMcpConfig(mcp, opts));
  return dir;
}

/**
 * A new, empty Cursor chat for this session, so the session can name its own
 * conversation: `--resume <id>` reopens exactly it, where `--continue` would
 * pick whichever chat in the directory is newest. Undefined when Cursor does
 * not answer with an id.
 */
export function createCursorChat(cwd: string, run: typeof spawnSync = spawnSync): string | undefined {
  const res = run("cursor-agent", ["create-chat"], { cwd, encoding: "utf8", timeout: 15_000 });
  const id = typeof res.stdout === "string" ? res.stdout.trim() : "";
  return res.status === 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}

/**
 * Builds the `cursor-agent` invocation. `pluginDir` is the directory
 * writeCursorPlugin made for this launch (absent: no tools attached).
 */
export function planCursor(input: PlanInput, pluginDir?: string): HarnessPlan {
  if (input.yellow) throw new Error("--yellow is not supported for Cursor CLI; use --yolo (--force) or Cursor's own prompts");
  const args: string[] = [];
  if (pluginDir) args.push("--plugin-dir", pluginDir);
  if (input.resumeId) args.push("--resume", input.resumeId);
  else if (input.resumeLast) args.push("--continue");
  if (input.model) args.push("--model", input.model);
  if (input.plan) args.push("--plan");
  if (input.yolo) args.push("--force");
  if (input.prompt !== undefined) {
    // A -p run cannot answer a prompt: Cursor rejects every MCP call without
    // --force, and an untrusted workspace would wait for a trust answer.
    if (!input.yolo) args.push("--force");
    args.push("--trust", "-p", input.prompt, ...input.passthrough);
  } else {
    args.push(...input.passthrough);
  }
  return {
    command: "cursor-agent",
    args,
    envSet: input.mcp ? { [MCP_KEY_ENV]: input.mcpApiKey ?? input.apiKey } : {},
    envUnset: [],
    installHint: "install Cursor CLI: curl https://cursor.com/install -fsS | bash (then `cursor-agent login`)",
  };
}
