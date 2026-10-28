/** Redact every exact occurrence, including JSON-escaped and URL-encoded forms. */
export function redactKnownSecrets(text: string, secrets: Array<string | undefined>): string {
  let safe = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
    for (const value of [...new Set(forms)].sort((a, b) => b.length - a.length)) safe = safe.split(value).join("[redacted]");
  }
  return safe;
}

export function secretSafeError(error: unknown, secrets: Array<string | undefined>): string {
  return redactKnownSecrets(error instanceof Error ? error.message : "secret operation failed", secrets);
}

export function secretSafeMetadata<T>(value: T, secrets: Array<string | undefined>): T {
  const redact = (item: unknown): unknown => {
    if (typeof item === "string") return redactKnownSecrets(item, secrets);
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, value]) => [redactKnownSecrets(key, secrets), redact(value)]));
    return item;
  };
  // Redact parsed values and keys, never JSON delimiters or escape sequences.
  return redact(JSON.parse(JSON.stringify(value))) as T;
}
