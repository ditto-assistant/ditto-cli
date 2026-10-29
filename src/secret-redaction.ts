/** Redact every exact occurrence, including JSON-escaped and URL-encoded forms. */
export function redactKnownSecrets(text: string, secrets: Array<string | undefined>): string {
  let safe = text;
  const forms = new Map<string, boolean>();
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) if (!forms.has(form)) forms.set(form, false);
    for (const form of [encodeURIComponent(secret), new URLSearchParams({ secret }).toString().slice("secret=".length)]) forms.set(form, true);
  }
  const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [value, encoded] of [...forms].sort(([a], [b]) => b.length - a.length)) {
    if (!encoded) { safe = safe.split(value).join("[redacted]"); continue; }
    // Percent hex is case-insensitive, while unescaped credential letters are not.
    const pattern = value.split(/(%[a-f0-9]{2})/i).map(part => /^%[a-f0-9]{2}$/i.test(part) ? part.replace(/[a-f]/gi, char => `[${char.toLowerCase()}${char.toUpperCase()}]`) : literal(part)).join("");
    safe = safe.replace(new RegExp(pattern, "g"), "[redacted]");
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
