import { preflight, run, trimmedStderr } from "./exec.js";
import { validateRepo, validateSecretName } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

export const GH_INSTALL_HINT =
  "install the GitHub CLI from https://cli.github.com (brew install gh / winget install GitHub.cli), then run `gh auth login`";

/** Resolves owner/repo for the current directory the same way `gh` does (git remotes + gh config). */
export function resolveRepoFromCwd(): string {
  const res = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const repo = res.stdout.trim();
  if (res.status !== 0 || !repo) {
    const detail = trimmedStderr(res);
    throw new Error(
      `could not determine the GitHub repository from the current directory${detail ? ` (${detail})` : ""}. Pass --repo owner/repo, or run from inside a clone with a GitHub remote.`,
    );
  }
  return repo;
}

/** Where the secret lands: a repository, one of its environments, or an organization. */
function target(options: StoreOptions): StoreTarget {
  const org = options.org?.trim();
  const env = options.env?.trim();
  if (org) {
    if (options.repo || env) {
      throw new Error("--org cannot be combined with --repo or --env (organization secrets are not scoped to one repository)");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(org)) throw new Error(`--org must be an organization login, got "${options.org}"`);
    return { describe: `organization ${org}`, fields: { kind: "org", org } };
  }
  const repo = options.repo ? validateRepo(options.repo) : resolveRepoFromCwd();
  if (env) return { describe: `${repo}, environment ${env}`, fields: { kind: "env", repo, env } };
  return { describe: `${repo} (repository secret)`, fields: { kind: "repo", repo } };
}

/**
 * GitHub Actions. `gh secret set` reads the value from stdin when `--body` is
 * omitted, so the key never appears in argv, `ps`, shell history or our output.
 */
export const github: SecretStore = {
  id: "github",
  label: "GitHub Actions",
  bin: "gh",
  shorthand: "--gh-secret",
  nameLabel: "NAME",
  installHint: GH_INSTALL_HINT,
  options: ["repo", "env", "org"],
  validateName: validateSecretName,
  preflight: () =>
    preflight({
      bin: "gh",
      label: "GitHub Actions",
      installHint: GH_INSTALL_HINT,
      authArgs: ["auth", "status"],
      authHint: "Run `gh auth login` first.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const args = ["secret", "set", name];
    if (t.fields.kind === "org") args.push("--org", t.fields.org);
    else if (t.fields.kind === "env") args.push("--repo", t.fields.repo, "--env", t.fields.env);
    else args.push("--repo", t.fields.repo);
    return [{ note: "gh secret set", kind: "stdin", args }];
  },
  // Both predate the multi-store registry and are part of the published
  // contract: key labels in the app and the `snippet` field in --output json.
  keyName: (name, t) => (t.fields.kind === "org" ? `gh-secret:${name}` : `gh:${t.fields.repo}:${name}`),
  snippet: (name) => `\${{ secrets.${name} }}`,
  usage: (name, _t, gateway) => [
    "Use it in a workflow step:",
    "  env:",
    `    ANTHROPIC_AUTH_TOKEN: \${{ secrets.${name} }}`,
    `    ANTHROPIC_BASE_URL: ${gateway.anthropicBaseUrl}`,
    `  # OpenAI-compatible clients: OPENAI_API_KEY: \${{ secrets.${name} }} with OPENAI_BASE_URL: ${gateway.openaiBaseUrl}`,
  ],
};
