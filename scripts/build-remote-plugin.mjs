import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
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
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(npm, ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtime, stdio: "inherit" });
if (install.status !== 0) throw new Error("Pinned plugin runtime install failed");
const lock = await readFile(path.join(runtime, "package-lock.json"));
await writeFile(path.join(target, "BUILD.json"), JSON.stringify({ plugin: manifest.name, version: pkg.version, node: pkg.engines.node, lockSHA256: createHash("sha256").update(lock).digest("hex"), sourceRevision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), dirty: spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() !== "", recipe: "npm ci && npm run plugin:build", channelApproval: "not-submitted" }, null, 2) + "\n");
console.log(`Review plugin: ${target}`);
