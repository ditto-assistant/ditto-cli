import { PATH_PLACEHOLDER, preflight } from "./exec.js";
import { resourceName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli (brew install azure-cli), then run `az login`";

function target(options: StoreOptions): StoreTarget {
  const vault = options.keyVault?.trim();
  if (!vault) throw new Error("Azure Key Vault needs --key-vault <name> (the vault the secret goes into)");
  const name = slug("--key-vault", vault, /^[A-Za-z0-9-]+$/);
  return { describe: `Azure Key Vault ${name}`, fields: { keyVault: name } };
}

/**
 * Azure Key Vault. `az keyvault secret set --file` reads the value from a
 * file, so the plaintext travels through `/dev/stdin` instead of `--value`
 * in argv. `set` already creates a new version when the secret exists.
 */
export const azure: SecretStore = {
  id: "azure",
  label: "Azure Key Vault",
  bin: "az",
  shorthand: "--az-secret",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  versionArgs: ["version"],
  options: ["keyVault"],
  validateName: (name) => resourceName("Azure Key Vault secret", name),
  preflight: () =>
    preflight({
      bin: "az",
      label: "Azure Key Vault",
      installHint: INSTALL_HINT,
      versionArgs: azure.versionArgs,
      authArgs: ["account", "show"],
      authHint: "Run `az login` first.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => [
    {
      note: "az keyvault secret set",
      kind: "path",
      args: [
        "keyvault",
        "secret",
        "set",
        "--vault-name",
        t.fields.keyVault,
        "--name",
        name,
        "--file",
        PATH_PLACEHOLDER,
        "--encoding",
        "utf-8",
        "--output",
        "none",
      ],
    },
  ],
  usage: (name, t, gateway) => [
    "Read it back at runtime:",
    `  az keyvault secret show --vault-name ${t.fields.keyVault} --name ${name} --query value -o tsv`,
    `  # Container Apps / App Service: reference @Microsoft.KeyVault(SecretUri=…) as OPENAI_API_KEY`,
    `  # with OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
  ],
};
