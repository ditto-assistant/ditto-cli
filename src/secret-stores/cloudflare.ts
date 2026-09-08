import { preflight } from "./exec.js";
import { envStyleName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install Wrangler from https://developers.cloudflare.com/workers/wrangler/install-and-update (npm i -g wrangler), then run `wrangler login`";

function target(options: StoreOptions): StoreTarget {
  const worker = options.worker ? slug("--worker", options.worker, /^[A-Za-z0-9_.-]+$/) : undefined;
  return {
    describe: worker ? `Cloudflare Worker ${worker}` : "the Worker in this directory's wrangler config",
    fields: worker ? { worker } : {},
  };
}

/**
 * Cloudflare Workers. `wrangler secret put NAME` reads the value from stdin
 * when it is not attached to a terminal, and replaces an existing secret.
 * Without `--name` it uses the Worker in the local wrangler config.
 */
export const cloudflare: SecretStore = {
  id: "cloudflare",
  label: "Cloudflare Workers",
  bin: "wrangler",
  shorthand: "--cf-secret",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  options: ["worker"],
  validateName: (name) => envStyleName("Cloudflare Worker secret", name),
  preflight: () =>
    preflight({
      bin: "wrangler",
      label: "Cloudflare Workers",
      installHint: INSTALL_HINT,
      authArgs: ["whoami"],
      authHint: "Run `wrangler login` first, or set CLOUDFLARE_API_TOKEN.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const args = ["secret", "put", name];
    if (t.fields.worker) args.push("--name", t.fields.worker);
    return [{ note: "wrangler secret put", kind: "stdin", args }];
  },
  usage: (name, _t, gateway) => [
    "Use it inside the Worker:",
    `  const key = env.${name};`,
    `  // OpenAI-compatible base: ${gateway.openaiBaseUrl}`,
    `  // Anthropic base: ${gateway.anthropicBaseUrl}`,
  ],
};
