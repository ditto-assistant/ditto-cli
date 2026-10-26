import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureReviewSnapshot, snapshotDigest, reviewGit } from "../dist/review-snapshot.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO = { id: "33333333-3333-3333-3333-333333333333", fullName: "acme/project", enabled: true };
const RUN = "55555555-5555-5555-5555-555555555555";

function git(cwd, ...args) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}
async function repository(t, files = { "app.ts": "export const count = 1;\n", "caller.ts": "import {count} from './app';\n" }, commit = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ditto-local-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Review fixture"); git(root, "config", "user.email", "review@example.test");
  git(root, "remote", "add", "origin", "git@github.com:acme/project.git");
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  if (commit) { git(root, "add", "."); git(root, "commit", "-m", "fixture"); }
  return root;
}
const contents = (files, file) => Buffer.from(files.find(f => f.path === file).contentBase64, "base64").toString();

test("snapshot digest matches the independent Python/Go contract oracle", () => {
  const snapshot = { version: 1, mode: "staged", baseFiles: [{ path: "z.txt", contentBase64: "YmVmb3JlCg==", mode: "100755" }, { path: "a <tag>.txt", contentBase64: "c2FtZQo=" }], headFiles: [{ path: "a <tag>.txt", contentBase64: "c2FtZQo=" }, { path: "z.txt", contentBase64: "YWZ0ZXIK", mode: "100755" }], changedPaths: ["z.txt", "image.png"], omittedContext: ["unseen/caller.go"], contextComplete: false, skipped: [{ path: "image.png", reason: "binary" }] };
  assert.equal(snapshotDigest(snapshot), "fa40772f981a9f5feb5e4825a4d5c60ca5e18c0fa97febdd01671958ee26f52f");
});

test("capture Git subprocesses disable lazy fetch and credential prompts", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ditto-git-offline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "git"), "#!/bin/sh\nprintf '%s:%s:%s' \"$GIT_NO_LAZY_FETCH\" \"$GIT_TERMINAL_PROMPT\" \"$GIT_OPTIONAL_LOCKS\"\n", { mode: 0o755 });
  const prior = process.env.PATH;
  try {
    process.env.PATH = directory + path.delimiter + prior;
    assert.equal((await reviewGit(directory, ["--version"])).toString(), "1:0:0");
  } finally { process.env.PATH = prior; }
});

test("snapshot seals staged bytes separately from the working tree and preserves Git state", async t => {
  const root = await repository(t);
  await writeFile(path.join(root, "app.ts"), "export const count = 2;\n"); git(root, "add", "app.ts");
  await writeFile(path.join(root, "app.ts"), "export const count = 3;\n");
  await writeFile(path.join(root, "new file.ts"), "export const fresh = true;\n");
  const before = git(root, "status", "--porcelain=v1");
  const index = await readFile(path.join(root, ".git", "index"));
  const staged = await captureReviewSnapshot({ cwd: root, staged: true });
  const working = await captureReviewSnapshot({ cwd: root });
  assert.equal(contents(staged.snapshot.headFiles, "app.ts"), "export const count = 2;\n");
  assert.equal(contents(working.snapshot.headFiles, "app.ts"), "export const count = 3;\n");
  assert.deepEqual(staged.snapshot.changedPaths, ["app.ts"]);
  assert.deepEqual(working.snapshot.changedPaths, ["app.ts", "new file.ts"]);
  assert.equal(working.snapshot.digest, snapshotDigest(working.snapshot));
  await writeFile(path.join(root, "app.ts"), "edited after capture\n");
  assert.equal(contents(working.snapshot.headFiles, "app.ts"), "export const count = 3;\n");
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), index);
  assert.equal(git(root, "status", "--porcelain=v1"), before);
});

test("base selection includes branch commits and uncommitted changes, with deletes and spaces", async t => {
  const root = await repository(t, { "old name.ts": "old\n", "delete.ts": "gone\n" });
  const base = git(root, "rev-parse", "HEAD").trim();
  git(root, "switch", "-c", "feature"); git(root, "mv", "old name.ts", "new name.ts"); git(root, "rm", "delete.ts"); git(root, "commit", "-m", "rename and delete");
  await writeFile(path.join(root, "new name.ts"), "latest\n");
  const { snapshot } = await captureReviewSnapshot({ cwd: root, base: "main" });
  assert.equal(snapshot.baseSha, base);
  assert.deepEqual(snapshot.changedPaths, ["delete.ts", "new name.ts", "old name.ts"]);
  assert.equal(contents(snapshot.baseFiles, "old name.ts"), "old\n");
  assert.equal(contents(snapshot.headFiles, "new name.ts"), "latest\n");
  assert.ok(!snapshot.headFiles.some(f => f.path === "delete.ts"));
  await assert.rejects(captureReviewSnapshot({ cwd: root, staged: true, base: "main" }), /cannot be used together/);
  await assert.rejects(captureReviewSnapshot({ cwd: root, base: "--output=bad" }), /git rev-parse failed/);
});

test("unborn repositories work; ignored files, binaries and symlinks are not uploaded as source", async t => {
  const root = await repository(t, { ".gitignore": "secret.txt\n", "app.ts": "hello\n" }, false);
  await writeFile(path.join(root, "secret.txt"), "do not capture\n");
  await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2]));
  const outside = path.join(path.dirname(root), path.basename(root) + "-outside");
  await writeFile(outside, "outside secret\n"); t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, "link.ts"));
  const { snapshot } = await captureReviewSnapshot({ cwd: root });
  assert.equal(snapshot.baseSha, undefined);
  assert.equal(snapshot.baseFiles.length, 0);
  assert.ok(!snapshot.headFiles.some(f => ["secret.txt", "image.bin", "link.ts"].includes(f.path)));
  assert.ok(snapshot.skipped.some(f => f.path === "image.bin" && /binary/.test(f.reason)));
  assert.ok(snapshot.skipped.some(f => f.path === "link.ts" && /symlink/.test(f.reason)));
  assert.equal(snapshot.contextComplete, false);
  assert.ok(snapshot.headFiles.every(f => !contents(snapshot.headFiles, f.path).includes("outside secret")));
});

test("file/directory replacements preserve the deleted source and new files", async t => {
  const root = await repository(t, { "leaf": "old leaf\n", "dir/source.ts": "old nested source\n" });
  await rm(path.join(root, "leaf")); await mkdir(path.join(root, "leaf")); await writeFile(path.join(root, "leaf/new.ts"), "new nested\n");
  await rm(path.join(root, "dir"), { recursive: true }); await writeFile(path.join(root, "dir"), "new leaf\n");
  const { snapshot } = await captureReviewSnapshot({ cwd: root });
  assert.deepEqual(snapshot.changedPaths, ["dir", "dir/source.ts", "leaf", "leaf/new.ts"]);
  assert.equal(contents(snapshot.baseFiles, "leaf"), "old leaf\n");
  assert.equal(contents(snapshot.baseFiles, "dir/source.ts"), "old nested source\n");
  assert.equal(contents(snapshot.headFiles, "dir"), "new leaf\n");
  assert.equal(contents(snapshot.headFiles, "leaf/new.ts"), "new nested\n");
  assert.deepEqual(snapshot.skipped, []);
});

test("large unchanged context is omitted explicitly while selected changes must fit", async t => {
  const root = await repository(t, { "app.ts": "first\n", "large.txt": "x".repeat(9 * 1024 * 1024) });
  await writeFile(path.join(root, "app.ts"), "changed\n");
  const { snapshot } = await captureReviewSnapshot({ cwd: root });
  assert.equal(snapshot.contextComplete, false);
  assert.deepEqual(snapshot.omittedContext, ["large.txt"]);
  assert.deepEqual(snapshot.changedPaths, ["app.ts"]);
  await writeFile(path.join(root, "large.txt"), "y".repeat(9 * 1024 * 1024));
  await assert.rejects(captureReviewSnapshot({ cwd: root }), /changed files exceed local review limits/);
});

test("unsupported raw Git path bytes fail closed without a lossy snapshot", async t => {
  const root = await repository(t);
  // Store a raw index name rather than creating an invalid filesystem name:
  // APFS itself rejects those bytes, while Git can receive them from a remote.
  const oid = git(root, "hash-object", "-w", "--stdin").trim();
  const entry = Buffer.concat([Buffer.from(`100644 ${oid}\t`), Buffer.from([255]), Buffer.from(".ts\0")]);
  const indexed = spawnSync("git", ["update-index", "-z", "--index-info"], { cwd: root, input: entry });
  assert.equal(indexed.status, 0, indexed.stderr.toString());
  await assert.rejects(captureReviewSnapshot({ cwd: root, staged: true }), /requires UTF-8 Git paths/);
});

test("UTF-8 byte-order-mark characters in filenames retain their path identity", async t => {
  const root = await repository(t);
  const file = "\uFEFFsource.ts";
  await writeFile(path.join(root, file), "new source\n");
  const { snapshot } = await captureReviewSnapshot({ cwd: root });
  assert.deepEqual(snapshot.changedPaths, [file]);
  assert.equal(contents(snapshot.headFiles, file), "new source\n");
});

test("working-diff capture suppresses configured clean filters without changing repository configuration", async t => {
  const root = await repository(t);
  const helper = path.join(root, ".git", "filter.cjs"), marker = path.join(root, ".git", "filter-ran");
  await writeFile(helper, "require('node:fs').writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n");
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const clean = [process.execPath, helper, marker].map(shellQuote).join(" ");
  git(root, "config", "filter.fixture.clean", clean); git(root, "config", "filter.fixture.required", "true");
  await writeFile(path.join(root, ".gitattributes"), "*.ts filter=fixture\n");
  await writeFile(path.join(root, "app.ts"), "changed\n");
  git(root, "diff", "--name-only");
  assert.equal(await readFile(marker, "utf8"), "ran", "negative control must actually execute the configured filter");
  await rm(marker);
  const { snapshot } = await captureReviewSnapshot({ cwd: root });
  assert.equal(contents(snapshot.headFiles, "app.ts"), "changed\n");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(git(root, "config", "--get", "filter.fixture.clean").trim(), clean);
  assert.equal(git(root, "config", "--get", "filter.fixture.required").trim(), "true");
});

test("unrelated non-UTF-8 config subsections do not change the snapshot or abort capture", async t => {
  const root = await repository(t);
  await writeFile(path.join(root, "app.ts"), "changed\n");
  const before = await captureReviewSnapshot({ cwd: root });
  const config = path.join(root, ".git", "config");
  const bytes = Buffer.concat([await readFile(config), Buffer.from('\n[review-fixture "'), Buffer.from([255]), Buffer.from('"]\nvalue = true\n')]);
  await writeFile(config, bytes);
  const keys = spawnSync("git", ["config", "--null", "--name-only", "--list"], { cwd: root });
  assert.equal(keys.status, 0, keys.stderr.toString());
  assert.ok(keys.stdout.includes(Buffer.from([255])), "Git must actually return the unsupported config subsection bytes");
  const after = await captureReviewSnapshot({ cwd: root });
  assert.equal(after.snapshot.digest, before.snapshot.digest);
  assert.deepEqual(await readFile(config), bytes);
});

test("undecodable active filter names fail closed before a filter can execute", async t => {
  const root = await repository(t);
  const config = path.join(root, ".git", "config"), marker = path.join(root, ".git", "filter-ran");
  const bytes = Buffer.concat([await readFile(config), Buffer.from('\n[filter "fixture'), Buffer.from([255]), Buffer.from('"]\nclean = "touch .git/filter-ran; cat"\nrequired = true\n')]);
  await writeFile(config, bytes);
  await writeFile(path.join(root, ".gitattributes"), Buffer.concat([Buffer.from("*.ts filter=fixture"), Buffer.from([255]), Buffer.from("\n")]));
  await writeFile(path.join(root, "app.ts"), "changed\n");
  git(root, "diff", "--name-only");
  assert.equal(await readFile(marker, "utf8"), "", "ordinary Git must execute the raw-byte driver in this control");
  await rm(marker);
  await assert.rejects(captureReviewSnapshot({ cwd: root }), /cannot safely disable a non-UTF-8 Git filter driver/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual(await readFile(config), bytes);
});

async function stub(t, { partial = false, forever = false, loseAdmission = false, transientPoll = false, invalidRun = false, terminalStatus, noResult = false } = {}) {
  const calls = []; let digest, profile, lost = false, pollFailed = false;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method, url: req.url, body: parsed });
      const json = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.url === "/api/v5/review") return json(200, { repositories: [REPO] });
      if (req.url === `/api/v5/review/repositories/${REPO.id}/local`) {
        digest = parsed.snapshot.digest; profile = parsed.profile;
        assert.match(parsed.requestId, /^[0-9a-f-]{36}$/);
        assert.equal(digest, snapshotDigest(parsed.snapshot));
        if (loseAdmission && !lost) { lost = true; return json(503, { message: "fixture admission response lost" }); }
        return json(202, { runId: invalidRun ? "-".repeat(36) : RUN, status: "queued", profile, snapshotDigest: digest, budgetCents: 25, maxSeconds: 90 });
      }
      if (req.url === `/api/v5/review/local/runs/${RUN}/cancel`) return json(200, { runId: RUN, status: "cancelled" });
      if (req.url === `/api/v5/review/local/runs/${RUN}`) {
        if (transientPoll && !pollFailed) { pollFailed = true; return json(503, { message: "temporary read outage" }); }
        return json(200, { runId: RUN, status: terminalStatus ?? (forever ? "running" : partial ? "partial" : "completed"), profile, snapshotDigest: digest, budgetCents: 25, maxSeconds: 90, chargedCredits: 3, ...(noResult ? {} : { result: { complete: !partial, findings: [{ status: "posted", path: "app.ts", line: 1, severity: "high", title: "Fixture defect", body: "Real fixture finding" }], local: { contextComplete: !partial, changedCoverageComplete: true } } }) });
      }
      json(404, { message: "unexpected route" });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

function command(root, base, args, { authenticated = true } = {}) {
  const child = spawn(process.execPath, [cli, "review", ...args], { cwd: root, env: { ...process.env, DITTO_API_KEY: authenticated ? "ditto_mcp_fixture" : "", DITTO_API_BASE: base, DITTO_CONFIG_DIR: path.join(root, ".tmp", "config") }, stdio: ["ignore", "pipe", "pipe"] });
  const result = new Promise((resolve, reject) => {
    let stdout = "", stderr = ""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}

test("preview is offline and authenticated local review polls the shared service with clean JSON", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "bug\n");
  const service = await stub(t);
  const preview = await command(root, service.base, ["local", "--preview", "--output", "json"], { authenticated: false }).result;
  assert.equal(preview.code, 0, preview.stderr); assert.deepEqual(JSON.parse(preview.stdout).changedPaths, ["app.ts"]);
  assert.equal(service.calls.length, 0);
  const out = await command(root, service.base, ["local", "--output", "json"]).result;
  assert.equal(out.code, 0, out.stderr);
  const data = JSON.parse(out.stdout);
  assert.equal(data.status, "completed"); assert.equal(data.workspaceCurrent, true); assert.equal(data.result.findings[0].title, "Fixture defect");
  assert.ok(service.calls.some(c => c.url === `/api/v5/review/local/runs/${RUN}`));
  assert.ok(service.calls.every(c => !/pulls|\/fix|github/.test(c.url)));
  assert.match(out.stderr, /Uploading 1 changed paths/);
});

test("partial coverage exits nonzero and says reviewed scope; timeout cancels the admitted run", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "bug\n");
  const partial = await stub(t, { partial: true });
  const out = await command(root, partial.base, ["local"]).result;
  assert.equal(out.code, 1, out.stderr); assert.match(out.stdout, /in reviewed scope/); assert.match(out.stdout, /Surrounding context was bounded/);
  const ongoing = await stub(t, { forever: true });
  const timed = await command(root, ongoing.base, ["local", "--timeout", "1", "--output", "json"]).result;
  assert.equal(timed.code, 124, timed.stderr); assert.match(timed.stderr, /timed out/);
  if (/Local review run:/.test(timed.stderr)) assert.ok(ongoing.calls.some(c => c.url.endsWith("/cancel") && c.method === "POST"));
  else assert.ok(!ongoing.calls.some(c => /\/local$/.test(c.url) && c.method === "POST"), "capture timed out before admission and must not be billed");
  const interrupted = command(root, ongoing.base, ["local", "--output", "json"]);
  let signalSent = false, stderr = "";
  interrupted.child.stderr.on("data", chunk => {
    stderr += chunk;
    if (!signalSent && /Local review run:/.test(stderr)) { signalSent = true; interrupted.child.kill("SIGINT"); }
  });
  const cancelled = await interrupted.result;
  assert.equal(cancelled.code, 130, cancelled.stderr); assert.ok(signalSent);
  assert.ok(ongoing.calls.some(c => c.url.endsWith("/cancel") && c.method === "POST"));
});

test("uncertain admissions are recoverable with the same request ID and never automatically retried", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "bug\n");
  const service = await stub(t, { loseAdmission: true });
  const requestId = "88888888-8888-8888-8888-888888888888";
  const first = await command(root, service.base, ["local", "--request-id", requestId, "--output", "json"]).result;
  assert.equal(first.code, 1); assert.match(first.stderr, /Admission outcome is unknown/); assert.match(first.stderr, /Recover the same admission: heyditto review local --request-id 88888888/);
  assert.equal(service.calls.filter(c => c.method === "POST").length, 1);
  const second = await command(root, service.base, ["local", "--request-id", requestId, "--output", "json"]).result;
  assert.equal(second.code, 0, second.stderr);
  const posts = service.calls.filter(c => c.method === "POST");
  assert.equal(posts.length, 2); assert.equal(posts[0].body.requestId, posts[1].body.requestId); assert.equal(posts[0].body.snapshot.digest, posts[1].body.snapshot.digest);
  const callsBefore = service.calls.length;
  const invalid = await command(root, service.base, ["local", "--request-id", "not-a-uuid"]).result;
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /--request-id must be a UUID/); assert.equal(service.calls.length, callsBefore);
});

test("a transient polling read retries without cancelling or admitting another review", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "bug\n");
  const service = await stub(t, { transientPoll: true });
  const out = await command(root, service.base, ["local", "--output", "json"]).result;
  assert.equal(out.code, 0, out.stderr); assert.equal(JSON.parse(out.stdout).status, "completed");
  assert.equal(service.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(service.calls.filter(c => c.url === `/api/v5/review/local/runs/${RUN}`).length, 2);
  assert.ok(!service.calls.some(c => c.url.endsWith("/cancel")));
});

test("malformed admission IDs are not polled or cancelled; failed runs do not claim no findings", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "bug\n");
  const malformed = await stub(t, { invalidRun: true });
  const invalid = await command(root, malformed.base, ["local"]).result;
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /no valid run ID/);
  assert.equal(malformed.calls.filter(c => /local\/runs/.test(c.url)).length, 0);
  for (const terminalStatus of ["failed", "cancelled"]) {
    const service = await stub(t, { terminalStatus, noResult: true });
    const out = await command(root, service.base, ["local"]).result;
    assert.equal(out.code, 1, out.stderr); assert.match(out.stdout, /No review result is available/); assert.doesNotMatch(out.stdout, /No findings/);
  }
});

test("failed or cancelled runs with attached findings do not render unavailable findings", async t => {
  const root = await repository(t); await writeFile(path.join(root, "app.ts"), "bug\n");
  for (const terminalStatus of ["failed", "cancelled"]) {
    const service = await stub(t, { terminalStatus });
    const out = await command(root, service.base, ["local"]).result;
    assert.equal(out.code, 1, out.stderr);
    assert.match(out.stdout, /No review result is available/);
    assert.doesNotMatch(out.stdout, /Fixture defect|Real fixture finding|in reviewed scope/);
    const json = await command(root, service.base, ["local-status", RUN, "--output", "json"]).result;
    assert.equal(JSON.parse(json.stdout).result.findings[0].title, "Fixture defect", "JSON receipts retain the server evidence");
  }
  const completed = await stub(t);
  const out = await command(root, completed.base, ["local"]).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /1 finding in reviewed scope/);
  assert.match(out.stdout, /Fixture defect/);
});
