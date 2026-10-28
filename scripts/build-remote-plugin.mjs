import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { npmInstallInvocation, readGitProvenance } from "./remote-plugin-build-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Validate source provenance before creating any output or installing dependencies.
const provenance = readGitProvenance(root);
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const target = path.resolve(process.argv[2] ?? path.join(root, ".tmp", `ditto-remote-${pkg.version}`));
// Never replace an existing build or arbitrary user directory.
await mkdir(path.dirname(target), { recursive: true });
await mkdir(target, { recursive: false });
await cp(path.join(root, "plugins", "ditto-remote"), target, { recursive: true });
const manifestFile = path.join(target, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
await writeFile(manifestFile, JSON.stringify({ ...manifest, version: pkg.version }, null, 2) + "\n");
// Local-only review identity: not a public marketplace or an approval claim.
await writeFile(path.join(target, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "ditto-remote-review", metadata: { description: "Local review candidate for Ditto Remote; not a public or approved marketplace" }, owner: { name: "Ditto" }, plugins: [{ name: manifest.name, source: "./", version: pkg.version, description: manifest.description }] }, null, 2) + "\n");
const runtime = path.join(target, "runtime");
await mkdir(runtime);
for (const file of ["package.json", "package-lock.json", "LICENSE"]) await cp(path.join(root, file), path.join(runtime, file));
await cp(path.join(root, "dist"), path.join(runtime, "dist"), { recursive: true });
// Exact registry tarballs and SHA512 integrity are fixed by the committed lock.
// Optional PTY binaries are irrelevant to a stdio-only plugin. Lifecycle scripts
// cannot run at build/install time. No package download occurs when Claude starts.
const npm = npmInstallInvocation();
const install = spawnSync(npm.command, npm.args, { cwd: runtime, stdio: "inherit" });
if (install.error || install.status !== 0) throw new Error(`Pinned plugin runtime install failed (${install.error?.code ?? `exit ${install.status}`}). Check the Node/npm installation and registry access.`);
const lock = await readFile(path.join(runtime, "package-lock.json"));
await writeFile(path.join(target, "BUILD.json"), JSON.stringify({ plugin: manifest.name, version: pkg.version, node: pkg.engines.node, lockSHA256: createHash("sha256").update(lock).digest("hex"), ...provenance, recipe: "npm ci && npm run plugin:build", channelApproval: "not-submitted" }, null, 2) + "\n");
console.log(`Review plugin: ${target}`);
