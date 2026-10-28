#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { apiFetch, findEndpoint, listEndpoints } from "../api.js";
import { resolveApiKey } from "../config.js";
import { findProfileEndpoint, repoDefaultProfile } from "../dittoconfig/profiles.js";
import { readStoredAuth } from "../store.js";
import { runChannelServer } from "./channel-server.js";
import { remoteSessionURL } from "./session-link.js";

/** A plain `claude` plugin launch has no Ditto wrapper to register its shell.
 * Resolve existing read-only configuration; never create endpoints or keys,
 * change native inference, or open an interactive picker on the MCP stream.
 */
export async function preparePluginSession(cwd = process.env.DITTO_REMOTE_CWD ?? process.cwd()): Promise<{ sessionId: string; cwd: string }> {
  if (!(await resolveApiKey()).key) throw new Error("Sign in with `heyditto login`, then restart the Ditto Remote MCP server.");
  // The CLI wrapper already registered this exact launch and chosen its endpoint.
  if (process.env.DITTO_REMOTE_SESSION_ID) return { sessionId: process.env.DITTO_REMOTE_SESSION_ID, cwd };
  const catalog = await listEndpoints();
  const explicit = process.env.DITTO_REMOTE_ENDPOINT?.trim();
  const profile = explicit ? undefined : await repoDefaultProfile(cwd);
  const selected = explicit ?? (await readStoredAuth())?.defaultEndpoint;
  const endpoint = profile
    ? await findProfileEndpoint(profile, catalog.endpoints)
    : selected ? findEndpoint(catalog.endpoints, selected) : catalog.endpoints.length === 1 ? catalog.endpoints[0] : undefined;
  if (!endpoint) throw new Error("Select an existing endpoint with `heyditto endpoints use <slug>` or apply this repository's .ditto profile, then restart Ditto Remote.");
  const sessionId = randomUUID();
  const registration = await apiFetch<{ threadId: string; kgID?: string; graphAlias?: string }>("/api/v5/sessions/register", { method: "POST", body: {
    sessionId, endpointId: endpoint.id, harness: "claude-code", inference: "native", transport: "channels",
    title: `${path.basename(cwd)} · ${sessionId.slice(0, 8)}`,
  } });
  process.stderr.write(`Ditto Remote: ${remoteSessionURL(registration)}\n`);
  return { sessionId, cwd };
}

export async function runPluginServer(): Promise<void> {
  // Claude starts installed MCP servers even when their Channel is not opted
  // in, and does not expose registration in the MCP handshake. Never create
  // an apparently controllable session just because the plugin was installed.
  if (process.env.DITTO_REMOTE_CHANNELS_ENABLED !== "1") {
    throw new Error("Enable this review plugin explicitly with DITTO_REMOTE_CHANNELS_ENABLED=1 and Claude's matching Channels flag.");
  }
  const session = await preparePluginSession();
  await runChannelServer(session);
}

if (process.argv[1]?.endsWith("plugin-server.js")) {
  runPluginServer().catch(() => {
    // Do not print request bodies, credentials or server cause text onto MCP stderr.
    process.stderr.write("Ditto Remote is inactive or could not start. For an explicitly opted-in review launch, set DITTO_REMOTE_CHANNELS_ENABLED=1 alongside Claude's matching Channels flag. Also check `heyditto status` and `heyditto endpoints use <slug>`, then restart the MCP server.\n");
    process.exitCode = 1;
  });
}
