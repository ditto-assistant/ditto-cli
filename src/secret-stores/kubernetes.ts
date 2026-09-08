import { PATH_PLACEHOLDER, preflight } from "./exec.js";
import { resourceName, slug } from "./naming.js";
import type { SecretStore, StoreOptions, StoreTarget } from "./types.js";

/** The merge patch the first attempt sends: adds this key, leaves the rest. */
function mergePatch(key: string, value: string): string {
  return `${JSON.stringify({ stringData: { [key]: value } })}\n`;
}

const INSTALL_HINT =
  "install kubectl from https://kubernetes.io/docs/tasks/tools (brew install kubectl), then point it at a cluster with `kubectl config use-context`";

function target(options: StoreOptions): StoreTarget {
  const namespace = options.namespace ? slug("--namespace", options.namespace, /^[a-z0-9-]+$/) : "default";
  const key = options.k8sKey ? slug("--k8s-key", options.k8sKey, /^[A-Za-z0-9_.-]+$/) : "key";
  return { describe: `Kubernetes secret in namespace ${namespace} (key ${key})`, fields: { namespace, key } };
}

/**
 * Kubernetes. The manifest is built here and piped in, so the plaintext never
 * reaches argv (`--from-literal` would) and never touches disk. A merge patch
 * comes first because it leaves the secret's other keys alone; `apply` is the
 * fallback that creates the secret when it does not exist yet.
 */
export const kubernetes: SecretStore = {
  id: "kubernetes",
  label: "Kubernetes",
  bin: "kubectl",
  shorthand: "--k8s-secret",
  nameLabel: "NAME",
  installHint: INSTALL_HINT,
  versionArgs: ["version", "--client=true"],
  options: ["namespace", "k8sKey"],
  validateName: (name) => {
    const trimmed = name.trim();
    if (trimmed !== trimmed.toLowerCase()) {
      throw new Error(`"${name}" is not a valid Kubernetes secret name (lowercase letters, digits, dashes and dots only)`);
    }
    return resourceName("Kubernetes secret", trimmed, ".");
  },
  preflight: () =>
    preflight({
      bin: "kubectl",
      label: "Kubernetes",
      installHint: INSTALL_HINT,
      versionArgs: kubernetes.versionArgs,
      authArgs: ["config", "current-context"],
      authHint: "Select a cluster with `kubectl config use-context <name>` first.",
    }),
  resolveTarget: target,
  deliveries: (name, t) => {
    const { namespace, key } = t.fields;
    return [
      {
        note: "kubectl patch secret",
        kind: "path",
        args: ["patch", "secret", name, "--namespace", namespace, "--type", "merge", "--patch-file", PATH_PLACEHOLDER],
        payload: (value) => mergePatch(key, value),
      },
      {
        note: "kubectl apply",
        kind: "stdin",
        args: ["apply", "--namespace", namespace, "-f", "-"],
        payload: (value) =>
          `${JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: { name, namespace },
            stringData: { [key]: value },
          })}\n`,
      },
    ];
  },
  usage: (name, t, gateway) => [
    "Mount it into a pod:",
    "  env:",
    "    - name: OPENAI_API_KEY",
    `      valueFrom: { secretKeyRef: { name: ${name}, key: ${t.fields.key} } }`,
    `    - name: OPENAI_BASE_URL`,
    `      value: ${gateway.openaiBaseUrl}`,
  ],
};

