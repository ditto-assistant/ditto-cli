import { preflight } from "./exec.js";
import { envStyleName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install flyctl from https://fly.io/docs/flyctl/install (brew install flyctl), then run `fly auth login`";

function target(options: StoreOptions): StoreTarget {
  const app = options.app ? slug("--app", options.app, /^[a-z0-9-]+$/) : undefined;
  return {
    describe: app ? `Fly app ${app}` : "the Fly app in this directory's fly.toml",
    fields: app ? { app } : {},
  };
}

/**
 * Fly.io. `fly secrets import` reads `KEY=VALUE` lines from stdin, which is
 * the only way to set a secret without putting the value in argv. It replaces
 * an existing secret and stages a release for the app.
 */
export const fly: SecretStore = {
  id: "fly",
  label: "Fly.io",
  bin: "fly",
  altBins: ["flyctl"],
  shorthand: "--fly-secret",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  options: ["app"],
  validateName: (name) => envStyleName("Fly secret", name),
  preflight: () =>
    preflight({
      bin: "fly",
      altBins: ["flyctl"],
      label: "Fly.io",
      installHint: INSTALL_HINT,
      authArgs: ["auth", "whoami"],
      authHint: "Run `fly auth login` first, or set FLY_API_TOKEN.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const args = ["secrets", "import"];
    if (t.fields.app) args.push("--app", t.fields.app);
    return [
      {
        note: "fly secrets import",
        kind: "stdin",
        args,
        payload: (value) => `${name}=${value}\n`,
      },
    ];
  },
  usage: (name, _t, gateway) => [
    `${name} is in the app's environment after the release finishes:`,
    `  OPENAI_API_KEY=$${name} with OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
    `  # or ANTHROPIC_AUTH_TOKEN with ANTHROPIC_BASE_URL=${gateway.anthropicBaseUrl}`,
  ],
};
