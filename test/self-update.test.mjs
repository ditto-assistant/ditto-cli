import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Header } from "tar";
import { cleanUpdateEnvironment, effectiveUpdatePolicy, privateDirectory, quarantineCachedRelease, recordCachedActivation, selectActivatedRelease, selectCachedRelease as selectRuntimeCachedRelease, supportsNode, updateEligibility, updateLeaseSlot, updateTarget, UPDATE_INTERVAL_MS, writeUpdateJSON } from "../dist/self-update.js";
import { registryURL, runUpdate, unpackArchive, UPDATE_LIMITS } from "../dist/update-worker.js";
import { executeSelectedCLI } from "../dist/entry-runner.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const currentPackageVersion = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")).version;
const registry = "https://registry.npmjs.org";
const latest = `${registry}/%40heyditto%2Fcli/latest`;
const version = `${currentPackageVersion.split(".")[0]}.${Number(currentPackageVersion.split(".")[1]) + 1}.0`;
const fixtureTarget = "linux-x64-glibc", runtimeTarget = updateTarget();
const runtimeCache = config => path.join(config, "updates", runtimeTarget);
const selectCachedRelease = (cache, bundled, policy) => selectRuntimeCachedRelease(cache, bundled, policy, process.versions.node, fixtureTarget);
const sri = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64");

function tarball(entries) {
  const blocks = [];
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(typeof value === "string" ? value : value.data ?? "");
    const header = new Header({ path: name.startsWith("/") ? name : `package/${name}`, size: data.length, mode: typeof value === "string" ? 0o644 : value.mode ?? 0o644, type: typeof value === "string" ? "File" : value.type ?? "File", linkpath: typeof value === "string" ? undefined : value.linkpath });
    header.encode();
    blocks.push(header.block, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function temporary(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "heyditto-update-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixture({ mutateRoot, mutateLock, corruptDependency, foreignRoot = false, release = version } = {}) {
  const graph = [
    { path: "node_modules/fixture", name: "fixture", version: "1.0.0", dependencies: { nested: "^1.0.0" }, content: "import value from 'nested'; export default value;" },
    { path: "node_modules/fixture/node_modules/nested", name: "nested", version: "1.0.0", content: "export default 'locked nested dependency';" },
    { path: "node_modules/@lydell/node-pty", name: "@lydell/node-pty", version: "1.2.0-beta.15", optional: true, optionalDependencies: { "@lydell/node-pty-linux-x64": "1.2.0-beta.15", "@lydell/node-pty-darwin-arm64": "1.2.0-beta.15" }, content: "import value from '@lydell/node-pty-linux-x64'; export default value;" },
    { path: "node_modules/@lydell/node-pty-linux-x64", name: "@lydell/node-pty-linux-x64", version: "1.2.0-beta.15", optional: true, os: ["linux"], cpu: ["x64"], content: "export default 'platform prebuilt';" },
    { path: "node_modules/@lydell/node-pty-darwin-arm64", name: "@lydell/node-pty-darwin-arm64", version: "1.2.0-beta.15", optional: true, os: ["darwin"], cpu: ["arm64"], content: "export default 'wrong platform';" },
  ];
  const bodies = new Map(), requests = [];
  const packages = graph.map((item, index) => {
    const pkg = { name: item.name, version: item.version, type: "module", exports: "./index.js", dependencies: item.dependencies, optionalDependencies: item.optionalDependencies, scripts: { postinstall: "touch INSTALL-SCRIPT-RAN" } };
    const archive = tarball({ "package.json": JSON.stringify(pkg), "index.js": item.content, "helper": { data: "#!/bin/sh\nexit 0\n", mode: 0o755 } });
    const resolved = `${registry}/fixture/-/dependency-${index}.tgz`;
    bodies.set(resolved, corruptDependency && index === 1 ? tarball({ "package.json": JSON.stringify(pkg), "index.js": "export default 'tampered valid archive';" }) : archive);
    return { path: item.path, name: item.name, version: item.version, resolved, integrity: sri(archive), optional: item.optional, os: item.os, cpu: item.cpu };
  });
  const lock = { version: 1, bootstrap: 1, name: "@heyditto/cli", packageVersion: release, packages };
  mutateLock?.(lock);
  const pkg = { name: "@heyditto/cli", version: release, type: "module", bin: { heyditto: "dist/entry.js", ditto: "dist/entry.js" }, engines: { node: ">=22" }, dependencies: { fixture: "^1.0.0" }, optionalDependencies: { "@lydell/node-pty": "1.2.0-beta.15" }, scripts: { postinstall: "touch INSTALL-SCRIPT-RAN" } };
  const files = {
    "package.json": JSON.stringify(pkg), "dist/update-lock.json": JSON.stringify(lock),
    "dist/entry.js": "import './cli.js';", "dist/update-worker.js": "// fixture finite worker",
    "dist/cli.js": `import dep from 'fixture'; import pty from '@lydell/node-pty'; process.stdout.write(JSON.stringify({version:'${release}',dep,pty})+'\\n');`,
  };
  mutateRoot?.(files);
  const rootArchive = tarball(files), tarURL = foreignRoot ? "https://example.invalid/package.tgz" : `${registry}/@heyditto/cli/-/cli-${release}.tgz`;
  bodies.set(tarURL, rootArchive);
  bodies.set(latest, Buffer.from(JSON.stringify({ ...pkg, repository: { url: "git+https://github.com/ditto-assistant/ditto-cli.git" }, dist: { tarball: tarURL, integrity: sri(rootArchive) } })));
  const fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(init.redirect, "error"); assert.equal(init.headers.authorization, undefined);
    const body = bodies.get(String(url));
    assert.ok(body, `unexpected fixture registry request: ${url}`);
    return new Response(body, { headers: { "content-length": String(body.length) } });
  };
  return { fetch, requests, bodies, lock };
}

const update = (cache, service, extra = {}) => runUpdate({ cache, currentVersion: "2.33.0", platform: "linux", arch: "x64", libc: "glibc", fetch: service.fetch, ...extra });
const pointer = cache => readFile(path.join(cache, "current.json"), "utf8").then(JSON.parse);
const health = cache => readFile(path.join(cache, "health.json"), "utf8").then(JSON.parse);

test("locked update verifies every dependency, selects the platform prebuilt, and changes only the next invocation", async t => {
  const cache = path.join(await temporary(t), "updates"), service = fixture();
  await update(cache, service);
  assert.equal((await health(cache)).status, "staged for next enabled invocation");
  assert.equal((await pointer(cache)).version, version);
  assert.equal(service.requests.length, 6, "metadata, root, and four compatible dependencies are fetched once");
  assert.ok(!service.requests.some(url => url.endsWith("dependency-4.tgz")));
  const selected = await selectCachedRelease(cache, "2.33.0", {});
  assert.equal(selected.version, version);
  const result = spawnSync(process.execPath, [path.join(selected.root, "dist/entry.js")], { encoding: "utf8", cwd: cache, env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version, dep: "locked nested dependency", pty: "platform prebuilt" });
  assert.equal((await lstat(path.join(selected.root, "node_modules/fixture/helper"))).mode & 0o100, 0o100);
  await assert.rejects(readFile(path.join(cache, "INSTALL-SCRIPT-RAN")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(selected.root, "INSTALL-SCRIPT-RAN")), { code: "ENOENT" });
  assert.ok(!(await readdir(cache)).some(name => name.startsWith("stage-") || name === "worker.lock"));
});

test("a corrupt transitive archive never activates a partial candidate or changes the previous pointer", async t => {
  const cache = path.join(await temporary(t), "updates");
  await writeUpdateJSON(path.join(cache, "current.json"), { version: "2.32.0", installedAt: "prior" });
  const before = await readFile(path.join(cache, "current.json"));
  await update(cache, fixture({ corruptDependency: true }));
  assert.equal((await health(cache)).status, "failed"); assert.match((await health(cache)).detail, /integrity mismatch/);
  assert.deepEqual(await readFile(path.join(cache, "current.json")), before);
  assert.ok(!(await readdir(cache)).some(name => name.startsWith("stage-")));
});

test("fixed public host, redirects, manifest identity and dependency completeness fail closed", async t => {
  for (const value of ["http://registry.npmjs.org/file", "https://user:secret@registry.npmjs.org/file", "https://registry.npmjs.org.evil.test/file", "https://registry.npmjs.org:444/file", "https://registry.npmjs.org/file?token=secret"]) assert.throws(() => registryURL(value));
  for (const options of [
    { foreignRoot: true },
    { mutateLock: lock => lock.packages[0].resolved = "https://example.invalid/file" },
    { mutateLock: lock => lock.packageVersion = "2.99.0" },
    { mutateLock: lock => lock.packages = lock.packages.filter(pkg => !pkg.path.includes("/nested")) },
    { mutateRoot: files => { const pkg = JSON.parse(files["package.json"]); pkg.version = "2.99.0"; files["package.json"] = JSON.stringify(pkg); } },
  ]) {
    const cache = path.join(await temporary(t), "updates"), service = fixture(options);
    await update(cache, service);
    assert.equal((await health(cache)).status, "failed");
    await assert.rejects(pointer(cache), { code: "ENOENT" });
    assert.ok(service.requests.every(url => new URL(url).origin === registry));
  }
});

test("archive validation rejects traversal, links, duplicate names, special files and decompression bombs", async () => {
  const pkg = JSON.stringify({ name: "fixture", version: "1.0.0" });
  for (const record of [
    { "../escape": "bad" }, { "/absolute": "bad" }, { "C:\\escape": "bad" },
    { link: { type: "SymbolicLink", linkpath: "../../escape" } }, { link: { type: "Link", linkpath: "../../escape" } },
    { fifo: { type: "FIFO" } }, { FOO: "a", foo: "b" }, { file: "a", "file/child": "b" },
  ]) await assert.rejects(unpackArchive(tarball({ "package.json": pkg, ...record })));
  await assert.rejects(unpackArchive(tarball({ "package.json": pkg, huge: "x".repeat(200000) }), { ...UPDATE_LIMITS, archiveUnpackedBytes: 1024 }));
});

test("required graph failures, download/disk bounds and unsupported Node keep the current CLI", async t => {
  for (const extra of [ { nodeVersion: "20.0.0" }, { limits: { archiveBytes: 40 } }, { limits: { downloadBytes: 500 } }, { limits: { cacheBytes: 1000 } }, { limits: { files: 2 } }, { limits: { packages: 1 } } ]) {
    const cache = path.join(await temporary(t), "updates"); await update(cache, fixture(), extra);
    assert.equal((await health(cache)).status, "failed");
    await assert.rejects(pointer(cache), { code: "ENOENT" });
  }
});

test("concurrent workers use one exclusive lease and one network attempt", async t => {
  const cache = path.join(await temporary(t), "updates"), service = fixture();
  await Promise.all([update(cache, service), update(cache, service)]);
  assert.equal(service.requests.filter(url => url === latest).length, 1);
  assert.equal((await pointer(cache)).version, version);
});

test("disabled or pinned policies do not contact the registry; a mid-download disable prevents activation", async t => {
  for (const settings of [{ enabled: false }, { pinnedVersion: "2.33.0" }]) {
    const cache = path.join(await temporary(t), "updates"), service = fixture();
    await writeUpdateJSON(path.join(cache, "settings.json"), settings); await update(cache, service);
    assert.equal(service.requests.length, 0);
  }
  const cache = path.join(await temporary(t), "updates"), service = fixture(), originalFetch = service.fetch;
  service.fetch = async (...args) => { const result = await originalFetch(...args); if (service.requests.length === 3) await writeUpdateJSON(path.join(cache, "settings.json"), { enabled: false }); return result; };
  await update(cache, service);
  assert.equal((await health(cache)).status, "disabled during download"); await assert.rejects(pointer(cache), { code: "ENOENT" });
});

test("manager ownership and explicit launch contexts cannot be overridden by cache or environment credentials", () => {
  const root = "/home/person/.nvm/versions/node/v24/lib/node_modules/@heyditto/cli";
  assert.equal(updateEligibility(root, {}, []), undefined);
  for (const env of [{ CI: "true" }, { npm_command: "exec" }, { npm_lifecycle_event: "test" }, { DITTO_CLI_PINNED: "1" }, { DITTO_CLI_AUTO_UPDATE: "0" }]) assert.ok(updateEligibility(root, env, []));
  for (const manager of ["/opt/homebrew/Cellar/heyditto/2/lib/node_modules/@heyditto/cli", "/nix/store/abc/lib/node_modules/@heyditto/cli", "/usr/share/heyditto", "/project/node_modules/@heyditto/cli", "/home/person/.npm/_npx/hash/lib/node_modules/@heyditto/cli"]) assert.ok(updateEligibility(manager, {}, []));
  assert.deepEqual(cleanUpdateEnvironment({ PATH: "/project/bin", HOME: "/home/person", NODE_OPTIONS: "--require=evil", DITTO_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", npm_config_userconfig: "/private/npmrc", LANG: "C" }), { LANG: "C" });
  assert.equal(supportsNode("^24.22.1 || ^26.12.1", "24.22.1"), true);
  assert.equal(supportsNode("^24.22.1", "24.22.0"), false);
});

test("invalid cache pointers fall back; symlink paths are rejected without touching foreign directories", async t => {
  const directory = await temporary(t), cache = path.join(directory, "updates");
  await writeUpdateJSON(path.join(cache, "current.json"), { version: "../../elsewhere" });
  assert.equal(await selectCachedRelease(cache, "2.33.0", {}), undefined);
  const outside = path.join(directory, "outside"); await mkdir(outside);
  const linked = path.join(directory, "linked"); await symlink(outside, linked);
  await assert.rejects(privateDirectory(path.join(linked, "new-cache")), /symlink/);
  assert.deepEqual(await readdir(outside), []);
});

test("persistent updater commands preserve stdout JSON and never invoke a project installer", async t => {
  const directory = await temporary(t), config = path.join(directory, "config"), cli = path.join(project, "dist/entry.js");
  const execute = verb => spawnSync(process.execPath, [cli, "self-update", verb, "--output", "json"], { cwd: directory, encoding: "utf8", env: { PATH: "", DITTO_CONFIG_DIR: config, DITTO_API_KEY: "must-not-be-read" } });
  for (const [verb, field, value] of [["disable", "enabled", false], ["enable", "enabled", true], ["pin", "pinnedVersion", currentPackageVersion], ["unpin", "pinnedVersion", null]]) {
    const result = execute(verb); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ""); assert.equal(JSON.parse(result.stdout)[field], value);
  }
  await assert.rejects(readFile(path.join(config, "config.json")), { code: "ENOENT" });
});

test("normal global launch returns before its worker finishes, throttles later invocations and strips command context", async t => {
  const directory = await temporary(t), globalRoot = path.join(directory, "prefix/lib/node_modules/@heyditto/cli"), config = path.join(directory, "config"), cache = runtimeCache(config);
  await mkdir(path.join(globalRoot, "dist"), { recursive: true }); await mkdir(cache, { recursive: true, mode: 0o700 });
  const harness = path.join(directory, "harness.mjs");
  await writeFile(harness, `import {writeFile} from 'node:fs/promises'; import {startupUpdate} from ${JSON.stringify(new URL("../dist/self-update.js", import.meta.url).href)}; await writeFile(${JSON.stringify(path.join(cache, "parent.pid"))}, String(process.pid)); const invoked=process.argv[2]; process.argv=[process.argv[0],invoked+'/dist/entry.js',...process.argv.slice(3)]; const root=await startupUpdate(invoked); process.stdout.write(JSON.stringify({root})+'\\n');`);
  await writeFile(path.join(globalRoot, "dist/update-worker.js"), `
const fs=require('node:fs/promises'), path=require('node:path');
(async()=>{
 const cache=process.argv[2], parent=Number(await fs.readFile(path.join(cache,'parent.pid'),'utf8'));
 await fs.writeFile(path.join(cache,'health.json'),JSON.stringify({lastAttemptAt:Date.now(),status:'mock check'}));
 let parentExited=false, until=Date.now()+8000;
 while(Date.now()<until){try{process.kill(parent,0);}catch{parentExited=true;break;} await new Promise(r=>setTimeout(r,20));}
 await fs.writeFile(path.join(cache,'worker-result.json'),JSON.stringify({parentExited,cwd:process.cwd(),argv:process.argv.slice(2),env:process.env}));
})().catch(()=>{process.exitCode=1;});`);
  const execute = args => spawnSync(process.execPath, [harness, globalRoot, ...args], { cwd: directory, encoding: "utf8", env: { DITTO_CONFIG_DIR: config, DITTO_API_KEY: "credential", AWS_SECRET_ACCESS_KEY: "credential", npm_config_userconfig: "/private/npmrc", PROJECT_CONTEXT: "private task" } });
  const first = execute(["review", "local", "--context-file", "/project/private.md"]);
  assert.equal(first.status, 0, first.stderr); assert.equal(first.stderr, ""); assert.equal(JSON.parse(first.stdout).root, globalRoot);
  let result;
  for (let n = 0; n < 200; n++) { try { result = JSON.parse(await readFile(path.join(cache, "worker-result.json"), "utf8")); break; } catch { await delay(50); } }
  assert.ok(result, "the finite worker must finish"); assert.equal(result.parentExited, true, "the command must not wait for background download work");
  assert.equal(result.cwd, cache); assert.deepEqual(result.argv, [cache, currentPackageVersion]);
  for (const key of ["DITTO_API_KEY", "AWS_SECRET_ACCESS_KEY", "npm_config_userconfig", "PROJECT_CONTEXT", "DITTO_CONFIG_DIR"]) assert.equal(result.env[key], undefined);
  const before = await readFile(path.join(cache, "worker-result.json"));
  const second = execute(["review", "local"]); assert.equal(second.status, 0, second.stderr);
  await delay(100); assert.deepEqual(await readFile(path.join(cache, "worker-result.json")), before, "a recent check cannot launch another worker");
  await rm(path.join(cache, "health.json")); await rm(path.join(cache, "worker-result.json"));
  const offline = execute(["review", "local", "--preview"]); assert.equal(offline.status, 0, offline.stderr);
  await delay(100); await assert.rejects(readFile(path.join(cache, "worker-result.json")), { code: "ENOENT" });
  for (const args of [["help", "search"], []]) {
    const help = execute(args); assert.equal(help.status, 0, help.stderr);
    await delay(100); await assert.rejects(readFile(path.join(cache, "worker-result.json")), { code: "ENOENT" });
  }
});

test("worker network timeout retains an immutable lease and leaves the selected pointer unchanged", async t => {
  const cache = path.join(await temporary(t), "updates");
  await writeUpdateJSON(path.join(cache, "current.json"), { version: "2.32.0" });
  const before = await readFile(path.join(cache, "current.json"));
  const fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("fixture timeout")), { once: true }));
  await update(cache, { fetch }, { limits: { timeoutMs: 20 } });
  assert.equal((await health(cache)).status, "failed"); assert.deepEqual(await readFile(path.join(cache, "current.json")), before);
  assert.ok((await lstat(path.join(cache, "leases", (await health(cache)).lease))).isFile());
});

test("a cached CLI error after a side effect is never retried through the bundled CLI", async t => {
  const directory = await temporary(t), cache = path.join(directory, "updates"), service = fixture();
  await update(cache, service);
  const selected = await selectCachedRelease(cache, "2.33.0", {}), bundled = path.join(directory, "bundled");
  await mkdir(path.join(bundled, "dist"), { recursive: true });
  const effect = path.join(directory, "effect"), retry = path.join(directory, "retried");
  await writeFile(path.join(bundled, "package.json"), '{"type":"module"}');
  await writeFile(path.join(bundled, "dist/cli.js"), `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(retry)}, 'retried');`);
  await writeFile(path.join(selected.root, "dist/cli.js"), `import {appendFile} from 'node:fs/promises'; await appendFile(${JSON.stringify(effect)}, 'one side effect\\n'); throw new Error('after the side effect');`);
  await assert.rejects(executeSelectedCLI(selected.root, bundled, root => quarantineCachedRelease(root, cache)), /after the side effect/);
  assert.equal(await readFile(effect, "utf8"), "one side effect\n");
  await assert.rejects(readFile(retry), { code: "ENOENT" });
  assert.equal(await selectCachedRelease(cache, "2.33.0", {}), undefined, "only future invocations skip the quarantined version");
});

test("a persistent pin selects its retained version even after the latest pointer moves or becomes invalid", async t => {
  const cache = path.join(await temporary(t), "updates"); await update(cache, fixture());
  await writeUpdateJSON(path.join(cache, "current.json"), { version: "2.35.0" });
  assert.equal((await selectCachedRelease(cache, "2.33.0", { pinnedVersion: version })).version, version);
  await writeFile(path.join(cache, "current.json"), "not JSON");
  assert.equal((await selectCachedRelease(cache, "2.33.0", { pinnedVersion: version })).version, version);
});

test("crashed workers recover in a later bounded window without stealing or deleting an earlier lease", async t => {
  const cache = path.join(await temporary(t), "updates"), now = Date.now();
  const dead = spawnSync(process.execPath, ["-e", ""], { env: {} }).pid;
  const old = path.join(cache, "leases", updateLeaseSlot(now));
  await writeUpdateJSON(old, { pid: dead, nonce: "previous-owner", createdAt: now, deadlineAt: now + 60000 });
  const original = await readFile(old), service = fixture();
  await update(cache, service, { now: () => now });
  assert.equal(service.requests.length, 0, "the old time slot is never stolen even from a dead process");
  await update(cache, service, { now: () => now + UPDATE_INTERVAL_MS });
  assert.equal((await pointer(cache)).version, version);
  assert.deepEqual(await readFile(old), original);
});

test("an adjacent live worker blocks a second network attempt, and replaced leases cannot publish", async t => {
  const cache = path.join(await temporary(t), "updates"), boundary = (Math.floor(Date.now() / UPDATE_INTERVAL_MS) + 1) * UPDATE_INTERVAL_MS, now = boundary + 1;
  const old = path.join(cache, "leases", updateLeaseSlot(now - 2));
  await writeUpdateJSON(old, { pid: process.pid, nonce: "live-owner", createdAt: now - 2, deadlineAt: now + 60000 });
  const before = await readFile(old), service = fixture();
  await update(cache, service, { now: () => now });
  assert.equal(service.requests.length, 0); assert.equal((await health(cache)).status, "adjacent worker active"); assert.deepEqual(await readFile(old), before);
  const otherCache = path.join(await temporary(t), "updates"), other = fixture(), fetch = other.fetch;
  let replacement;
  other.fetch = async (...args) => {
    const response = await fetch(...args);
    if (other.requests.length === 3) {
      const lease = path.join(otherCache, "leases", (await health(otherCache)).lease);
      await rm(lease); await writeUpdateJSON(lease, { pid: process.pid, nonce: "different-owner", createdAt: Date.now(), deadlineAt: Date.now() + 60000 });
      replacement = await readFile(lease);
    }
    return response;
  };
  await update(otherCache, other);
  assert.match((await health(otherCache)).detail, /lost its lease/); await assert.rejects(pointer(otherCache), { code: "ENOENT" });
  assert.deepEqual(await readFile(path.join(otherCache, "leases", (await health(otherCache)).lease)), replacement);
});

test("an explicit manual check can update while auto-updates are disabled but cannot bypass a version pin", async t => {
  const cache = path.join(await temporary(t), "updates"), service = fixture();
  await writeUpdateJSON(path.join(cache, "settings.json"), { enabled: false });
  await update(cache, service, { manual: true });
  assert.equal((await pointer(cache)).version, version);
  assert.equal((await selectActivatedRelease(cache, "2.33.0", process.versions.node, fixtureTarget)).version, version, "explicit manual checks activate without enabling automatic updates");
  assert.deepEqual(JSON.parse(await readFile(path.join(cache, "settings.json"), "utf8")), { enabled: false });
  const pinnedCache = path.join(await temporary(t), "updates"), pinned = fixture();
  await writeUpdateJSON(path.join(pinnedCache, "settings.json"), { pinnedVersion: "2.33.0" });
  await update(pinnedCache, pinned, { manual: true });
  assert.equal(pinned.requests.length, 0); assert.equal((await health(pinnedCache)).status, "pinned");
});

test("a global bin symlink resolves its actual package ownership for an explicitly pinned manual check", async t => {
  const directory = await temporary(t), globalRoot = path.join(directory, "prefix/lib/node_modules/@heyditto/cli"), config = path.join(directory, "config"), bin = path.join(directory, "prefix/bin/heyditto");
  await mkdir(globalRoot, { recursive: true }); await mkdir(path.dirname(bin), { recursive: true });
  await cp(path.join(project, "dist"), path.join(globalRoot, "dist"), { recursive: true });
  await cp(path.join(project, "package.json"), path.join(globalRoot, "package.json"));
  await symlink(path.join(project, "node_modules"), path.join(globalRoot, "node_modules"), "dir");
  await symlink(path.join(globalRoot, "dist/entry.js"), bin);
  await writeUpdateJSON(path.join(config, "updates/settings.json"), { enabled: false, pins: { [runtimeTarget]: currentPackageVersion } });
  for (const configOverride of [config, "config"]) {
    const result = spawnSync(process.execPath, [bin, "self-update", "check", "--output", "json"], { cwd: directory, encoding: "utf8", env: { DITTO_CONFIG_DIR: configOverride, DITTO_API_KEY: "never-uploaded", PATH: "" } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const data = JSON.parse(result.stdout);
    assert.equal(data.cache, runtimeCache(config), "relative config overrides must resolve before child cwd changes");
    assert.equal(data.checkAllowed, true); assert.equal(data.eligible, true); assert.equal(data.health.status, "pinned");
    assert.equal(data.bundledVersion, currentPackageVersion); assert.equal(data.selectedVersion, currentPackageVersion); assert.equal(data.enabled, false);
    const lease = JSON.parse(await readFile(path.join(runtimeCache(config), "leases", data.health.lease), "utf8"));
    assert.notEqual(lease.pid, result.pid, "manual checks must use a separate bounded, credential-free worker too");
  }
  await assert.rejects(readFile(path.join(config, "config.json")), { code: "ENOENT" });
});

test("a required libc mismatch is rejected before staging an incompatible native dependency", async t => {
  const cache = path.join(await temporary(t), "updates"), service = fixture({ mutateLock: lock => { lock.packages[0].libc = ["glibc"]; } });
  await update(cache, service, { libc: "musl" });
  assert.match((await health(cache)).detail, /does not support this platform/);
  await assert.rejects(pointer(cache), { code: "ENOENT" });
});

test("sandbox staging preserves the installed platform's real prebuilt PTY and executable helper", async t => {
  const genericRoot = path.join(project, "node_modules/@lydell/node-pty"), binaryName = `@lydell/node-pty-${process.platform}-${process.arch}`, binaryRoot = path.join(project, "node_modules", binaryName);
  let generic, binary;
  try { generic = JSON.parse(await readFile(path.join(genericRoot, "package.json"), "utf8")); binary = JSON.parse(await readFile(path.join(binaryRoot, "package.json"), "utf8")); }
  catch { t.skip("no prebuilt PTY is installed for this platform"); return; }
  const archiveInstalled = async root => {
    const files = {};
    const visit = async (relative = "") => {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name, absolute = path.join(root, name), stat = await lstat(absolute);
        if (entry.isDirectory()) await visit(name);
        else { assert.ok(stat.isFile() && !stat.isSymbolicLink()); files[name] = { data: await readFile(absolute), mode: stat.mode & 0o777 }; }
      }
    };
    await visit(); return tarball(files);
  };
  const bodies = new Map(), packages = [];
  const add = (name, pkg, archive, optional, os, cpu) => {
    const url = `${registry}/fixture/-/${encodeURIComponent(name)}.tgz`;
    bodies.set(url, archive); packages.push({ path: `node_modules/${name}`, name, version: pkg.version, resolved: url, integrity: sri(archive), optional, os, cpu });
  };
  add(generic.name, generic, await archiveInstalled(genericRoot), true);
  for (const [name, dependencyVersion] of Object.entries(generic.optionalDependencies)) {
    const [platform, arch] = name.split("-").slice(-2), current = name === binaryName;
    const pkg = current ? binary : { name, version: dependencyVersion };
    add(name, pkg, current ? await archiveInstalled(binaryRoot) : tarball({ "package.json": JSON.stringify(pkg) }), true, [platform], [arch]);
  }
  const pkg = { name: "@heyditto/cli", version, type: "module", engines: { node: ">=22" }, bin: { heyditto: "dist/entry.js" }, optionalDependencies: { [generic.name]: generic.version } };
  const cli = `import pty from '@lydell/node-pty'; const p=pty.spawn(process.execPath,['-e',"process.stdout.write('verified pty')"],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:{}}); let text=''; p.onData(data=>text+=data); p.onExit(()=>{setTimeout(()=>{if(!text.includes('verified pty'))process.exitCode=1;process.stdout.write(JSON.stringify({pty:text.includes('verified pty')})+'\\n');},20);});`;
  const archive = tarball({ "package.json": JSON.stringify(pkg), "dist/entry.js": "import './cli.js';", "dist/cli.js": cli, "dist/update-worker.js": "// fixture", "dist/update-lock.json": JSON.stringify({ version: 1, bootstrap: 1, name: pkg.name, packageVersion: version, packages }) });
  const url = `${registry}/fixture/-/real-pty-root.tgz`; bodies.set(url, archive);
  bodies.set(latest, Buffer.from(JSON.stringify({ ...pkg, repository: { url: "git+https://github.com/ditto-assistant/ditto-cli.git" }, dist: { tarball: url, integrity: sri(archive) } })));
  const cache = path.join(await temporary(t), "updates");
  await runUpdate({ cache, currentVersion: "2.33.0", fetch: async value => new Response(bodies.get(String(value)) ?? null, { status: bodies.has(String(value)) ? 200 : 404 }) });
  assert.equal((await health(cache)).status, "staged for next enabled invocation", (await health(cache)).detail);
  const selected = await selectRuntimeCachedRelease(cache, "2.33.0", {});
  const result = spawnSync(process.execPath, [path.join(selected.root, "dist/entry.js")], { cwd: cache, encoding: "utf8", env: {}, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).pty, true);
});

test("a fully verified version survives a crash before pointer publication and is recovered without reinstalling", async t => {
  const cache = path.join(await temporary(t), "updates"), service = fixture(), now = Date.now();
  await update(cache, service, { now: () => now });
  const selected = await selectCachedRelease(cache, "2.33.0", {}), before = await readFile(path.join(selected.root, "node_modules/fixture/index.js"));
  await rm(path.join(cache, "current.json"));
  const priorRequests = service.requests.length;
  await update(cache, service, { now: () => now + UPDATE_INTERVAL_MS });
  assert.equal((await health(cache)).status, "staged verified cached version");
  assert.equal(service.requests.length - priorRequests, 1, "the registry identity is checked but verified dependencies are not downloaded again");
  assert.equal((await pointer(cache)).version, version); assert.deepEqual(await readFile(path.join(selected.root, "node_modules/fixture/index.js")), before);
});

test("disable controls never weaken installed pins, CI, ephemeral execution or manager ownership", () => {
  const global = "/home/person/prefix/lib/node_modules/@heyditto/cli";
  const denials = [
    { root: global, env: { DITTO_CLI_PINNED: "1" } }, { root: global, env: { CI: "true" } },
    { root: global, env: { npm_command: "exec" } }, { root: global, env: { npm_lifecycle_event: "test" } },
    { root: "/project/node_modules/@heyditto/cli", env: {} },
    { root: "/opt/homebrew/Cellar/heyditto/2/lib/node_modules/@heyditto/cli", env: {} },
    { root: "/nix/store/heyditto/lib/node_modules/@heyditto/cli", env: {} },
    { root: "/home/person/.npm/_npx/hash/node_modules/@heyditto/cli", env: {} },
  ];
  let inspected = 0;
  for (const disable of [{ env: { DITTO_CLI_AUTO_UPDATE: "0" }, args: [] }, { env: { DISABLE_AUTOUPDATER: "1" }, args: [] }, { env: {}, args: ["--no-auto-update"] }]) {
    assert.equal(updateEligibility(global, disable.env, disable.args), "disabled for this invocation");
    for (const denied of denials) {
      const reason = updateEligibility(denied.root, { ...denied.env, ...disable.env }, disable.args);
      assert.ok(reason && reason !== "disabled for this invocation", `${denied.root}: ${JSON.stringify(denied.env)} must stay protected`);
      inspected++;
    }
  }
  assert.equal(inspected, 24);
});

test("disable plus installed pin cannot delegate a cached CLI, and project manual checks cannot gain permission", async t => {
  const directory = await temporary(t), config = path.join(directory, "config"), cache = runtimeCache(config), globalRoot = path.join(directory, "prefix/lib/node_modules/@heyditto/cli");
  await mkdir(globalRoot, { recursive: true }); await update(cache, fixture(), { platform: process.platform, arch: process.arch, libc: runtimeTarget.split("-")[2] });
  const harness = path.join(directory, "selection.mjs");
  await writeFile(harness, `import {startupUpdate} from ${JSON.stringify(new URL("../dist/self-update.js", import.meta.url).href)}; process.stdout.write(JSON.stringify({root:await startupUpdate(process.argv[2])})+'\\n');`);
  const selected = spawnSync(process.execPath, [harness, globalRoot], { cwd: directory, encoding: "utf8", env: { DITTO_CONFIG_DIR: config, DITTO_CLI_AUTO_UPDATE: "0", DITTO_CLI_PINNED: "1" } });
  assert.equal(selected.status, 0, selected.stderr); assert.equal(JSON.parse(selected.stdout).root, globalRoot);
  const checked = spawnSync(process.execPath, [path.join(project, "dist/entry.js"), "self-update", "check", "--output", "json"], { cwd: directory, encoding: "utf8", env: { DITTO_CONFIG_DIR: config, DITTO_CLI_AUTO_UPDATE: "0" } });
  assert.equal(checked.status, 1, checked.stderr); assert.equal(JSON.parse(checked.stdout).checkAllowed, false);
});

test("persistent disable is shared across targets while pins remain target-specific", async t => {
  const base = path.join(await temporary(t), "config/updates"), x64 = path.join(base, "linux-x64-glibc"), arm64 = path.join(base, "linux-arm64-glibc");
  await writeUpdateJSON(path.join(base, "settings.json"), { enabled: false, pins: { "linux-x64-glibc": version } });
  assert.equal((await effectiveUpdatePolicy(x64, "linux-x64-glibc")).pinnedVersion, version);
  assert.equal((await effectiveUpdatePolicy(arm64, "linux-arm64-glibc")).pinnedVersion, undefined);
  for (const [cache, arch] of [[x64, "x64"], [arm64, "arm64"]]) {
    const service = fixture();
    await runUpdate({ cache, currentVersion: "2.33.0", platform: "linux", arch, libc: "glibc", fetch: service.fetch });
    assert.equal(service.requests.length, 0); assert.equal((await effectiveUpdatePolicy(cache, `linux-${arch}-glibc`)).enabled, false);
  }
});

test("foreign target receipts cannot be selected, recovered or overwritten by another architecture", async t => {
  const cache = path.join(await temporary(t), "updates"), now = Date.now();
  await update(cache, fixture(), { now: () => now });
  const oldPointer = await readFile(path.join(cache, "current.json")), oldReceipt = await readFile(path.join(cache, "versions", version, "verified.json"));
  assert.equal(await selectRuntimeCachedRelease(cache, "2.33.0", {}, process.versions.node, "linux-arm64-glibc"), undefined);
  await update(cache, fixture(), { now: () => now + UPDATE_INTERVAL_MS, arch: "arm64" });
  assert.match((await health(cache)).detail, /already exists/);
  assert.deepEqual(await readFile(path.join(cache, "current.json")), oldPointer);
  assert.deepEqual(await readFile(path.join(cache, "versions", version, "verified.json")), oldReceipt);
  const receipt = JSON.parse(oldReceipt); receipt.nodeRanges = ["<1.0.0"];
  await writeFile(path.join(cache, "versions", version, "verified.json"), JSON.stringify(receipt));
  assert.equal(await selectCachedRelease(cache, "2.33.0", {}), undefined, "stored transitive Node requirements must remain compatible");
});

test("relative cache selection resolves once against the caller directory", async t => {
  const cache = path.join(await temporary(t), "updates"); await update(cache, fixture());
  const selected = await selectCachedRelease(path.relative(process.cwd(), cache), "2.33.0", {});
  assert.equal(selected.root, path.join(cache, "versions", version, "package")); assert.ok(path.isAbsolute(selected.root));
});

test("concurrent controls retain an acknowledged disable and both targets' pins", async t => {
  const directory = await temporary(t), cli = path.join(project, "dist/entry.js"), preloader = path.join(directory, "pause-policy.mjs");
  await writeFile(preloader, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
if(process.env.TEST_ARCH)Object.defineProperty(process,'arch',{value:process.env.TEST_ARCH});
const read=fs.readFile;let paused=false;
fs.readFile=async function(file,...args){const result=await read.call(this,file,...args);if(!paused&&process.env.TEST_PAUSE&&String(file)===process.env.TEST_POLICY){paused=true;await fs.writeFile(process.env.TEST_READY,'ready');const end=Date.now()+8000;for(;;){try{await fs.access(process.env.TEST_RELEASE);break;}catch{}if(Date.now()>end)throw new Error('policy barrier timed out');await new Promise(r=>setTimeout(r,10));}}return result;};syncBuiltinESMExports();`);
  for (const scenario of ["disable", "other-pin"]) {
    const config = path.join(directory, scenario), policy = path.join(config, "updates/settings.json"), ready = path.join(directory, scenario + "-ready"), release = path.join(directory, scenario + "-release");
    await writeUpdateJSON(policy, { enabled: true, pins: {} });
    const env = { DITTO_CONFIG_DIR: config, TEST_POLICY: policy, TEST_READY: ready, TEST_RELEASE: release, TEST_ARCH: process.arch, TEST_PAUSE: "1" };
    const child = spawn(process.execPath, ["--import", preloader, cli, "self-update", "pin", "--output", "json"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    const completed = new Promise((resolve, reject) => {
      let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    });
    let first;
    try {
      for (let n = 0; ; n++) { try { await readFile(ready); break; } catch { if (n === 400) throw new Error("control did not reach its policy read"); await delay(10); } }
      const arch = process.arch === "arm64" ? "x64" : "arm64";
      const second = spawnSync(process.execPath, ["--import", preloader, cli, "self-update", scenario === "disable" ? "disable" : "pin", "--output", "json"], { cwd: directory, env: { ...env, TEST_ARCH: arch, TEST_PAUSE: "" }, encoding: "utf8", timeout: 8000 });
      assert.equal(second.status, 0, second.stderr);
      if (scenario === "disable") assert.equal(JSON.parse(second.stdout).enabled, false, "disable must be acknowledged before the stale reader resumes");
    } finally { await writeFile(release, "release"); first = await completed; }
    assert.equal(first.code, 0, first.stderr);
    const firstTarget = updateTarget(), otherTarget = updateTarget(process.platform, process.arch === "arm64" ? "x64" : "arm64");
    const firstPolicy = await effectiveUpdatePolicy(path.join(config, "updates", firstTarget), firstTarget);
    const otherPolicy = await effectiveUpdatePolicy(path.join(config, "updates", otherTarget), otherTarget);
    if (scenario === "disable") { assert.equal(firstPolicy.enabled, false); assert.equal(otherPolicy.enabled, false); }
    else { assert.equal(firstPolicy.pinnedVersion, currentPackageVersion); assert.equal(otherPolicy.pinnedVersion, currentPackageVersion); }
  }
});

test("a pointer rename gated after its final policy check cannot activate a candidate after disable acknowledges", async t => {
  const directory = await temporary(t), config = path.join(directory, "config"), cache = runtimeCache(config);
  const globalRoot = path.join(directory, "prefix/lib/node_modules/@heyditto/cli"), harness = path.join(directory, "launch.mjs");
  await mkdir(globalRoot, { recursive: true });
  await writeFile(harness, `import {startupUpdate} from ${JSON.stringify(new URL("../dist/self-update.js", import.meta.url).href)}; const invoked=process.argv[2]; process.argv=[process.execPath,invoked+'/dist/entry.js','--version']; console.log(JSON.stringify({root:await startupUpdate(invoked)}));`);
  const launch = (extra = {}) => {
    const result = spawnSync(process.execPath, [harness, globalRoot], { cwd: directory, env: { DITTO_CONFIG_DIR: config, ...extra }, encoding: "utf8", timeout: 8000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout).root;
  };
  const native = { platform: process.platform, arch: process.arch, libc: runtimeTarget.split("-")[2] };
  await update(cache, fixture(), native);
  const priorRoot = path.join(cache, "versions", version, "package"); assert.equal(launch(), priorRoot);
  const later = `${version.split(".")[0]}.${Number(version.split(".")[1]) + 1}.0`;
  let reached, release;
  const atRename = new Promise(resolve => reached = resolve), proceed = new Promise(resolve => release = resolve);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === path.join(cache, "current.json")) { reached(); await proceed; } return rename(from, to); };
  syncBuiltinESMExports();
  const worker = update(cache, fixture({ release: later }), { ...native, now: () => Date.now() + 3 * UPDATE_INTERVAL_MS });
  try {
    await Promise.race([atRename, delay(8000, undefined, { ref: false }).then(() => { throw new Error("worker never reached candidate rename"); })]);
    const disabled = spawnSync(process.execPath, [path.join(project, "dist/entry.js"), "self-update", "disable", "--output", "json"], { cwd: directory, env: { DITTO_CONFIG_DIR: config }, encoding: "utf8", timeout: 8000 });
    assert.equal(disabled.status, 0, disabled.stderr); assert.equal(JSON.parse(disabled.stdout).enabled, false);
    assert.equal((await pointer(cache)).version, version, "disable acknowledges before the held candidate publication");
  } finally { release(); await worker; fs.rename = rename; syncBuiltinESMExports(); }
  assert.equal((await pointer(cache)).version, later, "the test must actually exercise late pointer publication");
  assert.equal(launch(), priorRoot, "disabled startup must retain the actually selected version, not the late candidate");
  await writeUpdateJSON(path.join(config, "updates/enabled.json"), { enabled: true });
  assert.equal(launch({ DITTO_CLI_AUTO_UPDATE: "0" }), priorRoot, "invocation disable also ignores an unactivated candidate");
  const laterRoot = path.join(cache, "versions", later, "package"); assert.equal(launch(), laterRoot, "enabled startup selects the verified candidate");
  await writeUpdateJSON(path.join(config, "updates/enabled.json"), { enabled: false });
  assert.equal(launch(), laterRoot, "a later disable retains the version a launch actually selected");
});

test("activation markers are immutable, target-bound and cannot turn an invalid or unverified bundle into executable code", async t => {
  const cache = path.join(await temporary(t), "updates"); await update(cache, fixture());
  assert.equal(await selectActivatedRelease(cache, "2.33.0", process.versions.node, fixtureTarget), undefined, "background staging alone is not activation");
  await Promise.all([recordCachedActivation(cache, version, fixtureTarget), recordCachedActivation(cache, version, fixtureTarget)]);
  const marker = path.join(cache, "activated", `${version}.json`), before = await readFile(marker);
  await recordCachedActivation(cache, version, fixtureTarget); assert.deepEqual(await readFile(marker), before);
  assert.equal((await selectActivatedRelease(cache, "2.33.0", process.versions.node, fixtureTarget)).version, version);
  assert.equal(await selectActivatedRelease(cache, "2.33.0", process.versions.node, "linux-arm64-glibc"), undefined);
  await recordCachedActivation(cache, "999.0.0", fixtureTarget);
  assert.equal((await selectActivatedRelease(cache, "2.33.0", process.versions.node, fixtureTarget)).version, version, "an unverified newer marker cannot grant execution");
  await writeFile(marker, JSON.stringify({ version, target: "linux-arm64-glibc" }));
  assert.equal(await selectActivatedRelease(cache, "2.33.0", process.versions.node, fixtureTarget), undefined);
  await assert.rejects(recordCachedActivation(cache, version, fixtureTarget), /invalid cached activation/);
});

for (const control of ["disable", "pin", "status"]) test(`self-update ${control} does not activate staged code before its control action`, async t => {
  for (const previouslyActivated of [false, true]) {
    const directory = await temporary(t), config = path.join(directory, "config"), cache = runtimeCache(config);
    const globalRoot = path.join(directory, "prefix/lib/node_modules/@heyditto/cli");
    const installFixture = async (root, release) => {
      await mkdir(root, { recursive: true, mode: 0o700 }); await cp(path.join(project, "dist"), path.join(root, "dist"), { recursive: true });
      const pkg = JSON.parse(await readFile(path.join(project, "package.json"), "utf8")); pkg.version = release;
      await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
      const lock = JSON.parse(await readFile(path.join(root, "dist/update-lock.json"), "utf8")); lock.packageVersion = release;
      await writeFile(path.join(root, "dist/update-lock.json"), JSON.stringify(lock));
      await symlink(path.join(project, "node_modules"), path.join(root, "node_modules"), "dir");
    };
    await installFixture(globalRoot, currentPackageVersion);
    const staged = `${version.split(".")[0]}.${Number(version.split(".")[1]) + 1}.0`;
    await privateDirectory(cache);
    for (const release of [...(previouslyActivated ? [version] : []), staged]) {
      const root = path.join(cache, "versions", release, "package");
      // Compile-owned runtime fixtures execute the actual entry/CLI/control
      // implementation. No registry request or global installation is used.
      await installFixture(root, release);
      await writeUpdateJSON(path.join(path.dirname(root), "verified.json"), { version: release, target: runtimeTarget, rootIntegrity: sri(Buffer.from("owned compiled runtime fixture")), nodeRanges: [">=22"] });
    }
    if (previouslyActivated) await recordCachedActivation(cache, version);
    await writeUpdateJSON(path.join(cache, "current.json"), { version: staged, target: runtimeTarget });
    const execute = args => spawnSync(process.execPath, [path.join(globalRoot, "dist/entry.js"), ...args], { cwd: directory, env: { DITTO_CONFIG_DIR: config }, encoding: "utf8", timeout: 8000 });
    const result = execute(["self-update", control, "--output", "json"]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const expected = previouslyActivated ? version : currentPackageVersion, data = JSON.parse(result.stdout);
    assert.equal(data.selectedVersion, expected, "a control must run the prior version, never the new candidate");
    assert.equal(data.stagedVersion, staged);
    await assert.rejects(readFile(path.join(cache, "activated", `${staged}.json`)), { code: "ENOENT" }, "control invocation must not create an activation marker");
    if (control === "disable") assert.equal(data.enabled, false);
    if (control === "pin") assert.equal(data.pinnedVersion, expected);
    const next = execute(["--version"]); assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout.trim(), control === "status" ? staged : expected, "an ordinary enabled launch can activate a candidate; freeze controls preserve the prior version");
  }
});

test("manual check reports its own busy outcome when an automatic check is active and then disabled", async t => {
  const directory = await temporary(t), config = path.join(directory, "config"), cache = runtimeCache(config);
  const globalRoot = path.join(directory, "prefix/lib/node_modules/@heyditto/cli"), entry = path.join(globalRoot, "dist/entry.js");
  await mkdir(globalRoot, { recursive: true }); await cp(path.join(project, "dist"), path.join(globalRoot, "dist"), { recursive: true });
  await cp(path.join(project, "package.json"), path.join(globalRoot, "package.json")); await symlink(path.join(project, "node_modules"), path.join(globalRoot, "node_modules"), "dir");
  const workerFile = path.join(globalRoot, "dist/update-worker.js");
  await writeFile(workerFile, "globalThis.fetch=()=>{throw new Error('busy fixture must not contact the registry');};\n" + await readFile(workerFile, "utf8"));
  const healthFile = path.join(cache, "health.json"), preloader = path.join(directory, "overwrite-shared-health.mjs");
  await writeFile(preloader, `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const read=fs.readFile;let reads=0;fs.readFile=async function(file,...args){if(String(file)===${JSON.stringify(healthFile)}&&++reads===2)await fs.writeFile(file,JSON.stringify({status:'current'}));return read.call(this,file,...args);};syncBuiltinESMExports();`);
  const execute = (args, overwrite = false) => spawnSync(process.execPath, [...(overwrite ? ["--import", preloader] : []), entry, ...args], { cwd: directory, env: { DITTO_CONFIG_DIR: config }, encoding: "utf8", timeout: 8000 });
  const service = fixture(); let reached, release;
  const fetching = new Promise(resolve => reached = resolve), proceed = new Promise(resolve => release = resolve);
  const automatic = runUpdate({ cache, currentVersion: currentPackageVersion, platform: process.platform, arch: process.arch, libc: runtimeTarget.split("-")[2], fetch: async (url, init) => { if (url === latest) { reached(); await proceed; } return service.fetch(url, init); } });
  let manual;
  try {
    await Promise.race([fetching, delay(8000, undefined, { ref: false }).then(() => { throw new Error("automatic worker did not reach its fetch"); })]);
    const disabled = execute(["self-update", "disable", "--output", "json"]); assert.equal(disabled.status, 0, disabled.stderr); assert.equal(JSON.parse(disabled.stdout).enabled, false);
    manual = execute(["self-update", "check", "--output", "json"], true);
  } finally { release(); await automatic; }
  await assert.rejects(pointer(cache), { code: "ENOENT" }, "disabled automatic worker must not publish an update");
  assert.equal(manual.status, 75, "a blocked manual request must report busy, never successful completion");
  const data = JSON.parse(manual.stdout);
  assert.equal(data.manualExitCode, 75); assert.equal(data.manualResult.status, "busy");
  assert.equal(data.health.status, "current", "concurrent shared health must not determine the manual result");
});

test("manual completion is independent of shared failure and a missing child result cannot claim success", async t => {
  for (const missing of [false, true]) {
    const directory = await temporary(t), config = path.join(directory, "config"), cache = runtimeCache(config);
    const globalRoot = path.join(directory, "prefix/lib/node_modules/@heyditto/cli");
    await mkdir(globalRoot, { recursive: true }); await cp(path.join(project, "dist"), path.join(globalRoot, "dist"), { recursive: true });
    await cp(path.join(project, "package.json"), path.join(globalRoot, "package.json")); await symlink(path.join(project, "node_modules"), path.join(globalRoot, "node_modules"), "dir");
    const workerFile = path.join(globalRoot, "dist/update-worker.js"), healthFile = path.join(cache, "health.json"), preloader = path.join(directory, "shared-failure.mjs");
    const metadata = { name: "@heyditto/cli", version: currentPackageVersion, repository: { url: "git+https://github.com/ditto-assistant/ditto-cli.git" }, engines: { node: ">=22" } };
    await writeFile(workerFile, missing ? "process.exit(0);" : `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(metadata))});\n` + await readFile(workerFile, "utf8"));
    await writeUpdateJSON(healthFile, { status: "current" });
    await writeFile(preloader, `import fs from 'node:fs/promises';import{syncBuiltinESMExports}from'node:module';const read=fs.readFile;let reads=0;fs.readFile=async function(file,...args){if(String(file)===${JSON.stringify(healthFile)}&&++reads===2)await fs.writeFile(file,JSON.stringify({status:'failed',detail:'another worker failed'}));return read.call(this,file,...args);};syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, [...(missing ? [] : ["--import", preloader]), path.join(globalRoot, "dist/entry.js"), "self-update", "check", "--output", "json"], { cwd: directory, env: { DITTO_CONFIG_DIR: config }, encoding: "utf8", timeout: 8000 });
    assert.equal(result.status, missing ? 1 : 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.manualResult.status, missing ? "incomplete" : "current");
    assert.equal(data.health.status, missing ? "current" : "failed");
  }
});
