import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureReviewSnapshot, snapshotDigest } from "../dist/review-snapshot.js";
import { gitBlobOID, gitTreeOID } from "../dist/review-git-tree.js";

const git = (cwd, ...args) => {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
};
const write = async (root, file, bytes) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), bytes); };
async function fixture(t, files = { "app.ts": "anchor\n", "removed.ts": "old\n", "context/caller.ts": "caller\n" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-anchor-review-")); t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Anchor fixture"); git(root, "config", "user.email", "anchor@example.test");
  git(root, "config", "core.hooksPath", "/dev/null");
  git(root, "remote", "add", "origin", "git@github.com:acme/project.git");
  for (const [file, bytes] of Object.entries(files)) await write(root, file, bytes);
  git(root, "add", "."); git(root, "commit", "-m", "anchor");
  const anchor = git(root, "rev-parse", "HEAD"); git(root, "update-ref", "refs/remotes/origin/main", anchor);
  return { root, anchor };
}
const content = (files, file) => Buffer.from(files.find(value => value.path === file).contentBase64, "base64").toString();

test("v2 digest and tree hashes match independent Python and Go golden identities", async () => {
  const golden = JSON.parse(await readFile(new URL("./fixtures/local-snapshot-v2.json", import.meta.url), "utf8"));
  assert.equal(snapshotDigest(golden), "ab462fe48804a5223134ab6773bc0921e856de3bc9e96fc2ad38dcceb7148d65");
  const anchor = new Map(Object.entries({ "README.md": "Anchor context\n", "src/alpha.go": "package p\n\nfunc Alpha() int { return 1 }\n", "src/obsolete.go": "package p\n\nfunc Obsolete() {}\n" }).map(([file, bytes]) => [file, { oid: gitBlobOID(Buffer.from(bytes)), mode: "100644" }]));
  for (const tree of ["base", "head"]) {
    const result = new Map(anchor);
    for (const file of golden[`${tree}DeletedPaths`]) result.delete(file);
    for (const file of golden[`${tree}Files`]) result.set(file.path, { oid: gitBlobOID(Buffer.from(file.contentBase64, "base64")), mode: file.mode });
    assert.equal(gitTreeOID(result), golden[`${tree}TreeSha`]);
  }
  assert.equal(snapshotDigest({ ...golden, anchorRef: "refs/heads/another", baseRef: "display-only" }), golden.digest, "ref hints do not change immutable byte identity");
  assert.notEqual(snapshotDigest({ ...golden, headDeletedPaths: [] }), golden.digest, "deletions are bound by identity");
});

test("anchored working and staged captures preserve unpushed commits, deletion overlays and exact Git trees", async t => {
  const { root, anchor } = await fixture(t);
  await write(root, "app.ts", "unpushed baseline\n"); git(root, "rm", "removed.ts"); git(root, "add", "app.ts"); git(root, "commit", "-m", "local-only commit");
  const baselineTree = git(root, "rev-parse", "HEAD^{tree}");
  await write(root, "app.ts", "staged bytes\n"); git(root, "add", "app.ts"); const stagedTree = git(root, "write-tree");
  await write(root, "app.ts", "working bytes\n"); await write(root, "tools/with space.sh", "echo exact\n"); await chmod(path.join(root, "tools/with space.sh"), 0o755);
  const index = await readFile(path.join(root, ".git/index")), config = await readFile(path.join(root, ".git/config"));
  const staged = await captureReviewSnapshot({ cwd: root, staged: true, allowAnchor: true });
  const working = await captureReviewSnapshot({ cwd: root, allowAnchor: true });
  assert.equal(staged.snapshot.version, 2); assert.equal(working.snapshot.version, 2); assert.equal(working.snapshot.anchorSha, anchor);
  assert.equal(working.snapshot.baseTreeSha, baselineTree); assert.equal(staged.snapshot.headTreeSha, stagedTree);
  assert.equal(content(staged.snapshot.headFiles, "app.ts"), "staged bytes\n"); assert.equal(content(working.snapshot.headFiles, "app.ts"), "working bytes\n");
  assert.deepEqual(working.snapshot.baseDeletedPaths, ["removed.ts"]); assert.deepEqual(working.snapshot.headDeletedPaths, ["removed.ts"]);
  assert.deepEqual(staged.snapshot.changedPaths, ["app.ts"]); assert.deepEqual(working.snapshot.changedPaths, ["app.ts", "tools/with space.sh"]);
  assert.ok(!working.snapshot.headFiles.some(file => file.path === "context/caller.ts"), "unchanged context is reconstructed in the cloud");
  assert.deepEqual(await readFile(path.join(root, ".git/index")), index); assert.deepEqual(await readFile(path.join(root, ".git/config")), config);
  git(root, "add", "."); assert.equal(working.snapshot.headTreeSha, git(root, "write-tree"), "real Git independently checks Node tree construction");
  assert.notEqual(staged.snapshot.digest, working.snapshot.digest); assert.ok(working.captureMs > 0);
});

test("Git tree construction preserves native ordering, executable owner bit, symlink and gitlink context", async t => {
  const { root } = await fixture(t, { "a.c": "flat\n", "a/name": "nested\n", "a0": "ordering\n", "unicode/é.ts": "utf8\n" });
  await symlink("a.c", path.join(root, "link")); git(root, "add", "link");
  const commit = git(root, "rev-parse", "HEAD"); await mkdir(path.join(root, "submodule")); git(root, "update-index", "--add", "--cacheinfo", `160000,${commit},submodule`);
  git(root, "commit", "-m", "opaque context"); git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  await write(root, "a.c", "native\n"); await chmod(path.join(root, "a.c"), 0o654);
  const { snapshot } = await captureReviewSnapshot({ cwd: root, allowAnchor: true });
  assert.equal(snapshot.version, 2); assert.equal(snapshot.headFiles.find(file => file.path === "a.c").mode, "100644", "group execute does not mean Git executable");
  git(root, "add", "a.c"); assert.equal(snapshot.headTreeSha, git(root, "write-tree"));
});

test("large unchanged cloud context never enters the overlay payload and legacy capability falls back explicitly", async t => {
  const { root } = await fixture(t, { "app.ts": "old\n", "asset.bin": Buffer.alloc(17 * 1024 * 1024) });
  await write(root, "app.ts", "new\n");
  const anchored = await captureReviewSnapshot({ cwd: root, allowAnchor: true });
  assert.equal(anchored.snapshot.version, 2); assert.equal(anchored.bytes, 4); assert.equal(anchored.snapshot.contextComplete, true);
  assert.equal(anchored.snapshot.headFiles.length, 1); assert.equal(anchored.snapshot.baseFiles.length, 0);
  const legacy = await captureReviewSnapshot({ cwd: root, allowAnchor: false });
  assert.equal(legacy.snapshot.version, 1); assert.match(legacy.fallbackReason, /not enabled/); assert.equal(legacy.snapshot.contextComplete, false);
});

test("unsupported selected or committed overlays fall back without claiming cloud-complete context", async t => {
  const { root } = await fixture(t);
  await write(root, "app.ts", Buffer.from([0, 1, 2]));
  const binary = await captureReviewSnapshot({ cwd: root, allowAnchor: true });
  assert.equal(binary.snapshot.version, 1); assert.equal(binary.snapshot.contextComplete, false); assert.match(binary.fallbackReason, /binary/);
  assert.ok(binary.snapshot.skipped.some(file => file.path === "app.ts"));
  await write(root, "app.ts", "text\n");
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const noAnchor = await captureReviewSnapshot({ cwd: root, allowAnchor: true });
  assert.equal(noAnchor.snapshot.version, 1); assert.match(noAnchor.fallbackReason, /no locally known/);
});

async function preservesGit(root, action) {
  const index = await readFile(path.join(root, ".git/index")), config = await readFile(path.join(root, ".git/config"));
  const refs = git(root, "for-each-ref", "--format=%(refname) %(objectname)");
  try { return await action(); }
  finally {
    assert.deepEqual(await readFile(path.join(root, ".git/index")), index, "capture must not rewrite the index");
    assert.deepEqual(await readFile(path.join(root, ".git/config")), config, "capture must not rewrite config");
    assert.equal(git(root, "for-each-ref", "--format=%(refname) %(objectname)"), refs, "capture must not change refs");
  }
}
const sparse = root => { git(root, "sparse-checkout", "init", "--cone", "--no-sparse-index"); git(root, "sparse-checkout", "set", "kept"); };

test("sparse --base capture keeps absent skip-worktree committed bytes and the materialized tree identity", async t => {
  const { root } = await fixture(t, { "kept/main.ts": "kept\n", "outside/changed.ts": "before\n", "outside/deleted.ts": "removed\n" });
  git(root, "switch", "-c", "feature"); await write(root, "outside/changed.ts", "committed after\n"); await write(root, "outside/added.ts", "committed addition\n");
  git(root, "rm", "outside/deleted.ts"); git(root, "add", "."); git(root, "commit", "-m", "unpushed outside changes");
  const actualHead = git(root, "rev-parse", "HEAD^{tree}");
  const materialized = await captureReviewSnapshot({ cwd: root, base: "main", allowAnchor: true });
  const materializedV1 = await captureReviewSnapshot({ cwd: root, base: "main", allowAnchor: false });
  sparse(root); assert.match(git(root, "ls-files", "-t", "outside/changed.ts"), /^S /);
  await assert.rejects(readFile(path.join(root, "outside/changed.ts")), { code: "ENOENT" });
  await preservesGit(root, async () => {
    const captured = await captureReviewSnapshot({ cwd: root, base: "main", allowAnchor: true });
    assert.equal(captured.snapshot.version, 2); assert.equal(captured.snapshot.headTreeSha, actualHead);
    assert.equal(captured.snapshot.digest, materialized.snapshot.digest, "sparse and materialized logical state must be identical");
    assert.deepEqual(captured.snapshot.headDeletedPaths, ["outside/deleted.ts"]);
    assert.equal(content(captured.snapshot.headFiles, "outside/changed.ts"), "committed after\n");
    const legacy = await captureReviewSnapshot({ cwd: root, base: "main", allowAnchor: false });
    assert.equal(legacy.snapshot.digest, materializedV1.snapshot.digest, "bounded fallback must preserve the same logical bytes");
  });
  await assert.rejects(readFile(path.join(root, "outside/changed.ts")), { code: "ENOENT" }, "capture must not materialize sparse files");
});

test("staged sparse bytes remain distinct from materialized working edits", async t => {
  const { root } = await fixture(t, { "kept/main.ts": "kept\n", "outside/changed.ts": "before\n" }); sparse(root);
  await write(root, ".git/staged-source", "hidden staged bytes\n");
  const oid = git(root, "hash-object", "-w", ".git/staged-source");
  git(root, "update-index", "--cacheinfo", `100755,${oid},outside/changed.ts`); git(root, "update-index", "--skip-worktree", "outside/changed.ts");
  const expectedIndex = git(root, "write-tree");
  await preservesGit(root, async () => {
    const staged = await captureReviewSnapshot({ cwd: root, staged: true, allowAnchor: true });
    const working = await captureReviewSnapshot({ cwd: root, allowAnchor: true });
    assert.equal(staged.snapshot.headTreeSha, expectedIndex); assert.equal(working.snapshot.headTreeSha, expectedIndex);
    assert.equal(content(working.snapshot.headFiles, "outside/changed.ts"), "hidden staged bytes\n");
    assert.equal(working.snapshot.headFiles.find(file => file.path === "outside/changed.ts").mode, "100755");
  });
  await write(root, "outside/changed.ts", "materialized working bytes\n");
  const working = await preservesGit(root, () => captureReviewSnapshot({ cwd: root, allowAnchor: true }));
  const staged = await preservesGit(root, () => captureReviewSnapshot({ cwd: root, staged: true, allowAnchor: true }));
  assert.equal(content(working.snapshot.headFiles, "outside/changed.ts"), "materialized working bytes\n");
  assert.equal(content(staged.snapshot.headFiles, "outside/changed.ts"), "hidden staged bytes\n");
  git(root, "add", "--sparse", "outside/changed.ts"); assert.equal(working.snapshot.headTreeSha, git(root, "write-tree"));
});

test("ordinary unflagged deletion in a sparse checkout remains reviewable", async t => {
  const { root } = await fixture(t, { "kept/main.ts": "delete this\n", "outside/context.ts": "hidden context\n" }); sparse(root);
  assert.match(git(root, "ls-files", "-t", "kept/main.ts"), /^H /); await rm(path.join(root, "kept/main.ts"));
  const captured = await preservesGit(root, () => captureReviewSnapshot({ cwd: root, allowAnchor: true }));
  assert.equal(captured.snapshot.version, 2); assert.deepEqual(captured.snapshot.headDeletedPaths, ["kept/main.ts"]);
  git(root, "add", "-u"); assert.equal(captured.snapshot.headTreeSha, git(root, "write-tree"));
});

test("missing selected sparse blobs abort before upload without fetching or rewriting Git state", async t => {
  const { root } = await fixture(t, { "kept/main.ts": "kept\n", "outside/changed.ts": "before\n" });
  git(root, "switch", "-c", "feature"); await write(root, "outside/changed.ts", "unique committed sparse bytes\n"); git(root, "add", "."); git(root, "commit", "-m", "outside change"); sparse(root);
  const oid = git(root, "rev-parse", "HEAD:outside/changed.ts"), objectFile = path.join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
  await rm(objectFile);
  git(root, "config", "core.repositoryformatversion", "1"); git(root, "config", "extensions.partialClone", "origin"); git(root, "config", "remote.origin.promisor", "true");
  git(root, "config", "remote.origin.url", path.join(root, "missing-local-promisor"));
  const trace = path.join(os.tmpdir(), path.basename(root) + "-trace.json"), previousTrace = process.env.GIT_TRACE2_EVENT;
  t.after(() => rm(trace, { force: true })); process.env.GIT_TRACE2_EVENT = trace;
  const fetches = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "child_start" && event.argv?.includes("fetch"));
  try {
    for (const allowAnchor of [true, false]) await preservesGit(root, async () => {
      await assert.rejects(captureReviewSnapshot({ cwd: root, base: "main", allowAnchor }), /available Git blob objects|missing.*object/i);
    });
    assert.equal((await fetches()).length, 0, "capture must never attempt a promisor fetch");
    // Positive instrumentation control: ordinary Git with lazy fetch explicitly
    // enabled attempts this fixture's missing LOCAL remote, never the network.
    spawnSync("git", ["cat-file", "--batch-check"], { cwd: root, input: oid + "\n", encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    assert.ok((await fetches()).length > 0, "the control must detect an actual lazy-fetch attempt");
  } finally { if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previousTrace; }
});

test("collapsed sparse-index directories fail closed until the user explicitly expands the index", async t => {
  const { root } = await fixture(t, { "kept/main.ts": "kept\n", "outside/context.ts": "hidden\n" });
  git(root, "sparse-checkout", "init", "--cone", "--sparse-index"); git(root, "sparse-checkout", "set", "kept");
  assert.match(git(root, "ls-files", "--stage", "--sparse"), /040000 .*outside\//);
  await write(root, "kept/main.ts", "working change\n");
  await preservesGit(root, async () => { await assert.rejects(captureReviewSnapshot({ cwd: root, allowAnchor: true }), /collapsed sparse-index.*--no-sparse-index/); });
  git(root, "sparse-checkout", "reapply", "--no-sparse-index");
  const captured = await preservesGit(root, () => captureReviewSnapshot({ cwd: root, allowAnchor: true }));
  assert.equal(captured.snapshot.version, 2); assert.deepEqual(captured.snapshot.changedPaths, ["kept/main.ts"]);
  await assert.rejects(readFile(path.join(root, "outside/context.ts")), { code: "ENOENT" });
});
