import { type FSWatcher, watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Harness } from "../agents/types.js";
import type { CommandEntry } from "./protocol.js";

/**
 * The command catalog a session announces (`session.commands`): what the app
 * may put behind "/" in its composer. Builtins are listed per harness version
 * we ship against; custom commands, skills and plugin skills are read from the
 * same directories the harness reads, so the catalog is what the user would
 * see locally. Everything is best effort: an unreadable directory contributes
 * nothing rather than failing the session.
 */

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/** grokHome: the launch-scoped GROK_HOME (set by the launcher) or the user's. */
function grokHome(): string {
  return process.env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
}

/**
 * Claude Code 2.1.x builtins. `headless` is true only for the ones that are
 * prompt expansions (they work under `claude -p`); the rest drive the TUI.
 */
const CLAUDE_BUILTINS: Array<[string, string, boolean, string?]> = [
  ["help", "show help and available commands", false],
  ["clear", "clear conversation history", false],
  ["compact", "compact the conversation, optionally with focus instructions", false, "[instructions]"],
  ["context", "show current context usage", false],
  ["cost", "show token usage and cost for this session", false],
  ["model", "set the model for the session", false, "[model]"],
  ["review", "review a pull request", true, "[pr]"],
  ["init", "create a CLAUDE.md for this repository", true],
  ["memory", "edit memory files", false],
  ["config", "open the settings", false],
  ["status", "show session status", false],
  ["doctor", "check the health of the installation", false],
  ["permissions", "view or update permissions", false],
  ["mcp", "manage MCP servers", false],
  ["agents", "manage agent configurations", false],
  ["hooks", "manage hook configurations", false],
  ["resume", "resume a previous conversation", false],
  ["rewind", "rewind the conversation or code", false],
  ["export", "export the conversation", false, "[file]"],
  ["add-dir", "add a working directory", false, "<path>"],
  ["plan", "enter plan mode", false],
  ["fast", "toggle fast mode", false],
  ["pr-comments", "fetch comments from a GitHub pull request", true, "[pr]"],
  ["release-notes", "show release notes", false],
  ["bug", "report a bug", false],
  ["vim", "toggle vim editing mode", false],
  ["exit", "exit the session", false],
];

/** Codex 0.153.x builtins; none of them exist under `codex exec`. */
const CODEX_BUILTINS: Array<[string, string, string?]> = [
  ["model", "choose the model and reasoning effort"],
  ["new", "start a new chat"],
  ["compact", "summarize the conversation to free context"],
  ["diff", "show git diff (including untracked files)"],
  ["status", "show session configuration and token usage"],
  ["approvals", "choose what Codex can do without approval"],
  ["permissions", "choose what Codex can do without approval"],
  ["init", "create an AGENTS.md for this repository"],
  ["mention", "mention a file", "<path>"],
  ["review", "review the working tree changes"],
  ["mcp", "list configured MCP tools"],
  ["skills", "list the available skills"],
  ["plan", "plan mode"],
  ["undo", "undo the last file changes"],
  ["resume", "resume a saved chat"],
  ["personality", "choose the assistant's personality"],
  ["feedback", "send feedback"],
  ["logout", "log out of Codex"],
  ["quit", "exit Codex"],
];

/** Grok 1.0.x builtins (from `grok -h` and its bundled docs); prompt expansions only. */
const GROK_BUILTINS: Array<[string, string, string?]> = [
  ["model", "switch the session model", "[model]"],
  ["compact", "compress conversation history to save context window", "[instructions]"],
  ["always-approve", "toggle always-approve mode (skip all permission prompts)", "on|off"],
  ["context", "show context window usage and session stats"],
  ["session-info", "show session details (model, turns, context usage)"],
  ["goal", "set, manage, or check an autonomous goal", "<objective>"],
  ["workflow", "launch a saved workflow or manage runs", "[name]"],
  ["config-agents", "manage agent configurations"],
  ["personas", "manage subagent personas"],
  ["hooks-trust", "grant hooks/MCP/LSP trust for this folder"],
  ["privacy", "coding data, retention, and training settings"],
  ["help", "show help and available commands"],
];

/** `key: value` lines between the leading `---` fences; enough for command and skill files. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {};
  if (!text.startsWith("---")) return { fields, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fields, body: text };
  for (const line of text.slice(3, end).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: text.slice(end + 4).replace(/^\r?\n/, "") };
}

function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("<!--"));
  return (line ?? "").slice(0, 200);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Markdown command files under `dir` (recursive), as `<name>` entries. */
async function commandFiles(dir: string, source: CommandEntry["source"], prefix = ""): Promise<CommandEntry[]> {
  if (!(await isDir(dir))) return [];
  const out: CommandEntry[] = [];
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (await isDir(full)) {
      out.push(...(await commandFiles(full, source, prefix)));
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const text = await readText(full);
    if (text === undefined) continue;
    const { fields, body } = parseFrontmatter(text);
    out.push({
      name: `${prefix}${path.basename(entry, ".md")}`,
      description: fields.description || firstLine(body),
      source,
      ...(fields["argument-hint"] ? { argsHint: fields["argument-hint"] } : {}),
      headless: true,
    });
  }
  return out;
}

/** Skills (one SKILL.md per folder under `dir`) that the user may invoke by name. */
async function skillDirs(dir: string, source: CommandEntry["source"], prefix = ""): Promise<CommandEntry[]> {
  if (!(await isDir(dir))) return [];
  const out: CommandEntry[] = [];
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  for (const entry of entries) {
    const text = await readText(path.join(dir, entry, "SKILL.md"));
    if (text === undefined) continue;
    const { fields, body } = parseFrontmatter(text);
    if ((fields["user-invocable"] ?? fields["user-invokable"] ?? "true").toLowerCase() === "false") continue;
    out.push({
      name: `${prefix}${fields.name || entry}`,
      description: fields.description || firstLine(body),
      source,
      ...(fields["argument-hint"] ? { argsHint: fields["argument-hint"] } : {}),
      headless: true,
    });
  }
  return out;
}

interface InstalledPlugin {
  name: string;
  installPath: string;
  scope?: string;
  projectPath?: string;
}

/** Plugins from `~/.claude/plugins/installed_plugins.json` that apply to `cwd`. */
async function installedPlugins(cwd: string): Promise<InstalledPlugin[]> {
  const text = await readText(path.join(claudeHome(), "plugins", "installed_plugins.json"));
  if (!text) return [];
  let parsed: { plugins?: Record<string, Array<{ installPath?: string; scope?: string; projectPath?: string }>> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  const out: InstalledPlugin[] = [];
  for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
    const name = key.split("@")[0];
    for (const install of installs ?? []) {
      if (!install.installPath) continue;
      if (install.scope === "project" && install.projectPath && !cwd.startsWith(install.projectPath)) continue;
      out.push({ name, installPath: install.installPath, scope: install.scope, projectPath: install.projectPath });
    }
  }
  return out;
}

/** Directories whose contents feed the catalog; watched for changes. */
export function catalogDirs(harness: Harness, cwd: string): string[] {
  if (harness === "claude") {
    return [
      path.join(cwd, ".claude", "commands"),
      path.join(cwd, ".claude", "skills"),
      path.join(claudeHome(), "commands"),
      path.join(claudeHome(), "skills"),
      path.join(claudeHome(), "plugins"),
    ];
  }
  if (harness === "grok") {
    return [
      path.join(cwd, ".grok", "skills"),
      path.join(grokHome(), "skills"),
      path.join(grokHome(), "agents"),
    ];
  }
  return [
    path.join(codexHome(), "prompts"),
    path.join(codexHome(), "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".codex", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
}

export async function discoverCommands(harness: Harness, cwd: string): Promise<CommandEntry[]> {
  const seen = new Set<string>();
  const out: CommandEntry[] = [];
  const add = (entries: CommandEntry[]) => {
    for (const e of entries) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      out.push(e);
    }
  };
  if (harness === "claude") {
    add(await commandFiles(path.join(cwd, ".claude", "commands"), "custom"));
    add(await commandFiles(path.join(claudeHome(), "commands"), "custom"));
    add(await skillDirs(path.join(cwd, ".claude", "skills"), "skill"));
    add(await skillDirs(path.join(claudeHome(), "skills"), "skill"));
    for (const plugin of await installedPlugins(cwd)) {
      add(await skillDirs(path.join(plugin.installPath, "skills"), "plugin", `${plugin.name}:`));
      add(await commandFiles(path.join(plugin.installPath, "commands"), "plugin", `${plugin.name}:`));
    }
    add(
      CLAUDE_BUILTINS.map(([name, description, headless, argsHint]) => ({
        name,
        description,
        source: "builtin" as const,
        ...(argsHint ? { argsHint } : {}),
        headless,
      })),
    );
    return out;
  }
  if (harness === "grok") {
    add(await skillDirs(path.join(cwd, ".grok", "skills"), "skill", "$"));
    add(await skillDirs(path.join(grokHome(), "skills"), "skill", "$"));
    add(
      GROK_BUILTINS.map(([name, description, argsHint]) => ({
        name,
        description,
        source: "builtin" as const,
        ...(argsHint ? { argsHint } : {}),
        headless: false,
      })),
    );
    return out;
  }
  // Codex: custom prompts are typed as /prompts:<name>; skills are mentioned as $<name>.
  add(await commandFiles(path.join(codexHome(), "prompts"), "custom", "prompts:"));
  add(await skillDirs(path.join(cwd, ".agents", "skills"), "skill", "$"));
  add(await skillDirs(path.join(cwd, ".codex", "skills"), "skill", "$"));
  add(await skillDirs(path.join(codexHome(), "skills"), "skill", "$"));
  add(await skillDirs(path.join(os.homedir(), ".agents", "skills"), "skill", "$"));
  add(
    CODEX_BUILTINS.map(([name, description, argsHint]) => ({
      name,
      description,
      source: "builtin" as const,
      ...(argsHint ? { argsHint } : {}),
      headless: false,
    })),
  );
  return out;
}

/** The text typed into the harness for a catalog command. */
export function commandInvocation(harness: Harness, entry: CommandEntry | undefined, name: string, args?: string): string {
  const trimmed = args?.trim();
  const suffix = trimmed ? ` ${trimmed}` : "";
  if (harness === "codex" && (entry?.source === "skill" || name.startsWith("$"))) {
    return `${name.startsWith("$") ? name : `$${name}`}${suffix}`;
  }
  return `/${name.replace(/^\//, "")}${suffix}`;
}

/**
 * Re-runs discovery when any catalog directory changes (debounced). Node's
 * recursive watch is unsupported on some platforms; those fall back to a
 * shallow watch, which still catches new command files and skill folders.
 */
export function watchCatalog(harness: Harness, cwd: string, onChange: () => void, debounceMs = 500): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
    timer.unref?.();
  };
  for (const dir of catalogDirs(harness, cwd)) {
    try {
      let w: FSWatcher;
      try {
        w = watch(dir, { recursive: true, persistent: false }, trigger);
      } catch {
        w = watch(dir, { persistent: false }, trigger);
      }
      w.on("error", () => undefined);
      watchers.push(w);
    } catch {
      /* directory missing or not watchable: nothing to watch */
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
