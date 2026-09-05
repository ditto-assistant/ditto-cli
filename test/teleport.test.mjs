import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

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
          const generation = cap.headGeneration + 1;
          cap.generations.set(generation, { manifest: { ...manifest, generation }, manifestSha256, committedBy, committedAt: new Date().toISOString() });
          cap.headGeneration = generation;
          cap.bytesTotal = manifest.totals.bytes;
          return send(200, { capsule: view(), generation, mirrors: [{ target: "ditto-primary", providerId: "hippius", generation, status: "complete", verifiedAt: new Date().toISOString(), required: true }] });
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
      resolve({ base, chunks, capsules, calls, close: () => { server.closeAllConnections(); server.close(); } });
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
