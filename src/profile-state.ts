/**
 * Named endpoint profiles: pure state helpers shared by the auth store and the
 * `heyditto profile` commands. No I/O here, so the store can use them without
 * an import cycle.
 *
 * A profile binds a local name to an endpoint slug (and the inference route a
 * T3 provider for it should use). It is client-side only: nothing about the
 * endpoint, its routing or its policy changes. Profiles hold no credentials.
 *
 * Compatibility contract: `defaultEndpoint` stays the active profile's
 * endpoint, so an older CLI reading the same file still launches what the
 * active profile names. An install that never created a profile has an
 * implicit `default` profile backed by `defaultEndpoint` alone.
 */

export type ProfileInference = "router" | "cliproxy";

export interface EndpointProfile {
  /** Endpoint slug (or id) this profile launches against. */
  endpoint?: string;
  /** Inference route for `heyditto t3 setup --profile` (default cliproxy). */
  inference?: ProfileInference;
  createdAt?: string;
}

export interface ProfileFields {
  defaultEndpoint?: string;
  profiles?: Record<string, EndpointProfile>;
  activeProfile?: string;
}

/** The profile an install without saved profiles has implicitly. */
export const LEGACY_PROFILE = "default";

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function validateProfileName(raw: string): string {
  const name = raw.trim();
  if (!NAME.test(name)) {
    throw new Error(`invalid profile name "${raw}": use 1-40 lowercase letters, digits, '-' or '_', starting with a letter or digit`);
  }
  return name;
}

export interface ProfileView {
  profiles: Record<string, EndpointProfile>;
  active: string;
  /** True when nothing is saved yet and `default` stands for `defaultEndpoint`. */
  implicit: boolean;
}

export function profileView(stored: ProfileFields | undefined): ProfileView {
  const saved = stored?.profiles;
  if (saved && typeof saved === "object" && Object.keys(saved).length > 0) {
    const names = Object.keys(saved).sort();
    const active = stored?.activeProfile && Object.hasOwn(saved, stored.activeProfile)
      ? stored.activeProfile
      : Object.hasOwn(saved, LEGACY_PROFILE) ? LEGACY_PROFILE : names[0];
    return { profiles: saved, active, implicit: false };
  }
  const endpoint = stored?.defaultEndpoint?.trim();
  return { profiles: { [LEGACY_PROFILE]: endpoint ? { endpoint } : {} }, active: LEGACY_PROFILE, implicit: true };
}

/**
 * The saved form of the profiles, migrating an implicit legacy default into a
 * real `default` profile (made active) the first time anything is saved. An
 * install with no default endpoint has nothing to preserve, so the first
 * profile it creates becomes active instead.
 */
export function materialize(stored: ProfileFields | undefined): { profiles: Record<string, EndpointProfile>; active: string | undefined } {
  const view = profileView(stored);
  if (!view.implicit) return { profiles: { ...view.profiles }, active: view.active };
  const legacy = view.profiles[LEGACY_PROFILE];
  if (legacy.endpoint) return { profiles: { [LEGACY_PROFILE]: { ...legacy } }, active: LEGACY_PROFILE };
  return { profiles: {}, active: undefined };
}

/** Patch that saves `profiles`/`activeProfile` and keeps `defaultEndpoint` mirroring the active one. */
export function profilesPatch(profiles: Record<string, EndpointProfile>, active: string | undefined): ProfileFields {
  const names = Object.keys(profiles);
  if (names.length === 0) return { profiles: undefined, activeProfile: undefined };
  const chosen = active && Object.hasOwn(profiles, active) ? active : names.sort()[0];
  return { profiles, activeProfile: chosen, defaultEndpoint: profiles[chosen].endpoint };
}

/**
 * Patch that sets (or clears) the endpoint of one profile. With no saved
 * profiles and the implicit `default`, this is exactly the old behaviour:
 * only `defaultEndpoint` changes.
 */
export function setProfileEndpointPatch(stored: ProfileFields | undefined, name: string, endpoint: string | undefined): ProfileFields {
  const view = profileView(stored);
  if (view.implicit && name === LEGACY_PROFILE) return { defaultEndpoint: endpoint };
  if (!Object.hasOwn(view.profiles, name)) throw new Error(unknownProfileMessage(name, view));
  const { profiles, active } = materialize(stored);
  const next = { ...profiles[name] };
  if (endpoint) next.endpoint = endpoint;
  else delete next.endpoint;
  return profilesPatch({ ...profiles, [name]: next }, active);
}

export function unknownProfileMessage(name: string, view: ProfileView): string {
  return `no profile named "${name}". Profiles: ${Object.keys(view.profiles).sort().join(", ")} (create one with \`heyditto profile create ${name} --endpoint <slug>\`)`;
}

/** Title-cases a profile name for a provider label: `subnet` → `Subnet`, `my-work` → `My Work`. */
export function profileLabel(name: string): string {
  return name.split(/[-_]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}
