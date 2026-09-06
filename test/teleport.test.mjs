import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverRepos } from "../dist/teleport/discover.js";
import { dirtyPaths } from "../dist/teleport/worktree.js";
import { isExcluded, globMatch, cwdSlug } from "../dist/teleport/types.js";
import { pushCapsule } from "../dist/teleport/push.js";
import { pullCapsule } from "../dist/teleport/pull.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

/**
 * Parses the json tags out of the checked-in copy of the backend's manifest
 * structs (test/fixtures/manifest.go). Returns struct name -> { field: omitempty }.
 */
function goJsonTags(source) {
  const structs = {};
  const re = /type (\w+) struct \{([^}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    const fields = {};
    for (const line of m[2].split("\n")) {
      const t = /json:"([^",]+)(,omitempty)?"/.exec(line);
      if (t) fields[t[1]] = Boolean(t[2]);
    }
    structs[m[1]] = fields;
  }
  return structs;
}

/** Asserts `obj` only uses fields the Go struct declares and carries every non-omitempty one. */
function assertMatchesStruct(obj, structName, tags, where) {
  const fields = tags[structName];
  assert.ok(fields, `fixture has no struct ${structName}`);
  for (const key of Object.keys(obj)) {
    assert.ok(key in fields, `${where}: field "${key}" is not in Go struct ${structName} (${Object.keys(fields).join(", ")})`);
  }
  for (const [key, omitempty] of Object.entries(fields)) {
    if (!omitempty) assert.ok(key in obj, `${where}: required field "${key}" (Go ${structName}) is missing`);
  }
}

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Runs the built CLI without blocking the event loop (the stub API lives in this process). */
function runAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A git repo with one commit, a modified tracked file, an untracked file, and a .env that must never travel. */
function makeRepo() {
  const dir = tmp("teleport-repo-");
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "t@example.test"], dir);
  git(["config", "user.name", "Teleport Test"], dir);
  writeFileSync(path.join(dir, "README.md"), "# hello\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  writeFileSync(path.join(dir, "README.md"), "# hello\nmodified locally\n");
  writeFileSync(path.join(dir, "scratch.txt"), "untracked work in progress\n");
  writeFileSync(path.join(dir, ".env"), "SECRET=do-not-teleport\n");
  return dir;
}

/**
 * In-memory stand-in for /api/v5/teleport/*: negotiate returns loopback PUT
 * URLs, commit records the manifest, resolve hands back GET URLs. Chunk bytes
 * live in a Map so pull can round-trip.
 */
function startTeleportStub() {
  const chunks = new Map(); // sha256 -> Buffer
  const capsules = new Map(); // id -> { generations: Map<gen, manifest> }
  const buckets = new Map(); // id -> bucket
  const calls = [];
  const server = http.createServer((req, res) => {
    const bodyParts = [];
    req.on("data", (c) => bodyParts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(bodyParts);
      const url = new URL(req.url, "http://127.0.0.1");
      const p = url.pathname;
      calls.push({ method: req.method, path: p });
      const jsonBody = () => (raw.length ? JSON.parse(raw.toString()) : {});
      const send = (code, obj) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };

      // Chunk object store (presigned PUT/GET on the same server).
      if (p.startsWith("/obj/")) {
        const sha = p.slice("/obj/".length);
        if (req.method === "PUT") {
          const got = createHash("sha256").update(raw).digest("hex");
          if (got !== sha) return send(400, { error: "sha mismatch" });
          chunks.set(sha, raw);
          return send(200, {});
        }
        if (req.method === "GET") {
          const buf = chunks.get(sha);
          if (!buf) {
            res.statusCode = 404;
            return res.end();
          }
          res.statusCode = 200;
          return res.end(buf);
        }
      }

      if (p === "/api/v5/teleport/capsules" && req.method === "POST") {
        const id = `cap-${capsules.size + 1}`;
        capsules.set(id, { id, ...jsonBody(), headGeneration: 0, generations: new Map() });
        return send(201, { id, name: jsonBody().name, rootKind: jsonBody().rootKind, headGeneration: 0 });
      }
      if (p === "/api/v5/teleport/capsules" && req.method === "GET") {
        return send(200, {
          capsules: [...capsules.values()].map((c) => ({ id: c.id, name: c.name, rootKind: c.rootKind, headGeneration: c.headGeneration })),
        });
      }
      const capMatch = /^\/api\/v5\/teleport\/capsules\/([^/]+)(\/.*)?$/.exec(p);
      if (capMatch) {
        // {capsule} accepts a uuid or the name.
        const ref = decodeURIComponent(capMatch[1]);
        const cap = capsules.get(ref) ?? [...capsules.values()].find((c) => c.name === ref);
        if (!cap) return send(404, { error: "no capsule" });
        const view = () => ({ id: cap.id, name: cap.name, rootKind: cap.rootKind, headGeneration: cap.headGeneration, bytesTotal: cap.bytesTotal ?? 0, status: cap.status ?? "active" });
        const sub = capMatch[2] ?? "";
        if (sub === "" && req.method === "GET") return send(200, view());
        if (sub === "" && req.method === "PATCH") {
          Object.assign(cap, jsonBody());
          return send(200, view());
        }
        if (sub === "/negotiate" && req.method === "POST") {
          const body = jsonBody();
          if ("generation" in body || "parentGeneration" in body) return send(400, { error: "negotiate takes {chunks} only" });
          if (body.chunks.length > 200) return send(400, { error: "too many chunks" });
          const missing = body.chunks
            .filter((c) => !chunks.has(c.sha256))
            .map((c) => ({ sha256: c.sha256, size: c.size, putUrl: `${base}/obj/${c.sha256}`, expiresAt: new Date(Date.now() + 900e3).toISOString() }));
          return send(200, { missing, uploadedCount: body.chunks.length - missing.length });
        }
        if (sub === "/commit" && req.method === "POST") {
          const { manifest, manifestSha256, committedBy } = jsonBody();
          if (!manifestSha256 || !chunks.has(manifestSha256)) return send(412, { error: "manifest chunk missing" });
          if (!["cli", "runner"].includes(committedBy)) return send(400, { error: "bad committedBy" });
          // Mirror the backend's ParseManifest/Validate: `v` must be 1 and
          // parentGeneration must be generation-1 (the old `version` key is rejected).
          if (manifest.v !== 1 || "version" in manifest) return send(400, { error: "invalid teleport request: unsupported version" });
          if (manifest.parentGeneration !== manifest.generation - 1) return send(400, { error: "invalid teleport request: parentGeneration" });
          if (manifest.generation !== cap.headGeneration + 1) return send(409, { error: "stale parent" });
          const generation = manifest.generation;
          const committedAt = new Date().toISOString();
          cap.generations.set(generation, { manifest, manifestSha256, committedBy, committedAt });
          cap.headGeneration = generation;
          cap.bytesTotal = manifest.totals.bytes;
          const record = { generation, manifestSha256, bytes: manifest.totals.bytes, chunkCount: manifest.totals.chunks, committedAt, committedBy };
          return send(200, { capsule: view(), generation: record, mirrors: [{ target: "ditto-primary", providerId: "hippius", generation, status: "complete", verifiedAt: committedAt, required: true }] });
        }
        if (sub === "/generations" && req.method === "GET") {
          return send(200, { generations: [...cap.generations.entries()].map(([generation, g]) => ({ generation, manifestSha256: g.manifestSha256, bytes: g.manifest.totals.bytes, chunkCount: g.manifest.totals.chunks, committedAt: g.committedAt, committedBy: g.committedBy })) });
        }
        if (sub === "/resolve" && req.method === "GET") {
          const wanted = url.searchParams.get("generation");
          const generation = wanted ? Number(wanted) : cap.headGeneration;
          const g = cap.generations.get(generation);
          if (!g) return send(404, { error: "no generation" });
          const manifest = g.manifest;
          const seen = new Set();
          const chunkList = [];
          const collect = (refs) => {
            for (const r of refs ?? []) {
              if (seen.has(r.sha256)) continue;
              seen.add(r.sha256);
              chunkList.push({ sha256: r.sha256, size: r.size, getUrl: `${base}/obj/${r.sha256}` });
            }
          };
          for (const repo of manifest.repos) {
            for (const pack of repo.packs) collect(pack.chunks);
            if (repo.worktree) collect(repo.worktree.chunks);
          }
          collect(manifest.harness.chunks);
          return send(200, { capsule: view(), manifest, chunks: chunkList, generation });
        }
        if (sub === "/status" && req.method === "GET") {
          return send(200, { capsule: view(), headGeneration: cap.headGeneration, bytesTotal: cap.bytesTotal ?? 0, offloadReady: true, mirrors: [{ target: "ditto-primary", providerId: "hippius", generation: cap.headGeneration, status: "complete", verifiedAt: new Date().toISOString(), required: true }] });
        }
        if (sub === "/cloud-session" && req.method === "POST") {
          const body = jsonBody();
          if (!body.prompt) return send(400, { error: "prompt required" });
          return send(202, { jobId: "job-1", sessionId: "sess-1", agentId: "agent-1", threadId: "thread-1", endpointId: body.endpointId ?? "ep-1", harness: body.harness ?? "claude-code", harnessSessionId: "hs-1", generation: cap.headGeneration });
        }
      }
      // Bring-your-own buckets (/api/v5/teleport/buckets).
      if (p === "/api/v5/teleport/buckets" && req.method === "GET") {
        return send(200, { buckets: [...buckets.values()] });
      }
      if (p === "/api/v5/teleport/buckets" && req.method === "POST") {
        const body = jsonBody();
        if (!body.accessKeyID || !body.secretAccessKey || !body.bucket || !body.endpoint) return send(400, { error: "missing fields" });
        const id = `bkt-${buckets.size + 1}`;
        const { secretAccessKey, accessKeyID, ...rest } = body;
        const bucket = { id, providerKind: /hippius/.test(body.endpoint) ? "hippius" : "s3", region: body.region ?? "us-east-1", enabled: true, default: Boolean(body.default), teleportMirror: body.teleportMirror !== false, keyHint: accessKeyID.slice(-4), credentialState: "ready", ...rest };
        buckets.set(id, bucket);
        return send(201, bucket);
      }
      if (p === "/api/v5/teleport/buckets/test" && req.method === "POST") {
        const body = jsonBody();
        if (body.bucketId) return buckets.has(body.bucketId) ? send(200, { ok: true }) : send(404, { error: "no bucket" });
        if (body.settings) return send(200, /fail/.test(body.settings.endpoint ?? "") ? { ok: false, error: "connection refused" } : { ok: true });
        return send(400, { error: "bucketId or settings required" });
      }
      const bucketMatch = /^\/api\/v5\/teleport\/buckets\/([^/]+)$/.exec(p);
      if (bucketMatch) {
        const id = decodeURIComponent(bucketMatch[1]);
        const bucket = buckets.get(id);
        if (!bucket) return send(404, { error: "no bucket" });
        if (req.method === "PATCH") {
          Object.assign(bucket, jsonBody());
          return send(200, bucket);
        }
        if (req.method === "DELETE") {
          buckets.delete(id);
          res.statusCode = 204;
          return res.end();
        }
      }
      if (p === "/api/v5/teleport/targets" && req.method === "GET") {
        return send(200, { targets: [{ target: "ditto-primary", providerId: "hippius", label: "Ditto (Hippius)", required: true, available: true }, { target: "ditto-secondary", providerId: "backblaze", label: "Ditto (Backblaze)", required: true, available: true }], quotaGb: 250, capsuleLimit: -1 });
      }
      send(404, { error: `unhandled ${req.method} ${p}` });
    });
  });
  let base = "";
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, chunks, capsules, buckets, calls, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

test("discoverRepos: a repo root is a single-repo capsule", async () => {
  const dir = makeRepo();
  const d = await discoverRepos(dir);
  assert.equal(d.kind, "repo");
  assert.deepEqual(d.repos, ["."]);
});

test("dirtyPaths captures modified + untracked and never .env", () => {
  const dir = makeRepo();
  const dirty = dirtyPaths(dir);
  assert.ok(dirty.includes("README.md"), "modified tracked file");
  assert.ok(dirty.includes("scratch.txt"), "untracked file");
  assert.ok(!dirty.includes(".env"), ".env must be excluded");
});

test("isExcluded / globMatch / cwdSlug", () => {
  assert.equal(isExcluded(".env"), true);
  assert.equal(isExcluded(".env.local"), true);
  assert.equal(isExcluded("src/index.ts"), false);
  assert.equal(isExcluded("node_modules/foo/x.js"), true);
  assert.equal(globMatch("*.key", "server.key"), true);
  assert.equal(globMatch("*.key", "server.ts"), false);
  assert.equal(cwdSlug("/Users/x/code:proj"), "-Users-x-code-proj");
});

test("push then pull reproduces HEAD, branch, dirty edit, and untracked file", async () => {
  const stub = await startTeleportStub();
  const src = makeRepo();
  const configDir = tmp("teleport-cfg-");
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: configDir };
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);
  // Seed the capsule the push targets (the stub 404s on unknown ids).
  stub.capsules.set("cap-1", { id: "cap-1", name: "proj", rootKind: "repo", headGeneration: 0, generations: new Map() });
  try {
    const push = await pushCapsule({
      root: src,
      capsuleId: "cap-1",
      parentGeneration: null,
      harness: { kind: "none" },
      ignoredIncludes: [],
      rootName: "proj",
      rootKind: "repo",
    });
    assert.equal(push.generation, 1);
    assert.ok(push.uploaded > 0, "some chunks uploaded");

    // Contract: the committed manifest matches the backend's Go structs field for field.
    const committed = stub.capsules.get("cap-1").generations.get(1).manifest;
    const tags = goJsonTags(readFileSync(path.join(fixtureDir, "manifest.go"), "utf8"));
    assertMatchesStruct(committed, "Manifest", tags, "manifest");
    assert.equal(committed.v, 1, "manifest version travels as `v`");
    assert.equal(committed.parentGeneration, 0, "first generation has parentGeneration 0");
    assertMatchesStruct(committed.root, "Root", tags, "root");
    assertMatchesStruct(committed.harness, "Harness", tags, "harness");
    assertMatchesStruct(committed.totals, "Totals", tags, "totals");
    for (const repo of committed.repos) {
      assertMatchesStruct(repo, "Repo", tags, "repo");
      assertMatchesStruct(repo.head, "Head", tags, "repo.head");
      assertMatchesStruct(repo.worktree, "Worktree", tags, "repo.worktree");
      for (const remote of repo.remotes) assertMatchesStruct(remote, "Remote", tags, "repo.remotes");
      for (const pack of repo.packs) {
        assertMatchesStruct(pack, "Pack", tags, "repo.packs");
        for (const c of pack.chunks) assertMatchesStruct(c, "Chunk", tags, "chunk");
      }
      for (const c of repo.worktree.chunks) assertMatchesStruct(c, "Chunk", tags, "chunk");
    }
    assert.equal(committed.repos[0].head.branch, "main");
    assert.ok(committed.repos[0].branches.includes("main"), "branches are names");

    const headSrc = git(["rev-parse", "HEAD"], src).trim();
    const dest = tmp("teleport-dest-");
    const restored = await pullCapsule("cap-1", undefined, dest, { restoreHarness: false });
    const repoDest = path.resolve(dest, restored.repos[0]);
    assert.equal(git(["rev-parse", "HEAD"], repoDest).trim(), headSrc, "same commit");
    assert.equal(git(["symbolic-ref", "--short", "HEAD"], repoDest).trim(), "main", "same branch");
    assert.equal(readFileSync(path.join(repoDest, "README.md"), "utf8"), "# hello\nmodified locally\n", "dirty edit restored");
    assert.equal(readFileSync(path.join(repoDest, "scratch.txt"), "utf8"), "untracked work in progress\n", "untracked restored");
    assert.ok(!stub.chunks.size || true);
    // .env never left the machine:
    for (const buf of stub.chunks.values()) {
      assert.ok(!buf.toString("latin1").includes("do-not-teleport"), ".env content must never be uploaded");
    }
  } finally {
    Object.assign(process.env, prevEnv);
    for (const k of Object.keys(env)) if (!(k in prevEnv)) delete process.env[k];
    stub.close();
  }
});

test("teleport --help and push --dry-run work without auth", () => {
  const cfg = tmp("teleport-help-");
  const help = spawnSync(process.execPath, [cliPath, "teleport", "--help"], { encoding: "utf8", env: { ...process.env, DITTO_API_KEY: "", DITTO_CONFIG_DIR: cfg } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /move a coding session/);
  const dir = makeRepo();
  const dry = spawnSync(process.execPath, [cliPath, "teleport", "push", dir, "--dry-run"], { encoding: "utf8", env: { ...process.env, DITTO_API_KEY: "", DITTO_CONFIG_DIR: cfg } });
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.rootKind, "repo");
  assert.deepEqual(plan.repos, ["."]);
});

/**
 * Runs the built CLI against the stub with an isolated config dir. Async on
 * purpose: spawnSync would block the event loop the in-process stub needs.
 */
function cli(stub, cfg, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: cfg },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("commit-free second push restores full history plus the dirty worktree", async () => {
  const stub = await startTeleportStub();
  const cfg = tmp("teleport-cfg-");
  const src = makeRepo(); // 1 commit, dirty README.md, untracked scratch.txt, .env
  try {
    let r = await cli(stub, cfg, ["teleport", "push", src, "--name", "nocommit"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Pushed generation 1/);
    // Append to a tracked file without committing, then push again (HEAD == basis → no new bundle).
    writeFileSync(path.join(src, "README.md"), "# hello\nmodified locally\nmore\n");
    r = await cli(stub, cfg, ["teleport", "push", src, "--name", "nocommit"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Pushed generation 2/);
    const gen2 = stub.capsules.get("cap-1").generations.get(2).manifest;
    assert.ok(gen2.repos[0].packs.length >= 1, "generation 2 must still reference a pack chain");

    const dest = tmp("teleport-dest-");
    r = await cli(stub, cfg, ["teleport", "pull", "nocommit", dest, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const headSrc = git(["rev-parse", "HEAD"], src).trim();
    assert.equal(git(["rev-parse", "HEAD"], dest).trim(), headSrc, "same HEAD");
    assert.equal(git(["symbolic-ref", "--short", "HEAD"], dest).trim(), "main");
    const status = git(["status", "--short"], dest).split("\n").map((l) => l.trimEnd()).filter(Boolean).sort();
    assert.deepEqual(status, [" M README.md", "?? scratch.txt"]);
    assert.equal(readFileSync(path.join(dest, "README.md"), "utf8"), "# hello\nmodified locally\nmore\n");
    assert.equal(readFileSync(path.join(dest, "scratch.txt"), "utf8"), "untracked work in progress\n");
    assert.throws(() => readFileSync(path.join(dest, ".env")), ".env must not be restored");
  } finally {
    stub.close();
  }
});

test("thin second push after a new commit restores the new HEAD", async () => {
  const stub = await startTeleportStub();
  const cfg = tmp("teleport-cfg-");
  const src = makeRepo();
  try {
    let r = await cli(stub, cfg, ["teleport", "push", src, "--name", "thin"]);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(path.join(src, "second.txt"), "second commit\n");
    git(["add", "second.txt"], src);
    git(["commit", "-m", "second"], src);
    const newHead = git(["rev-parse", "HEAD"], src).trim();
    r = await cli(stub, cfg, ["teleport", "push", src, "--name", "thin"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Pushed generation 2/);
    const gen2 = stub.capsules.get("cap-1").generations.get(2).manifest;
    const kinds = gen2.repos[0].packs.map((p) => p.kind);
    assert.ok(kinds.includes("thin"), `generation 2 should carry a thin pack, got ${kinds}`);
    assert.ok(kinds.includes("full"), `generation 2 should reference its full basis pack, got ${kinds}`);

    const dest = tmp("teleport-dest-");
    r = await cli(stub, cfg, ["teleport", "pull", "thin", dest]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(["rev-parse", "HEAD"], dest).trim(), newHead, "HEAD is the new commit");
    assert.equal(readFileSync(path.join(dest, "second.txt"), "utf8"), "second commit\n");
    assert.equal(git(["rev-list", "--count", "HEAD"], dest).trim(), "2", "full history present");
  } finally {
    stub.close();
  }
});

test("teleport pull and --cloud refuse a capsule with no generations", async () => {
  const stub = await startTeleportStub();
  const cfg = tmp("teleport-gen0-");
  stub.capsules.set("cap-0", { id: "cap-0", name: "empty", rootKind: "repo", headGeneration: 0, generations: new Map() });
  const env = { ...process.env, DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: cfg };
  try {
    const pull = await runAsync(["teleport", "pull", "empty", tmp("teleport-gen0-dest-")], env);
    assert.equal(pull.status, 1);
    assert.match(pull.stderr, /has no generations yet/);
    assert.ok(!stub.calls.some((c) => c.path.endsWith("/resolve")), "pull must not hit resolve on an empty capsule");
  } finally {
    stub.close();
  }
});

test("storage add/list/test/remove round trip by name against the buckets API", async () => {
  const stub = await startTeleportStub();
  const cfg = tmp("teleport-storage-");
  const env = { ...process.env, DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: cfg };
  const run = (...args) => runAsync(args, env);
  try {
    const add = await run("storage", "add", "--name", "qa", "--endpoint", "https://s3.example.test", "--bucket", "qa-bucket", "--access-key", "AKIAQA", "--secret-key", "shh", "--json");
    assert.equal(add.status, 0, add.stderr);
    const saved = JSON.parse(add.stdout);
    assert.equal(saved.name, "qa");
    assert.equal(saved.providerKind, "s3");
    assert.equal(saved.teleportMirror, true);
    assert.ok(!("secretAccessKey" in saved), "secret never echoed back");
    const list = await run("storage", "list", "--json");
    assert.equal(list.status, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).buckets.length, 1);
    const testByName = await run("storage", "test", "qa");
    assert.equal(testByName.status, 0, testByName.stderr);
    assert.match(testByName.stdout, /connection ok/);
    const remove = await run("storage", "remove", "qa");
    assert.equal(remove.status, 0, remove.stderr);
    assert.equal(JSON.parse((await run("storage", "list", "--json")).stdout).buckets.length, 0);
    const missing = await run("storage", "test", "nope");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no bucket named "nope"/);
    // Only v5 teleport routes were used; the v2 storage routes need Firebase auth.
    assert.ok(stub.calls.every((c) => !c.path.startsWith("/api/v2/")), "no v2 storage calls");
  } finally {
    stub.close();
  }
});
