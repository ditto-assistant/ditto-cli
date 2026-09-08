/**
 * Per-platform name rules. Each store rejects names its platform would refuse
 * anyway, before a key is minted, with a message that says what is allowed.
 */

/** Env-var style: letters, digits, underscores; not leading with a digit. */
export function envStyleName(label: string, name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`"${name}" is not a valid ${label} name (letters, digits and underscores; cannot start with a digit)`);
  }
  return trimmed;
}

/** GitHub Actions additionally reserves the GITHUB_ prefix. */
export function validateSecretName(name: string): string {
  const trimmed = envStyleName("GitHub Actions secret", name);
  if (/^GITHUB_/i.test(trimmed)) {
    throw new Error(`"${name}" is reserved: GitHub Actions secret names cannot start with GITHUB_`);
  }
  return trimmed;
}

export function validateRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`--repo must be owner/repo, got "${repo}"`);
  }
  return trimmed;
}

/**
 * RFC 1123-ish resource names used by Google Secret Manager, Azure Key Vault
 * and Kubernetes: letters, digits, dashes (Google also allows underscores).
 */
export function resourceName(label: string, name: string, extra = ""): string {
  const trimmed = name.trim();
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9${extra}-]{0,253}$`);
  if (!pattern.test(trimmed)) {
    throw new Error(`"${name}" is not a valid ${label} name (letters, digits${extra.includes("_") ? ", underscores" : ""} and dashes, starting with a letter or digit)`);
  }
  return trimmed;
}

/** Free-form single-line title (1Password items). */
export function titleName(label: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /[\n\r]/.test(trimmed)) throw new Error(`"${name}" is not a valid ${label} (one non-empty line)`);
  return trimmed;
}

/** A Vault kv path: slash-separated segments, no leading or trailing slash. */
export function secretPath(label: string, name: string): string {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/.test(trimmed)) {
    throw new Error(`"${name}" is not a valid ${label} (letters, digits, dashes, dots, underscores and slashes)`);
  }
  return trimmed;
}

/** Rejects a scoping flag's value that the platform would not accept. */
export function slug(flag: string, value: string, pattern = /^[A-Za-z0-9_.-]+$/): string {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) throw new Error(`${flag} must be a valid name, got "${value}"`);
  return trimmed;
}
