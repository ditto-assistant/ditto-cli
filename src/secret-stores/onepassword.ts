import { preflight } from "./exec.js";
import { slug, titleName } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the 1Password CLI from https://developer.1password.com/docs/cli/get-started (brew install 1password-cli), then sign in with `op signin`";

function target(options: StoreOptions): StoreTarget {
  const vault = options.opVault ? slug("--op-vault", options.opVault, /^[^\n\r]+$/) : "Private";
  return { describe: `1Password vault ${vault}`, fields: { vault } };
}

/**
 * 1Password. Assignment statements (`credential=…`) put the value in argv and
 * the docs say so explicitly, so this pipes an item JSON template into
 * `op item create -` instead: the plaintext only ever crosses stdin.
 */
export const onepassword: SecretStore = {
  id: "1password",
  label: "1Password",
  bin: "op",
  shorthand: "--op-item",
  nameLabel: "TITLE",
  installHint: INSTALL_HINT,
  options: ["opVault"],
  validateName: (name) => titleName("1Password item title", name),
  preflight: () =>
    preflight({
      bin: "op",
      label: "1Password",
      installHint: INSTALL_HINT,
      authArgs: ["whoami"],
      authHint: "Run `op signin` first (or enable the desktop app's CLI integration).",
    }),
  resolveTarget: target,
  deliveries: (title, t) => [
    {
      note: "op item create",
      kind: "stdin",
      args: ["item", "create", "--vault", t.fields.vault, "-"],
      payload: (value) =>
        `${JSON.stringify({
          title,
          category: "API_CREDENTIAL",
          fields: [{ id: "credential", label: "credential", type: "CONCEALED", value }],
        })}\n`,
    },
  ],
  usage: (title, t, gateway) => [
    "Read it back without ever printing it:",
    `  op read "op://${t.fields.vault}/${title}/credential"`,
    `  # op run --env-file=.env -- your-command, with .env holding`,
    `  #   OPENAI_API_KEY=op://${t.fields.vault}/${title}/credential`,
    `  #   OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
  ],
};
