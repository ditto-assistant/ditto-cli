import { preflight, run, trimmedStderr } from "./exec.js";
import { envStyleName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

const INSTALL_HINT =
  "install the GitLab CLI from https://gitlab.com/gitlab-org/cli (brew install glab), then run `glab auth login`";

/** Resolves the project for the current directory the way glab itself does. */
function resolveProjectFromCwd(): string {
  const res = run("glab", ["repo", "view", "-F", "json"]);
  if (res.status === 0) {
    try {
      const parsed = JSON.parse(res.stdout) as { path_with_namespace?: string };
      if (parsed.path_with_namespace) return parsed.path_with_namespace;
    } catch {
      // Fall through to the shared error below.
    }
  }
  const detail = trimmedStderr(res);
  throw new Error(
    `could not determine the GitLab project from the current directory${detail ? ` (${detail})` : ""}. Pass --project group/project, or run from inside a clone with a GitLab remote.`,
  );
}

function target(options: StoreOptions): StoreTarget {
  const group = options.org?.trim();
  const env = options.env?.trim();
  if (group) {
    if (options.project) throw new Error("--org (GitLab group) cannot be combined with --project");
    const g = slug("--org", group, /^[A-Za-z0-9_.\-/]+$/);
    return { describe: `group ${g}`, fields: { kind: "group", group: g, ...(env ? { env } : {}) } };
  }
  const project = options.project ? slug("--project", options.project, /^[A-Za-z0-9_.\-/]+$/) : resolveProjectFromCwd();
  return {
    describe: `${project}${env ? `, environment scope ${env}` : ""} (CI/CD variable)`,
    fields: { kind: "project", project, ...(env ? { env } : {}) },
  };
}

/**
 * GitLab CI/CD variables. `glab variable set KEY` reads the value from stdin
 * when no value argument is given (`cat file | glab variable set KEY`), and
 * `--masked` keeps it out of job logs.
 */
export const gitlab: SecretStore = {
  id: "gitlab",
  label: "GitLab CI/CD",
  bin: "glab",
  shorthand: "--gitlab-var",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  options: ["project", "org", "env"],
  validateName: (name) => envStyleName("GitLab CI/CD variable", name),
  preflight: () =>
    preflight({
      bin: "glab",
      label: "GitLab CI/CD",
      installHint: INSTALL_HINT,
      authArgs: ["auth", "status"],
      authHint: "Run `glab auth login` first.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const scope = (verb: string) => {
      const args = ["variable", verb, name, "--masked"];
      if (t.fields.kind === "group") args.push("--group", t.fields.group);
      else args.push("--repo", t.fields.project);
      if (t.fields.env) args.push("--scope", t.fields.env);
      return args;
    };
    // `set` refuses an existing variable, so fall back to `update`.
    return [
      { note: "glab variable set", kind: "stdin", args: scope("set") },
      { note: "glab variable update", kind: "stdin", args: scope("update") },
    ];
  },
  usage: (name, _t, gateway) => [
    "Use it in .gitlab-ci.yml:",
    "  variables:",
    `    ANTHROPIC_BASE_URL: ${gateway.anthropicBaseUrl}`,
    `  # ${name} is injected into every job; for OpenAI-compatible clients set`,
    `  # OPENAI_API_KEY: $${name} with OPENAI_BASE_URL: ${gateway.openaiBaseUrl}`,
  ],
};
