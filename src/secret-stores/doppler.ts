import { preflight } from "./exec.js";
import { envStyleName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the Doppler CLI from https://docs.doppler.com/docs/install-cli (brew install dopplerhq/cli/doppler), then run `doppler login`";

function target(options: StoreOptions): StoreTarget {
  const project = options.project ? slug("--project", options.project) : undefined;
  const config = options.dopplerConfig ? slug("--doppler-config", options.dopplerConfig) : undefined;
  if (config && !project) throw new Error("--doppler-config needs --project (a config belongs to one project)");
  const where = project ? `Doppler ${project}${config ? `/${config}` : ""}` : "the Doppler project configured for this directory";
  return { describe: where, fields: { ...(project ? { project } : {}), ...(config ? { config } : {}) } };
}

/**
 * Doppler. `doppler secrets set NAME` reads the value from stdin;
 * `--no-interactive` keeps it from prompting and `--silent` stops it echoing
 * the value back into logs. Setting an existing secret updates it.
 */
export const doppler: SecretStore = {
  id: "doppler",
  label: "Doppler",
  bin: "doppler",
  shorthand: "--doppler-secret",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  options: ["project", "dopplerConfig"],
  validateName: (name) => envStyleName("Doppler secret", name),
  preflight: () =>
    preflight({
      bin: "doppler",
      label: "Doppler",
      installHint: INSTALL_HINT,
      authArgs: ["me"],
      authHint: "Run `doppler login` first.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const args = ["secrets", "set", name, "--no-interactive", "--silent"];
    if (t.fields.project) args.push("--project", t.fields.project);
    if (t.fields.config) args.push("--config", t.fields.config);
    return [{ note: "doppler secrets set", kind: "stdin", args }];
  },
  usage: (name, t, gateway) => {
    const scope = `${t.fields.project ? ` -p ${t.fields.project}` : ""}${t.fields.config ? ` -c ${t.fields.config}` : ""}`;
    return [
      "Run anything with it injected:",
      `  doppler run${scope} -- your-command`,
      `  # ${name} is in the environment; point clients at OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
      `  doppler secrets get ${name} --plain${scope}   # read it back`,
    ];
  },
};
