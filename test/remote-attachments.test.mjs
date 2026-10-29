import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPrompt, downloadAttachments, ensureTmpExcluded, safeAttachmentName } from "../dist/remote/attachments.js";

const bytes = Buffer.from("attachment fixture");
const attachment = (overrides = {}) => ({
  id: "same-prefix-id", name: "fixture.txt", mime: "text/plain", size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), url: "http://unused.test/",
  ...overrides,
});

test("Claude TUI file references quote spaces and close autocomplete before submit", () => {
  const files = [{ relPath: ".tmp/ditto/attachments/turn/image with space.png" }];
  assert.equal(buildPrompt("inspect", files, { nativeFileReferences: true }),
    'inspect\n\nAttached files:\n- @".tmp/ditto/attachments/turn/image with space.png"\n\n');
  assert.equal(buildPrompt("inspect", files),
    "inspect\n\nAttached files:\n- .tmp/ditto/attachments/turn/image with space.png");
});

test("attachment descriptors reject traversal and invalid sizes before downloading", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-attachment-"));
  let fetches = 0;
  const fetcher = async () => { fetches++; return bytes; };
  try {
    for (const turn of [".", "..", "../outside", "/outside"]) {
      await assert.rejects(downloadAttachments(cwd, turn, [attachment()], fetcher), /invalid turn id/);
    }
    for (const size of [-1, NaN, Infinity, 1.5, 512 * 1024 * 1024 + 1]) {
      await assert.rejects(downloadAttachments(cwd, "turn", [attachment({ size })], fetcher), /invalid attachment size/);
    }
    assert.equal(fetches, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("attachment download checks actual bytes and retains every duplicate filename", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-attachment-"));
  try {
    await assert.rejects(downloadAttachments(cwd, "wrong-size", [attachment()], async () => Buffer.from("short")), /size mismatch/);
    await assert.rejects(downloadAttachments(cwd, "wrong-hash", [attachment({ sha256: "0".repeat(64) })], async () => bytes), /sha256 mismatch/);
    const files = await downloadAttachments(cwd, "duplicates", Array.from({ length: 4 }, () => attachment()), async () => bytes);
    assert.equal(new Set(files.map((file) => file.absPath)).size, 4);
    for (const file of files) assert.deepEqual(await readFile(file.absPath), bytes);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("real GET attachment downloads reject redirects, truncated and overlong bodies", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-attachment-"));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/redirect") { res.writeHead(302, { location: "/valid" }); res.end(); return; }
    if (req.url === "/short") { res.end(bytes.subarray(0, 3)); return; }
    if (req.url === "/long") { res.write(bytes); res.end(Buffer.alloc(1024)); return; }
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ["redirect", "short", "long"]) {
      await assert.rejects(downloadAttachments(cwd, route, [attachment({ url: `${base}/${route}` })]));
    }
    assert.equal(requests.includes("/valid"), false, "signed download never follows redirects");
    const [file] = await downloadAttachments(cwd, "valid", [attachment({ url: `${base}/valid` })]);
    assert.deepEqual(await readFile(file.absPath), bytes);
    assert.equal(requests.length, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("attachment writes cannot follow existing repository symlinks or overwrite files", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-attachment-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "ditto-outside-"));
  try {
    await symlink(outside, path.join(cwd, ".tmp"), "dir");
    await assert.rejects(downloadAttachments(cwd, "turn", [attachment()], async () => bytes), /regular directory/);
    await rm(path.join(cwd, ".tmp"));
    const dir = path.join(cwd, ".tmp", "ditto", "attachments", "turn");
    await mkdir(dir, { recursive: true });
    const target = path.join(outside, "target.txt");
    await writeFile(target, "original");
    await symlink(target, path.join(dir, "fixture.txt"));
    await assert.rejects(downloadAttachments(cwd, "turn", [attachment()], async () => bytes), /EEXIST/);
    assert.equal(await readFile(target, "utf8"), "original");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});


test("attachment names and colon turn identifiers are portable", async () => {
  for (const name of ["nul.txt", "CON", "lpt9.log", "conin$.txt"]) assert.ok(safeAttachmentName(name).startsWith("_"));
  assert.equal(safeAttachmentName('screen:shot?.png. '), "screen_shot_.png");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-attachment-"));
  try {
    const files = await downloadAttachments(cwd, "channel:turn", [attachment({name:"A.txt"}), attachment({name:"a.txt"})], async () => bytes);
    assert.ok(!files[0].relPath.includes(":"));
    assert.notEqual(files[0].absPath.toLowerCase(), files[1].absPath.toLowerCase());
  } finally { await rm(cwd, {recursive:true,force:true}); }
});

test("attachment integrity requires a complete digest before any network request", async () => {
  let requests=0;
  for (const sha256 of ["", "0".repeat(63), "z".repeat(64)]) {
    await assert.rejects(downloadAttachments(os.tmpdir(), "invalid-digest", [attachment({sha256})], async () => {requests++;return bytes;}), /invalid attachment sha256/);
  }
  assert.equal(requests,0);
});

test("redelivery reuses identical regular files and refuses changed files", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-attachment-"));
  try {
    const first = await downloadAttachments(cwd,"redelivered",[attachment()],async()=>bytes);
    const second = await downloadAttachments(cwd,"redelivered",[attachment()],async()=>bytes);
    assert.equal(first[0].absPath,second[0].absPath);
    await writeFile(first[0].absPath,Buffer.alloc(bytes.length,65));
    await assert.rejects(downloadAttachments(cwd,"redelivered",[attachment()],async()=>bytes),/EEXIST/);
    assert.deepEqual(await readFile(first[0].absPath),Buffer.alloc(bytes.length,65));
  } finally { await rm(cwd,{recursive:true,force:true}); }
});

test("nested repository sessions exclude their own attachment directory", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-attachment-git-"));
  try {
    execFileSync("git",["init","-q",cwd]);
    await writeFile(path.join(cwd,".gitignore"),"/.tmp/\n");
    await mkdir(path.join(cwd,".tmp"));
    const nested=path.join(cwd,"nested");
    await mkdir(path.join(nested,".tmp"),{recursive:true});
    assert.equal(await ensureTmpExcluded(nested),true);
    assert.equal(execFileSync("git",["check-ignore","nested/.tmp"],{cwd,encoding:"utf8"}).trim(),"nested/.tmp");
    assert.equal(await ensureTmpExcluded(nested),false);
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
