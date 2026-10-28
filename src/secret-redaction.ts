/** Redact every exact occurrence, including JSON-escaped and URL-encoded forms. */
export function redactKnownSecrets(text: string, secrets: Array<string | undefined>): string {
  let safe = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
    for (const value of new Set(forms)) safe = safe.split(value).join("[redacted]");
  }
  return safe;
}

export function secretSafeError(error: unknown, secrets: Array<string | undefined>): string {
  return redactKnownSecrets(error instanceof Error ? error.message : "secret operation failed", secrets);
}

export function secretSafeMetadata<T>(value: T, secrets: Array<string | undefined>): T {
  return JSON.parse(redactKnownSecrets(JSON.stringify(value), secrets)) as T;
}
