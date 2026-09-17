import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type HarnessPlan, type PlanInput, SESSION_HEADER } from "./types.js";

/** Env var the grok provider reads the endpoint key from. */
export const GROK_KEY_ENV = "DITTO_INFERENCE_API_KEY";

/** Env var that carries the Ditto session id into the request headers. */
export const GROK_SESSION_ENV = "DITTO_SESSION_ID";

/** Catalog key of the Ditto model inside the launch GROK_HOME. */
export const GROK_MODEL_ID = "ditto";

/**
 * Launch-scoped GROK_HOME for one session, under the CLI config dir.
 *
 * GROK_HOME cannot stay at ~/.grok: a signed-in auth.json beats XAI_API_KEY
 * for every request, which would send the user's xAI session token to the
 * Ditto gateway instead of the endpoint key. A home without auth.json makes
 * the key resolve. The home persists per session id so grok's on-disk
 * sessions (resume, export) survive across launches of the same session.
 */
export function grokHomeDir(configDir: string, sessionId: string): string {
  return path.join(configDir, "grok-homes", sessionId);
}

/** User directories the launch home shares by symlink so nothing is lost. */
const GROK_SHARED_DIRS = [
  "agents",
  "bundled",
  "installed-plugins",
  "marketplace-cache",
  "memory",
  "personas",
  "plugin-data",
  "plugins",
  "sessions",
  "skills",
  "trusted_folders.toml",
  "vendor",
] as const;

/**
 * Creates (if missing) the launch GROK_HOME: the Ditto model config, hooks
 * placeholder, and symlinks to the user's skills/plugins. config.toml and
 * hooks/ditto.json are rewritten on every call — they carry no secrets (the
 * key rides env_key) but do carry launch-scoped settings like the hook
 * socket. Returns the home path.
 */
export async function ensureGrokHome(
  configDir: string,
  sessionId: string,
  input: PlanInput,
  hookServer?: { socketPath: string; scriptPath: string; nodePath: string },
): Promise<string> {
  const home = grokHomeDir(configDir, sessionId);
  await mkdir(path.join(home, "hooks"), { recursive: true });
  for (const name of GROK_SHARED_DIRS) {
    const target = path.join(os.homedir(), ".grok", name);
    const link = path.join(home, name);
    try {
      await symlink(target, link);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") continue; // missing source or other failure: skip, best effort
    }
  }
  await writeFile(path.join(home, "config.toml"), `${grokModelConfig(input)}\n`);
  if (hookServer) await writeFile(path.join(home, "hooks", "ditto.json"), grokHookConfig(hookServer));
  return home;
}

/** The TOML `[model.ditto]` entry that routes grok at the Ditto gateway. */
export function grokModelConfig(input: PlanInput): string {
  // env_http_headers resolves the session id from an env var when the client
  // is built, so X-Ditto-Session-Id rides every inference request — main
  // turns and title calls alike — without a secret ever touching disk.
  return [
    `[model.${GROK_MODEL_ID}]`,
    `model = ${JSON.stringify(input.model ?? "grok-4.5")}`,
    `base_url = ${JSON.stringify(input.baseUrl)}`,
    `name = ${JSON.stringify("Ditto")}`,
    `env_key = ${JSON.stringify(GROK_KEY_ENV)}`,
    `context_window = 200000`,
    `env_http_headers = { ${JSON.stringify(SESSION_HEADER)} = ${JSON.stringify(GROK_SESSION_ENV)} }`,
    "",
    "[models]",
    `default = ${JSON.stringify(GROK_MODEL_ID)}`,
  ].join("\n");
}

const GROK_HOOK_EVENTS = ["UserPromptSubmit", "Stop", "PreToolUse"] as const;

/** The `$GROK_HOME/hooks/ditto.json` that reports turn boundaries to the CLI host. */
export function grokHookConfig(server: { socketPath: string; scriptPath: string; nodePath: string }): string {
  const command = [server.nodePath, server.scriptPath, server.socketPath, "grok"].map((s) => JSON.stringify(s)).join(" ");
  const hooks: Record<string, unknown> = {};
  for (const event of GROK_HOOK_EVENTS) {
    hooks[event] = [
      {
        // grok maps Claude-style tool names in matchers, but ask_user_question
        // is its native name; match that (PreToolUse only).
        ...(event === "PreToolUse" ? { matcher: "ask_user_question" } : {}),
        hooks: [{ type: "command", command, timeout: 5 }],
      },
    ];
  }
  return JSON.stringify({ hooks }, null, 2);
}

/**
 * Builds the `grok` invocation.
 *
 * Routing goes through the launch GROK_HOME (see ensureGrokHome): its
 * `[model.ditto]` points every request at the Ditto gateway, and the global
 * env redirects any first-party housekeeping call (the session title) there
 * too, with XAI_API_KEY carrying the same endpoint key. The session id is
 * pinned with `-s` so grok's own wire header (x-grok-session-id) and on-disk
 * session match the Ditto thread; resume reopens that id.
 */
export function planGrok(input: PlanInput, grokHome: string): HarnessPlan {
  const args: string[] = [];
  // -s pins grok's session id (UUID only); --resume reopens one. They are
  // mutually exclusive, like claude's --session-id/--resume.
  const uuidShaped = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (input.resumeId) args.push("--resume", input.resumeId);
  else if (input.resumeLast) args.push("--resume");
  else if (uuidShaped.test(input.sessionId)) args.push("-s", input.sessionId);

  if (input.model) args.push("-m", input.model);

  if (input.yolo) args.push("--always-approve");
  else if (input.yellow) args.push("--permission-mode", "auto");
  else if (input.plan) args.push("--permission-mode", "plan");
  else if (input.prompt !== undefined) args.push("--always-approve"); // a -p run cannot answer permission prompts

  if (input.prompt !== undefined) args.push("-p", input.prompt);
  args.push(...input.passthrough);

  return {
    command: "grok",
    args,
    envSet: {
      GROK_HOME: grokHome,
      // Redirect any call that bypasses the model config (housekeeping to the
      // first-party API) at the gateway as well, with the endpoint key.
      GROK_MODELS_BASE_URL: input.baseUrl,
      GROK_XAI_API_BASE_URL: input.baseUrl.replace(/\/v1\/?$/, ""),
      XAI_API_KEY: input.apiKey,
      [GROK_SESSION_ENV]: input.sessionId,
    },
    envUnset: [],
    installHint: "install Grok: curl -fsSL https://grok.com/install | sh (or see https://grok.com)",
  };
}
