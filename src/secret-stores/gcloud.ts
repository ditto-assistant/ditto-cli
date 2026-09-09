import { preflight, run, trimmedStderr } from "./exec.js";
import { resourceName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the Google Cloud CLI from https://cloud.google.com/sdk/docs/install (brew install --cask google-cloud-sdk), then run `gcloud auth login`";

/** The project gcloud is currently configured for, so --project stays optional. */
function resolveProjectFromConfig(): string {
  const res = run("gcloud", ["config", "get-value", "project"]);
  const project = res.stdout.trim();
  if (res.status !== 0 || !project || project === "(unset)") {
    const detail = trimmedStderr(res);
    throw new Error(
      `gcloud has no active project${detail ? ` (${detail})` : ""}. Pass --project my-project, or run \`gcloud config set project my-project\`.`,
    );
  }
  return project;
}

function target(options: StoreOptions): StoreTarget {
  const project = options.project ? slug("--project", options.project) : resolveProjectFromConfig();
  return { describe: `Google Secret Manager in project ${project}`, fields: { project } };
}

/**
 * Google Secret Manager. Both `secrets create` and `versions add` read the
 * payload from stdin with `--data-file=-`; creation fails when the secret
 * already exists, so the second attempt adds a version to it.
 */
export const gcloud: SecretStore = {
  id: "gcloud",
  label: "Google Secret Manager",
  bin: "gcloud",
  shorthand: "--gcp-secret",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  options: ["project"],
  validateName: (name) => resourceName("Google Secret Manager secret", name, "_"),
  preflight: () =>
    preflight({
      bin: "gcloud",
      label: "Google Secret Manager",
      installHint: INSTALL_HINT,
      authArgs: ["auth", "print-access-token"],
      authHint: "Run `gcloud auth login` first.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const project = ["--project", t.fields.project];
    return [
      {
        note: "gcloud secrets create",
        kind: "stdin",
        args: ["secrets", "create", name, "--data-file=-", "--replication-policy=automatic", ...project],
      },
      {
        note: "gcloud secrets versions add",
        kind: "stdin",
        args: ["secrets", "versions", "add", name, "--data-file=-", ...project],
      },
    ];
  },
  usage: (name, t, gateway) => [
    "Read it back at runtime:",
    `  gcloud secrets versions access latest --secret=${name} --project=${t.fields.project}`,
    `  # export OPENAI_API_KEY=$(…) with OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
    `  # Cloud Run: gcloud run deploy … --set-secrets OPENAI_API_KEY=${name}:latest`,
  ],
};
