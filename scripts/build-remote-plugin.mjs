import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { x } from "tar";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { npmInstallInvocation, readGitProvenance, verifyRuntimeArchive } from "./remote-plugin-build-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const provenance = readGitProvenance(root);
if (provenance.dirty) throw new Error("Build the review plugin from a clean committed checkout.");
const pin = JSON.parse(await readFile(path.join(root, "plugins/ditto-remote/runtime-release.json"), "utf8"));
const archive = process.argv[3];
if (!archive) throw new Error("Supply the pinned npm runtime archive: npm run plugin:build -- <fresh-output> <cli-version.tgz>");
// Verify BEFORE extracting, creating output, or invoking npm. The archive is an
// explicit local input; this builder never silently selects a newer release.
const archiveBytes = await readFile(archive);
verifyRuntimeArchive(archiveBytes, pin);
const lock = await readFile(path.join(root, "package-lock.json"));
const lockSHA256 = createHash("sha256").update(lock).digest("hex");
if (lockSHA256 !== pin.dependencyLockSHA256) throw new Error("The source dependency lock does not match the pinned release.");
const target = path.resolve(process.argv[2] ?? path.join(root, ".tmp", `ditto-remote-${pin.version}`));
await mkdir(path.dirname(target), { recursive: true });
await mkdir(target, { recursive: false });
await cp(path.join(root, "plugins/ditto-remote"), target, { recursive: true });
const manifestFile = path.join(target, ".claude-plugin/plugin.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
await writeFile(manifestFile, JSON.stringify({ ...manifest, version: pin.version }, null, 2) + "\n");
await writeFile(path.join(target, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "ditto-remote-review", metadata: { description: "Local review candidate; not a public or approved marketplace" }, owner: { name: "Ditto" }, plugins: [{ name: manifest.name, source: "./", version: pin.version, description: manifest.description }] }, null, 2) + "\n");
const runtime = path.join(target, "runtime");
await mkdir(runtime);
// Extract the same verified bytes, not a second path open that could be swapped.
await pipeline(Readable.from(archiveBytes), x({ cwd: runtime, strip: 1, strict: true }));
const released = JSON.parse(await readFile(path.join(runtime, "package.json"), "utf8"));
if (released.name !== "@heyditto/cli" || released.version !== pin.version) throw new Error("The verified runtime archive has an unexpected package identity.");
await writeFile(path.join(runtime, "package-lock.json"), lock);
// Only this thin pairing entry point and URL helper are new. Channel-server,
// permissions, attachments, hooks, PTY and controller remain canonical bytes.
const overlays = [];
for (const name of ["plugin-server", "session-link"]) {
  for (const suffix of ["js", "js.map", "d.ts"]) {
    const relative = `dist/remote/${name}.${suffix}`;
    const bytes = await readFile(path.join(root, relative));
    await writeFile(path.join(runtime, relative), bytes);
    overlays.push({ file: relative, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
}
const npm = npmInstallInvocation();
const install = spawnSync(npm.command, npm.args, { cwd: runtime, stdio: "inherit" });
if (install.error || install.status !== 0) throw new Error(`Pinned runtime install failed (${install.error?.code ?? `exit ${install.status}`}). Check Node/npm and registry access.`);
await writeFile(path.join(target, "BUILD.json"), JSON.stringify({ plugin: manifest.name, version: pin.version, node: released.engines.node, lockSHA256, ...provenance, canonicalRuntime: pin, overlays, recipe: "npm ci && npm run plugin:build -- <fresh-output> <pinned-cli.tgz>", channelApproval: "not-submitted" }, null, 2) + "\n");
console.log(`Review plugin: ${target}`);
