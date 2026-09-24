import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { moveLocalRootToTrash } = await import(path.join(root, "dist/teleport/offload.js"));

test("macOS Trash move deletes selected node_modules but preserves project files and other caches", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "heyditto-offload-"));
  const source = path.join(parent, "project");
  const trash = path.join(parent, "Trash");
  await mkdir(path.join(source, "apps", "web", "node_modules"), { recursive: true });
  await mkdir(path.join(source, ".cache"));
  await mkdir(trash);
  await writeFile(path.join(source, "README.md"), "project source");
  await writeFile(path.join(source, "apps", "web", "node_modules", "package.js"), "dependency");
  await writeFile(path.join(source, ".cache", "blob"), "unconfirmed cache");

  const result = await moveLocalRootToTrash(source, trash, ["apps/web/node_modules"]);
  assert.equal(result.method, "trash");
  assert.deepEqual(result.deletedDependencies, ["apps/web/node_modules"]);
  assert.equal(await stat(source).then(() => true, () => false), false);
  assert.equal(await readFile(path.join(result.location, "README.md"), "utf8"), "project source");
  assert.equal(await readFile(path.join(result.location, ".cache", "blob"), "utf8"), "unconfirmed cache");
  assert.equal(await stat(path.join(result.location, "apps", "web", "node_modules")).then(() => true, () => false), false);
});

test("retained dependencies and a failed Trash move leave files recoverable", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "heyditto-offload-"));
  const source = path.join(parent, "project");
  await mkdir(path.join(source, "node_modules"), { recursive: true });
  await writeFile(path.join(source, "node_modules", "package.js"), "dependency");
  await assert.rejects(moveLocalRootToTrash(source, path.join(parent, "missing-trash"), ["node_modules"]));
  assert.equal(await readFile(path.join(source, "node_modules", "package.js"), "utf8"), "dependency");

  const trash = path.join(parent, "Trash");
  await mkdir(trash);
  const result = await moveLocalRootToTrash(source, trash);
  assert.deepEqual(result.deletedDependencies, []);
  assert.equal(await readFile(path.join(result.location, "node_modules", "package.js"), "utf8"), "dependency");
});

test("dependency cleanup does not follow symlinks inside Trash", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "heyditto-offload-"));
  const source = path.join(parent, "project");
  const outside = path.join(parent, "outside");
  const trash = path.join(parent, "Trash");
  await mkdir(source);
  await mkdir(outside);
  await mkdir(trash);
  await writeFile(path.join(outside, "important.txt"), "keep");
  await symlink(outside, path.join(source, "node_modules"));
  const result = await moveLocalRootToTrash(source, trash, ["node_modules"]);
  assert.deepEqual(result.deletedDependencies, []);
  assert.deepEqual(result.retainedDependencies, ["node_modules"]);
  assert.equal(await readFile(path.join(outside, "important.txt"), "utf8"), "keep");
});
