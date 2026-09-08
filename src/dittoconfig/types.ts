/**
 * Types for the `.ditto/` repository contract (schema version 1). They mirror
 * backend `pkg/dittoconfig` field for field; `schema.json` next to this file is
 * that package's JSON Schema export, and `schema.test` pins its checksum so a
 * schema change on either side is visible.
 */

export const DITTO_CONFIG_VERSION = 1;
export const DITTO_DIR = ".ditto";
export const CONFIG_FILE = "config.toml";
export const LOCAL_FILE = "local.toml";
export const ENDPOINTS_DIR = "endpoints";
export const MISE_FILE = "mise.toml";
export const SECRET_REF_PREFIX = "secret://";

export type HarnessKindSetting = "auto" | "claude-code" | "codex" | "none";
export type SessionSelection = "latest" | "explicit";
export type UnpushedPolicy = "refuse" | "acknowledge";

export interface Binding {
  apiBase: string;
}

export interface RepositorySection {
  name?: string;
  defaultEndpoint?: string;
  bindings?: Record<string, Binding>;
}

export interface TeleportSection {
  captureRoots?: string[];
  exclude?: string[];
  include?: string[];
  harness: { kind: HarnessKindSetting; session: SessionSelection };
  requiredMirrors?: string[];
  offload: { unpushed: UnpushedPolicy; destination?: string };
}

export interface ServiceDecl {
  name: string;
  image?: string;
  command?: string;
  port?: number;
  healthcheck?: string;
}

export interface EnvironmentSection {
  miseConfig?: string;
  services?: ServiceDecl[];
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
}

export interface TasksSection {
  setup?: string;
  build?: string;
  test?: string;
  lint?: string;
  dev?: string;
}

export interface PolicySection {
  repair: { maxAttempts: number; installOnly: boolean };
}

export interface DittoConfig {
  version: number;
  repository: RepositorySection;
  teleport: TeleportSection;
  environment: EnvironmentSection;
  tasks: TasksSection;
  policy: PolicySection;
}

export interface EndpointDecl {
  managed: boolean;
  name: string;
  slug?: string;
  description?: string;
  model?: string;
  fallbacks?: string[];
  settings?: Record<string, unknown>;
}

export type Layer = "default" | "workspace" | "repo" | "local" | "override";

export interface Source {
  layer: Layer;
  path?: string;
}

export interface EffectiveConfig {
  config: DittoConfig;
  endpoints: Record<string, EndpointDecl>;
  misePath: string;
  sources: Record<string, Source>;
  layers: Layer[];
  warnings: string[];
}

/** The record teleport embeds in a manifest as repos[].dittoConfig. */
export interface DittoConfigSummary {
  version: number;
  digest: string;
  misePath?: string;
  layers?: Layer[];
}

export function defaults(): DittoConfig {
  return {
    version: DITTO_CONFIG_VERSION,
    repository: {},
    teleport: { harness: { kind: "auto", session: "latest" }, offload: { unpushed: "refuse" } },
    environment: {},
    tasks: {},
    policy: { repair: { maxAttempts: 3, installOnly: true } },
  };
}
