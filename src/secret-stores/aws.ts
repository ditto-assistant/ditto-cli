import { PATH_PLACEHOLDER, preflight } from "./exec.js";
import { resourceName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the AWS CLI from https://aws.amazon.com/cli (brew install awscli), then configure credentials with `aws configure` or `aws sso login`";

function target(options: StoreOptions): StoreTarget {
  const region = options.region ? slug("--region", options.region, /^[a-z0-9-]+$/) : undefined;
  return {
    describe: region ? `AWS Secrets Manager in ${region}` : "AWS Secrets Manager in the configured region",
    fields: region ? { region } : {},
  };
}

/**
 * AWS Secrets Manager. `--secret-string` accepts the AWS CLI's `file://`
 * paramfile syntax, so the plaintext is read from `/dev/stdin` rather than
 * argv. `create-secret` refuses an existing name, so a second attempt stores
 * a new version of it instead.
 */
export const aws: SecretStore = {
  id: "aws",
  label: "AWS Secrets Manager",
  bin: "aws",
  shorthand: "--aws-secret",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  options: ["region"],
  validateName: (name) => resourceName("AWS Secrets Manager secret", name, "_./+=@"),
  preflight: () =>
    preflight({
      bin: "aws",
      label: "AWS Secrets Manager",
      installHint: INSTALL_HINT,
      authArgs: ["sts", "get-caller-identity"],
      authHint: "Configure credentials with `aws configure` or `aws sso login` first.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const region = t.fields.region ? ["--region", t.fields.region] : [];
    return [
      {
        note: "aws secretsmanager create-secret",
        kind: "path",
        args: ["secretsmanager", "create-secret", "--name", name, "--secret-string", `file://${PATH_PLACEHOLDER}`, ...region],
      },
      {
        note: "aws secretsmanager put-secret-value",
        kind: "path",
        args: ["secretsmanager", "put-secret-value", "--secret-id", name, "--secret-string", `file://${PATH_PLACEHOLDER}`, ...region],
      },
    ];
  },
  usage: (name, t, gateway) => {
    const region = t.fields.region ? ` --region ${t.fields.region}` : "";
    return [
      "Read it back at runtime:",
      `  aws secretsmanager get-secret-value --secret-id ${name}${region} --query SecretString --output text`,
      `  # export OPENAI_API_KEY=$(…) with OPENAI_BASE_URL=${gateway.openaiBaseUrl}`,
      `  # or ANTHROPIC_AUTH_TOKEN with ANTHROPIC_BASE_URL=${gateway.anthropicBaseUrl}`,
    ];
  },
};
