import { spawnSync } from "node:child_process";

/**
 * Thin wrapper over the GitHub CLI for storing a freshly minted endpoint key
 * as an Actions secret. The plaintext only ever travels over `gh`'s stdin:
 * `gh secret set` reads the value from stdin when `--body` is omitted, so the
 * key never appears in argv, `ps`, shell history or our own output.
 */

export const GH_INSTALL_HINT =
  "install the GitHub CLI from https://cli.github.com (brew install gh / winget install GitHub.cli), then run `gh auth login`";

/** Where the secret lands. Exactly one of repo (with optional env) or org. */
export type SecretTarget = { kind: "repo"; repo: string } | { kind: "env"; repo: string; env: string } | { kind: "org"; org: string };

/** GitHub Actions secret names: letters, digits, underscores; not starting with a digit or GITHUB_. */
export function validateSecretName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`--gh-secret "${name}" is not a valid secret name (letters, digits and underscores; cannot start with a digit)`);
  }
  if (/^GITHUB_/i.test(trimmed)) throw new Error(`--gh-secret "${name}" is reserved: secret names cannot start with GITHUB_`);
  return trimmed;
}

export function validateRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`--repo must be owner/repo, got "${repo}"`);
  }
  return trimmed;
}

interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function gh(args: string[], input?: string): GhResult {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" },
  });
  const missing = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ENOENT";
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", missing };
}

function trimmedStderr(res: GhResult): string {
  return (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

/** Fails fast when `gh` is missing or not signed in; nothing has been minted at this point. */
export function preflightGh(): void {
  const version = gh(["--version"]);
  if (version.missing || version.status !== 0) {
    throw new Error(`--gh-secret needs the GitHub CLI (gh) on PATH; ${GH_INSTALL_HINT}`);
  }
  const auth = gh(["auth", "status"]);
  if (auth.status !== 0) {
    throw new Error(`gh is not signed in (\`gh auth status\` failed${trimmedStderr(auth) ? `: ${trimmedStderr(auth)}` : ""}). Run \`gh auth login\` first.`);
  }
}

/** Resolves owner/repo for the current directory the same way `gh` does (git remotes + gh config). */
export function resolveRepoFromCwd(): string {
  const res = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const repo = res.stdout.trim();
  if (res.status !== 0 || !repo) {
    throw new Error(
      `could not determine the GitHub repository from the current directory${trimmedStderr(res) ? ` (${trimmedStderr(res)})` : ""}. Pass --repo owner/repo, or run from inside a clone with a GitHub remote.`,
    );
  }
  return repo;
}

export function describeTarget(target: SecretTarget): string {
  switch (target.kind) {
    case "repo":
      return `${target.repo} (repository secret)`;
    case "env":
      return `${target.repo}, environment ${target.env}`;
    case "org":
      return `organization ${target.org}`;
  }
}

/** Argv for `gh secret set`; the value is deliberately absent (it goes on stdin). */
export function secretSetArgs(name: string, target: SecretTarget): string[] {
  const args = ["secret", "set", name];
  switch (target.kind) {
    case "repo":
      args.push("--repo", target.repo);
      break;
    case "env":
      args.push("--repo", target.repo, "--env", target.env);
      break;
    case "org":
      args.push("--org", target.org);
      break;
  }
  return args;
}

/** Stores `value` as a GitHub Actions secret. Throws with gh's last stderr lines on failure. */
export function setGitHubSecret(name: string, target: SecretTarget, value: string): void {
  const res = gh(secretSetArgs(name, target), value);
  if (res.missing) throw new Error(`gh disappeared from PATH while setting the secret; ${GH_INSTALL_HINT}`);
  if (res.status !== 0) {
    throw new Error(`gh secret set ${name} failed${trimmedStderr(res) ? `: ${trimmedStderr(res)}` : ` (exit ${res.status})`}`);
  }
}
