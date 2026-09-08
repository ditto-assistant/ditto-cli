/**
 * Shared shape for every secret store the CLI can hand a freshly minted key to.
 *
 * The contract every store must honour: the plaintext key travels to the
 * platform CLI over stdin (directly, or through a path the CLI reads such as
 * `/dev/stdin`), never through argv. Anything in argv is visible to every
 * process on the machine via `ps`, and lands in shell history when a human
 * copies the command.
 */

/** Stable ids, also the values accepted by `--store`. */
export const STORE_IDS = [
  "github",
  "gitlab",
  "aws",
  "gcloud",
  "azure",
  "1password",
  "vault",
  "doppler",
  "cloudflare",
  "vercel",
  "kubernetes",
  "fly",
] as const;

export type StoreId = (typeof STORE_IDS)[number];

/** Flags that scope where a secret lands. Each store reads the ones it supports. */
export interface StoreOptions {
  /** Secret / variable / item name, from --secret or a store shorthand. */
  secret?: string;
  repo?: string;
  env?: string;
  org?: string;
  region?: string;
  project?: string;
  keyVault?: string;
  opVault?: string;
  mount?: string;
  field?: string;
  dopplerConfig?: string;
  worker?: string;
  vercelTarget?: string;
  namespace?: string;
  k8sKey?: string;
  app?: string;
}

/** Every option name a store may claim, for the "unsupported flag" check. */
export type StoreOptionKey = Exclude<keyof StoreOptions, "secret">;

/**
 * Where the secret lands, resolved from the flags (and sometimes the current
 * directory). `fields` are echoed into `--output json`; `describe` is the human
 * sentence in the confirmation prompt and the success line.
 */
export interface StoreTarget {
  describe: string;
  fields: Record<string, string>;
}

/**
 * How the plaintext reaches the platform CLI.
 *
 * - `stdin`: the value (or a rendered `payload`) is written to the child's stdin.
 * - `path`: argv names a file the CLI reads. On POSIX that is `/dev/stdin` with
 *   the value piped in; on Windows the runner writes a 0600 temp file and
 *   substitutes its path for the `{}` placeholder.
 *
 * `note` explains what the attempt does, for the error message when every
 * attempt fails.
 */
export type Delivery = {
  note: string;
  /** Wraps the plaintext (a JSON template, a KEY=VALUE line) before it is sent. */
  payload?: (value: string) => string;
} & ({ kind: "stdin"; args: string[] } | { kind: "path"; args: string[] });

export interface Gateway {
  /** OpenAI-compatible base, e.g. https://inference.heyditto.ai/v1 */
  openaiBaseUrl: string;
  /** Anthropic base (no /v1), e.g. https://inference.heyditto.ai */
  anthropicBaseUrl: string;
}

export interface SecretStore {
  id: StoreId;
  /** Human label, e.g. "GitHub Actions". */
  label: string;
  /** Executable the CLI delegates to. */
  bin: string;
  /** Other names the same CLI ships under, e.g. flyctl for fly. */
  altBins?: readonly string[];
  /** How this CLI reports its version (az and vault do not take --version). */
  versionArgs?: readonly string[];
  /** Shorthand flag that both selects this store and names the secret. */
  shorthand: string;
  /** What the shorthand's value is called in help text, e.g. "NAME" or "TITLE". */
  nameLabel: string;
  /** How to get the CLI and sign in, quoted in errors when it is missing. */
  installHint: string;
  /** Scoping options this store understands; anything else is rejected. */
  options: readonly StoreOptionKey[];
  /** Rejects names the platform will not accept. Returns the trimmed name. */
  validateName(name: string): string;
  /** Cheap failure before anything is minted: binary present and signed in. */
  preflight(): void;
  /** Reads the scoping flags; may infer from the cwd the way `gh` does. */
  resolveTarget(options: StoreOptions): StoreTarget;
  /**
   * Attempts, in order, for storing `name` at `target`. Several platforms
   * separate "create" from "add a new version", so the second attempt runs
   * only when the first fails (e.g. the secret already exists).
   */
  deliveries(name: string, target: StoreTarget): Delivery[];
  /** How to read the secret back / wire it into a runtime. */
  usage(name: string, target: StoreTarget, gateway: Gateway): string[];
  /** Key label in the Ditto app. Defaults to `<store>:<target>:<name>`. */
  keyName?(name: string, target: StoreTarget): string;
  /** Platform reference for the stored value, echoed in `--output json`. */
  snippet?(name: string, target: StoreTarget): string;
}
