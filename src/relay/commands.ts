import type { Command } from "commander";
import { apiBase, findEndpoint, listEndpoints, updateEndpoint } from "../api.js";
import { resolveApiKey } from "../config.js";
import { resolveCliProxy } from "../agents/cliproxy.js";
import { connectRelay, relayWebSocketURL } from "./client.js";

interface RelayOptions { endpoint: string; url?: string; enable?: boolean; model?: string }

export function registerRelayCommands(program: Command): void {
  program.command("cliproxy").description("connect a local CLIProxy inference service")
    .command("relay")
    .description("relay Ditto Cloud inference to this computer; preserves Router optimizations, cloud sessions and remote control")
    .requiredOption("-e, --endpoint <slug>", "a dedicated personal inference endpoint")
    .option("--url <url>", "loopback CLIProxy URL (default: detect EasyCLIProxyAPI)")
    .option("--enable", "configure this endpoint for relay-only BYOK inference and cloud trace recording; persists after exit")
    .option("--model <id>", "local model for --enable (must appear in the proxy's catalog)")
    .action(async (options: RelayOptions) => {
      const proxy = await resolveCliProxy(options.url ?? true);
      const { key } = await resolveApiKey();
      if (!key) throw new Error("Sign in to Ditto with `heyditto login` before starting a cloud relay");
      const catalog = await listEndpoints();
      let endpoint = findEndpoint(catalog.endpoints, options.endpoint);
      if (!endpoint) throw new Error("The relay endpoint was not found; create a dedicated personal endpoint first");
      if (endpoint.companyId) throw new Error("Relay v1 supports personal endpoints only; organization relay administration is not enabled");
      const url = relayWebSocketURL(apiBase(), endpoint.id);
      if (options.enable) {
        if (!options.model || !proxy.models.includes(options.model)) throw new Error("--enable requires --model with an ID from the local proxy catalog");
        endpoint = await updateEndpoint(endpoint.id, {
          billingMode: "byok", model: options.model, modelMode: "default", kindRoutes: { agent_summary: "off" }, recordTrace: true,
          providerOptions: { ...endpoint.providerOptions, cliproxy_relay: true, claude_inference: "router" },
        });
      } else if (options.model) throw new Error("--model only configures the endpoint together with --enable");
      if (endpoint.billingMode !== "byok" || endpoint.providerOptions?.cliproxy_relay !== true) {
        throw new Error("Enable relay-only routing explicitly with --enable --model <local-model-id>; existing endpoint routing was preserved");
      }
      process.stderr.write(`ditto: relaying ${endpoint.slug} to ${proxy.baseUrl}; provider credentials stay on this computer\n`);
      process.stderr.write("ditto: Router optimizations and cloud trace recording are enabled on the selected endpoint. Run heyditto claude/codex --endpoint with this endpoint as usual. Ctrl+C stops the relay; offline calls fail instead of using a paid fallback.\n");
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      try {
        let attempts = 0;
        while (!abort.signal.aborted) {
          try {
            await connectRelay(url, key, proxy, abort.signal, () => {
              attempts = 0;
              process.stderr.write("ditto: cloud relay connected\n");
            });
          } catch {
            if (!abort.signal.aborted) process.stderr.write("ditto: relay unavailable; check Ditto login, endpoint ownership and backend version. Reconnecting…\n");
          }
          if (!abort.signal.aborted) await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
            abort.signal.addEventListener("abort", done, { once: true });
          });
        }
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    });
}
