import { createReadStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import type { Command, Option } from "commander";
import { apiFetch, resolveCompany } from "./api.js";
import { readStoredAuth } from "./store.js";

interface IAMOptions { org?: string; output?: string; file?: string; secretFile?: string; revision?: string; domain?: string; dryRun?: boolean }
const maxPayloadBytes = 64 * 1024;

async function companyID(options: IAMOptions): Promise<string> {
  const org = options.org?.trim() || (await readStoredAuth())?.defaultCompany;
  if (!org) throw new Error("pass --org <slug> or select one with heyditto orgs use");
  // Service accounts may not appear in the human membership directory. An
  // exact UUID is only routing; Manage still resolves trusted current identity
  // and organization scope on the server. Slugs use the supported directory.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org)) return org.toLowerCase();
  return (await resolveCompany(org)).id;
}

async function policyFile(filename: string | undefined): Promise<Record<string, unknown>> {
  if (!filename) throw new Error("pass --file <JSON file>, or --file - to read stdin");
  const input = filename === "-" ? process.stdin : createReadStream(filename);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxPayloadBytes) {
      if (filename !== "-") input.destroy();
      throw new Error("IAM request exceeds 64 KiB");
    }
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("IAM file must contain one valid JSON object"); }
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("IAM file must contain one JSON object");
  return value as Record<string, unknown>;
}

function revision(options: IAMOptions): number {
  const raw = options.revision ?? "";
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("--revision must be a non-negative integer read from the current IAM state");
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error("--revision exceeds the safe integer range");
  return n;
}

async function execute(operation: string, options: IAMOptions, payload?: Record<string, unknown>): Promise<void> {
  const id = await companyID(options);
  const result = await apiFetch(`/api/v5/companies/${encodeURIComponent(id)}/iam/${operation}`, {
    method: payload === undefined ? "GET" : "POST", body: payload,
  });
  // Policy objects and access explanations retain their names and revisions in
  // every output mode; never derive permission decisions in the client.
  if (operation === "explain" && options.output !== "json" && options.output !== "raw" &&
      result && typeof result === "object" && !(result as {enforced?: boolean}).enforced) {
    process.stdout.write("IAM is not enforcing this domain. This policy result is hypothetical; native authorization still decides access.\n");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function registerIAMCommands(program: Command, outputOption: () => Option, orgOption: () => Option): void {
  const iam = program.command("iam").description("organization permission catalog, roles, scoped bindings and access explanations");
  const scoped = (cmd: Command) => cmd.addOption(orgOption()).addOption(outputOption());
  scoped(iam.command("catalog").description("read explicit permissions and versioned managed roles"))
    .action((o: IAMOptions) => execute("catalog", o));
  const roles = iam.command("roles").description("managed and organization-defined custom roles");
  scoped(roles.command("list", { isDefault: true }).description("list current role versions"))
    .action((o: IAMOptions) => execute("roles.list", o));
  scoped(roles.command("put").description("create or revise a role; file contains the expected revision")
    .requiredOption("--file <file>", "canonical JSON policy; '-' reads stdin"))
    .action(async (o: IAMOptions) => execute("roles.put", o, await policyFile(o.file)));
  scoped(roles.command("delete").description("delete an unbound custom role at its current revision")
    .argument("<role-id>").requiredOption("--revision <number>", "current role revision"))
    .action((id: string, o: IAMOptions) => execute("roles.delete", o, { id, expected_revision: revision(o) }));
  const bindings = iam.command("bindings").description("resource-scoped roles and boundaries for users and service accounts");
  scoped(bindings.command("list", { isDefault: true }).description("list current bindings"))
    .action((o: IAMOptions) => execute("bindings.list", o));
  scoped(bindings.command("put").description("create or revise a binding; role revision is pinned")
    .requiredOption("--file <file>", "canonical JSON binding; '-' reads stdin"))
    .action(async (o: IAMOptions) => execute("bindings.put", o, await policyFile(o.file)));
  scoped(bindings.command("delete").description("revoke a binding at its current revision")
    .argument("<binding-id>").requiredOption("--revision <number>", "current binding revision"))
    .action((id: string, o: IAMOptions) => execute("bindings.delete", o, { id, expected_revision: revision(o) }));
  const credentials = iam.command("service-credentials").description("issue and revoke short-lived endpoint-scoped service credentials");
  scoped(credentials.command("issue").description("write the one-time secret to a new private file")
    .requiredOption("--file <file>", "JSON request with service_uid, endpoint_id, actions and lifetime_seconds")
    .requiredOption("--secret-file <file>", "new secret file, created with mode 0600"))
    .action(async (o: IAMOptions) => {
      const company = await companyID(o);
      const payload = await policyFile(o.file);
      const filename = o.secretFile!;
      const file = await open(filename, "wx", 0o600);
      let issued = false;
      try {
        const result = await apiFetch<Record<string, unknown>>(`/api/v5/companies/${encodeURIComponent(company)}/iam/serviceCredentials.issue`, { method: "POST", body: payload });
        const { secret, ...metadata } = result;
        if (typeof secret !== "string" || !/^ditto_svc_[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("server returned an invalid credential");
        issued = true;
        try { await file.writeFile(`${secret}\n`); }
        catch { throw new Error(`credential ${String(metadata.id)} was issued but could not be written; revoke it`); }
        process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
      } finally {
        await file.close();
        if (!issued) await unlink(filename).catch(() => {});
      }
    });
  scoped(credentials.command("revoke").description("revoke an issued credential")
    .argument("<credential-id>"))
    .action((id: string, o: IAMOptions) => execute("serviceCredentials.revoke", o, { id }));
  scoped(iam.command("explain").description("explain access with the same engine that enforces it")
    .requiredOption("--file <file>", "canonical check request; omit principal for yourself; '-' reads stdin"))
    .action(async (o: IAMOptions) => execute("explain", o, await policyFile(o.file)));
  scoped(iam.command("audit").description("read audited policy changes"))
    .action((o: IAMOptions) => execute("audit.list", o));
  const mode = iam.command("mode").description("read or explicitly change the IAM rollout mode for a supported domain");
  scoped(mode.command("get", { isDefault: true }).description("read current mode and revision")
    .option("--domain <domain>", "authorization domain", "inference"))
    .action((o: IAMOptions) => execute("mode.get", o, { domain: o.domain }));
  scoped(mode.command("set").description("preview or explicitly change mode; never changes it implicitly")
    .argument("<mode>", "legacy, shadow or enforce")
    .option("--domain <domain>", "authorization domain", "inference")
    .requiredOption("--revision <number>", "current mode revision")
    .option("--dry-run", "validate without changing mode"))
    .action((value: string, o: IAMOptions) => {
      if (!["legacy", "shadow", "enforce"].includes(value)) throw new Error("mode must be legacy, shadow or enforce");
      return execute("mode.set", o, { domain: o.domain, mode: value, expected_revision: revision(o), dry_run: o.dryRun ?? false });
    });
}
