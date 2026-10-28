import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_SECRET_BYTES = 16_384;
const MAX_CHILD_BYTES = 65_536;

/** Key bytes stay in process memory. Never include input in a diagnostic. */
export function validateProviderSecret(raw: string): string {
  const value = raw.trim();
  if (!value || Buffer.byteLength(value) > MAX_SECRET_BYTES || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw new Error("the provider key must be one non-empty token of at most 16 KiB; its value was not printed");
  }
  return value;
}

export async function readProviderSecretFromStream(input: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of input) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > MAX_SECRET_BYTES + 1024) throw new Error("provider key input is too large; its value was not printed");
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    try { return validateProviderSecret(buffer.toString("utf8")); }
    finally { buffer.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Hidden paste input, without readline echo or a raw-key command argument. */
export async function readProviderSecret(options: { stdin?: boolean; keyEnv?: string; prompt?: string }): Promise<string> {
  if (options.keyEnv !== undefined) {
    if (options.stdin) throw new Error("choose --key-env or --stdin, not both");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(options.keyEnv)) throw new Error("--key-env requires an environment variable name, never its value");
    return validateProviderSecret(process.env[options.keyEnv] ?? "");
  }
  if (options.stdin) {
    if (process.stdin.isTTY) throw new Error("--stdin expects a pipe; omit it for hidden terminal input");
    return readProviderSecretFromStream(process.stdin);
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("provide the key through --stdin or use provider-keys import; never put it in command arguments");
  }
  process.stderr.write(options.prompt ?? "Paste provider API key (hidden): ");
  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw;
    const decoder = new StringDecoder("utf8");
    let value = "";
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.off("end", onEnd);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stderr.write("\n");
      try { error ? reject(error) : resolve(validateProviderSecret(value)); }
      catch (err) { reject(err); }
      value = "";
    };
    const onData = (part: Buffer): void => {
      for (const char of decoder.write(part)) {
        if (char === "\u0003" || char === "\u0004") return finish(new Error("provider key entry cancelled"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " " && char !== "\u007f") value += char;
        else return finish(new Error("provider key input contains a control character"));
        if (Buffer.byteLength(value) > MAX_SECRET_BYTES) return finish(new Error("provider key input is too large"));
      }
    };
    const onError = (): void => finish(new Error("could not read the hidden provider key"));
    const onEnd = (): void => finish(new Error("provider key entry ended before confirmation"));
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

export interface GCloudSecretInput {
  secret: string;
  project?: string;
  account?: string;
  version?: string;
}

export interface GCloudSecretReference { project: string; secret: string; version: string }

/** Accepts a short secret name or an exact Secret Manager resource, with no global context changes. */
export function parseGCloudSecretReference(input: GCloudSecretInput): GCloudSecretReference {
  const resource = /^projects\/([^/]+)\/secrets\/([^/]+)(?:\/versions\/([^/]+))?$/.exec(input.secret);
  const project = resource?.[1] ?? input.project;
  const secret = resource?.[2] ?? input.secret;
  const version = resource?.[3] ?? input.version ?? "latest";
  if (resource && input.project && resource[1] !== input.project) throw new Error("the secret resource and --project name different projects");
  if (resource?.[3] && input.version && resource[3] !== input.version) throw new Error("the secret resource and --version name different versions");
  if (!project || !/^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]|[0-9]{6,30})$/.test(project)) {
    throw new Error("supply an explicit Google Cloud --project or a projects/PROJECT/secrets/SECRET resource");
  }
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(secret) || !/^(?:latest|[1-9][0-9]*)$/.test(version)) {
    throw new Error("invalid Google Secret Manager secret name or version");
  }
  return { project, secret, version };
}

function checkCloudOverrides(env: NodeJS.ProcessEnv): void {
  if (["CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT"].some(key => Boolean(env[key])) || Object.keys(env).some(key => key.startsWith("CLOUDSDK_API_ENDPOINT_OVERRIDES_") && Boolean(env[key]))) {
    throw new Error("Google Cloud credential overrides are set; remove them before importing with a verified gcloud account");
  }
}

/** cmd.exe needs batch wrappers; allow only scope-token characters before shell parsing. */
export function gcloudInvocation(args: string[], platform = process.platform): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const all = [...args, "--quiet", "--verbosity=none"];
  if (platform !== "win32") return { command: "gcloud", args: all };
  if (all.some(value => !/^[A-Za-z0-9@._=:/+(),-]+$/.test(value))) throw new Error("this gcloud scope cannot be safely passed to the Windows batch wrapper; use a standard account identity without shell metacharacters");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `""gcloud.cmd" ${all.map(value => `"${value}"`).join(" ")}"`], windowsVerbatimArguments: true };
}

/** Capture and discard diagnostics: platform failures can echo credential payloads. */
async function captureGCloud(args: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  const invocation = gcloudInvocation(args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_CORE_LOG_HTTP: "false", CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true" },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => { child.kill(); forceKill ??= setTimeout(() => child.kill("SIGKILL"), 2000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CHILD_BYTES) { overflow = true; stop(); chunk.fill(0); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { chunk.fill(0); });
    child.on("error", () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      for (const chunk of chunks) chunk.fill(0);
      reject(new Error("could not run gcloud; install the Google Cloud CLI and run gcloud auth login"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      if (code !== 0 || overflow || timedOut) {
        for (const chunk of chunks) chunk.fill(0);
        reject(new Error(timedOut ? "gcloud import timed out; no key was printed" : "gcloud import failed; check the selected account, project and Secret Manager access. Diagnostic output was suppressed"));
        return;
      }
      const result = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      resolve(result);
    });
  });
}

/** Agent-safe import: secret bytes never enter argv, stdout, a temp file, or an MCP argument. */
export async function importGCloudProviderSecret(input: GCloudSecretInput, env = process.env): Promise<{ key: string; source: GCloudSecretReference & { account: string } }> {
  checkCloudOverrides(env);
  const source = parseGCloudSecretReference(input);
  if (input.account && !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~@-]+$/.test(input.account)) throw new Error("invalid --account value");
  const accountsRaw = await captureGCloud(["auth", "list", "--format=json(account,status)"], env);
  let accounts: Array<{ account?: string; status?: string }>;
  try { accounts = JSON.parse(accountsRaw.toString("utf8")) as typeof accounts; }
  catch { throw new Error("gcloud did not return a valid account list; run gcloud auth login"); }
  finally { accountsRaw.fill(0); }
  if (!Array.isArray(accounts)) throw new Error("gcloud did not return an account list");
  const candidates = accounts.filter(item => item && typeof item.account === "string" && (input.account ? item.account === input.account : item.status === "ACTIVE"));
  if (candidates.length !== 1) throw new Error("select one signed-in gcloud account with --account, or run gcloud auth login");
  const account = candidates[0].account!;
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(account)) throw new Error("gcloud returned an invalid account identity");
  // Global flags override defaults without changing them. Read that effective
  // configuration so config-file impersonation or token-file overrides cannot
  // make an ordinary account listing look like proof of the fetching identity.
  const configRaw = await captureGCloud(["config", "list", "--format=json", "--account", account, "--project", source.project], env);
  let config: { core?: { account?: string; project?: string }; auth?: Record<string, unknown>; api_endpoint_overrides?: Record<string, unknown> };
  try { config = JSON.parse(configRaw.toString("utf8")) as typeof config; }
  catch { throw new Error("could not verify the effective gcloud configuration"); }
  finally { configRaw.fill(0); }
  if (!config || typeof config !== "object" || config.core?.account !== account || config.core?.project !== source.project) {
    throw new Error("effective gcloud account or project does not match the requested secret source");
  }
  if (Object.entries(config.auth ?? {}).some(([key, value]) => /impersonat|credential_file_override|access_token|token_host/.test(key) && Boolean(value) && value !== "(unset)") || Object.values(config.api_endpoint_overrides ?? {}).some(Boolean)) {
    throw new Error("effective gcloud configuration uses credential, impersonation or API endpoint overrides; remove them before importing");
  }
  const bytes = await captureGCloud(["secrets", "versions", "access", source.version, "--secret", source.secret, "--project", source.project, "--account", account], env);
  try { return { key: validateProviderSecret(bytes.toString("utf8")), source: { ...source, account } }; }
  finally { bytes.fill(0); }
}
