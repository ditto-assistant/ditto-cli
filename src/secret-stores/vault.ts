import { preflight } from "./exec.js";
import { secretPath, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the Vault CLI from https://developer.hashicorp.com/vault/install (brew install hashicorp/tap/vault), then export VAULT_ADDR and run `vault login`";

function target(options: StoreOptions): StoreTarget {
  const mount = options.mount ? slug("--mount", options.mount, /^[A-Za-z0-9_.\-/]+$/) : "secret";
  const field = options.field ? slug("--field", options.field, /^[A-Za-z0-9_.-]+$/) : "token";
  return { describe: `Vault ${mount}/ (field ${field})`, fields: { mount, field } };
}

/**
 * HashiCorp Vault kv. `FIELD=-` makes Vault read that single field's value
 * from stdin. `kv patch` leaves the path's other fields alone but needs the
 * path to exist, so `kv put` is the fallback that creates it.
 */
export const vault: SecretStore = {
  id: "vault",
  label: "HashiCorp Vault",
  bin: "vault",
  shorthand: "--vault-secret",
  nameLabel: "PATH",
  installHint: INSTALL_HINT,
  versionArgs: ["version"],
  options: ["mount", "field"],
  validateName: (name) => secretPath("Vault kv path", name),
  preflight: () =>
    preflight({
      bin: "vault",
      label: "HashiCorp Vault",
      installHint: INSTALL_HINT,
      versionArgs: vault.versionArgs,
      authArgs: ["token", "lookup"],
      authHint: "Set VAULT_ADDR and run `vault login` first.",
    }),
  resolveTarget: target,
  deliveries: (path, t) => {
    const args = (verb: string) => ["kv", verb, `-mount=${t.fields.mount}`, path, `${t.fields.field}=-`];
    return [
      { note: "vault kv patch", kind: "stdin", args: args("patch") },
      { note: "vault kv put", kind: "stdin", args: args("put") },
    ];
  },
  usage: (path, t, gateway) => [
    "Read it back at runtime:",
    `  vault kv get -mount=${t.fields.mount} -field=${t.fields.field} ${path}`,
    `  # export OPENAI_API_KEY=$(…) with OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
    `  # or ANTHROPIC_AUTH_TOKEN with ANTHROPIC_BASE_URL=${gateway.anthropicBaseUrl}`,
  ],
};
