import { preflight } from "./exec.js";
import { envStyleName } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the Vercel CLI from https://vercel.com/docs/cli (npm i -g vercel), then run `vercel login` and `vercel link`";

const TARGETS = ["production", "preview", "development"] as const;

function target(options: StoreOptions): StoreTarget {
  const raw = options.vercelTarget?.trim() ?? "production";
  if (!(TARGETS as readonly string[]).includes(raw)) {
    throw new Error(`--vercel-target must be one of: ${TARGETS.join(", ")}`);
  }
  return { describe: `Vercel ${raw} environment`, fields: { target: raw } };
}

/**
 * Vercel environment variables. `vercel env add NAME <target>` takes the value
 * from stdin (its `--value` flag is the argv-leaking alternative); `--force`
 * replaces an existing variable and `--sensitive` hides it from the dashboard.
 */
export const vercel: SecretStore = {
  id: "vercel",
  label: "Vercel",
  bin: "vercel",
  shorthand: "--vercel-env",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  options: ["vercelTarget"],
  validateName: (name) => envStyleName("Vercel environment variable", name),
  preflight: () =>
    preflight({
      bin: "vercel",
      label: "Vercel",
      installHint: INSTALL_HINT,
      authArgs: ["whoami"],
      authHint: "Run `vercel login` first, or set VERCEL_TOKEN.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => [
    {
      note: "vercel env add",
      kind: "stdin",
      args: ["env", "add", name, t.fields.target, "--force", "--sensitive", "--yes", "--non-interactive"],
    },
  ],
  usage: (name, t, gateway) => [
    `Pull it into a local .env: vercel env pull --environment=${t.fields.target}`,
    `  # ${name} is in the ${t.fields.target} environment of the linked project`,
    `  # point clients at OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
  ],
};

/** Exported for the flag's help text and tests. */
export const VERCEL_TARGETS = TARGETS;
