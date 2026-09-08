import { aws } from "./aws.js";
import { azure } from "./azure.js";
import { cloudflare } from "./cloudflare.js";
import { doppler } from "./doppler.js";
import { installed, resolveBin } from "./exec.js";
import { fly } from "./fly.js";
import { gcloud } from "./gcloud.js";
import { github } from "./github.js";
import { gitlab } from "./gitlab.js";
import { kubernetes } from "./kubernetes.js";
import { onepassword } from "./onepassword.js";
import { vault } from "./vault.js";
import { vercel } from "./vercel.js";
import { type SecretStore, STORE_IDS, type StoreId, type StoreOptionKey, type StoreOptions } from "./types.js";

export { deliver, installed, resolveBin } from "./exec.js";
export { GH_INSTALL_HINT, resolveRepoFromCwd } from "./github.js";
export { validateRepo, validateSecretName } from "./naming.js";
export { STORE_IDS } from "./types.js";
export type { Delivery, Gateway, SecretStore, StoreId, StoreOptions, StoreTarget } from "./types.js";
export { VERCEL_TARGETS } from "./vercel.js";

/** Every store, in the order they are listed to the operator. */
export const STORES: readonly SecretStore[] = [
  github,
  gitlab,
  aws,
  gcloud,
  azure,
  onepassword,
  vault,
  doppler,
  cloudflare,
  vercel,
  kubernetes,
  fly,
];

/** Human label for every flag, so "unsupported flag" errors name the flag the operator typed. */
const OPTION_FLAGS: Record<StoreOptionKey, string> = {
  repo: "--repo",
  env: "--env",
  org: "--org",
  region: "--region",
  project: "--project",
  keyVault: "--key-vault",
  opVault: "--op-vault",
  mount: "--mount",
  field: "--field",
  dopplerConfig: "--doppler-config",
  worker: "--worker",
  vercelTarget: "--vercel-target",
  namespace: "--namespace",
  k8sKey: "--k8s-key",
  app: "--app",
};

const OPTION_KEYS = Object.keys(OPTION_FLAGS) as StoreOptionKey[];

export function storeById(id: string): SecretStore {
  const store = STORES.find((s) => s.id === id);
  if (!store) throw new Error(`unknown --store "${id}". Available: ${STORE_IDS.join(", ")}`);
  return store;
}

/** `--store <id>` is the canonical selector; every store also has a shorthand. */
export interface StoreSelection {
  store: SecretStore;
  /** Secret / variable / item / path name. */
  name: string;
  /** The flag the operator actually used, for error messages. */
  flag: string;
}

/**
 * Resolves which store gets the key from `--store`/`--secret` or exactly one
 * shorthand, and rejects flags that belong to a different store — silently
 * ignoring `--repo` on an AWS run would store the secret somewhere the
 * operator did not intend.
 */
export function selectStore(options: StoreOptions & { store?: string; shorthands: Partial<Record<StoreId, string>> }): StoreSelection {
  const used = STORES.filter((s) => options.shorthands[s.id] !== undefined);
  if (used.length > 1) {
    throw new Error(`pick one destination: ${used.map((s) => s.shorthand).join(" and ")} cannot both be set`);
  }
  const shorthand = used[0];
  if (shorthand && options.store && options.store !== shorthand.id) {
    throw new Error(`--store ${options.store} contradicts ${shorthand.shorthand} (which implies --store ${shorthand.id})`);
  }
  const store = shorthand ?? (options.store ? storeById(options.store) : undefined);
  if (!store) {
    throw new Error(
      `pick a destination: --store <${STORE_IDS.join("|")}> with --secret <NAME>, or a shorthand such as ${github.shorthand} NAME. See \`heyditto endpoints keys stores\`.`,
    );
  }
  const raw = shorthand ? options.shorthands[store.id] : options.secret;
  const flag = shorthand ? store.shorthand : "--secret";
  if (!raw) throw new Error(`--store ${store.id} needs --secret <${store.nameLabel}>`);
  const stray = OPTION_KEYS.filter((key) => options[key] !== undefined && !store.options.includes(key));
  if (stray.length > 0) {
    throw new Error(
      `${stray.map((key) => OPTION_FLAGS[key]).join(", ")} ${stray.length > 1 ? "do" : "does"} not apply to ${store.label}; it accepts ${store.options.map((key) => OPTION_FLAGS[key]).join(", ") || "no scoping flags"}`,
    );
  }
  return { store, name: store.validateName(raw), flag };
}

export interface StoreProbe {
  id: StoreId;
  label: string;
  bin: string;
  /** The binary actually found on PATH (fly vs flyctl). */
  resolvedBin: string;
  installed: boolean;
  shorthand: string;
  nameLabel: string;
  flags: string[];
  installHint: string;
}

/** Which platform CLIs this machine has — the answer to "what can I delegate to?". */
export function probeStores(): StoreProbe[] {
  return STORES.map((store) => {
    const bin = resolveBin(store);
    return {
      id: store.id,
      label: store.label,
      bin: store.bin,
      resolvedBin: bin,
      installed: installed(bin, store.versionArgs),
      shorthand: store.shorthand,
      nameLabel: store.nameLabel,
      flags: store.options.map((key) => OPTION_FLAGS[key]),
      installHint: store.installHint,
    };
  });
}
