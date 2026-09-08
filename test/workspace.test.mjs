import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { discoverWorkspace, planCapture, offloadBlockers } = await import(path.join(root, "dist/teleport/workspace.js"));
const { detectTypes, PROJECT_TYPES } = await import(path.join(root, "dist/teleport/catalog.js"));
const { isExcluded } = await import(path.join(root, "dist/teleport/types.js"));
const { dirtyPaths } = await import(path.join(root, "dist/teleport/worktree.js"));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_NAME: "qa", GIT_AUTHOR_EMAIL: "qa@x", GIT_COMMITTER_NAME: "qa", GIT_COMMITTER_EMAIL: "qa@x" } }).toString();
}

async function write(base, files) {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(base, rel)), { recursive: true });
    await writeFile(path.join(base, rel), body);
  }
}

async function initRepo(dir, files) {
  await mkdir(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  await write(dir, files);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
}

/**
 * Mixed parent folder: a Node app with a dependency tree and a source directory
 * named `build`, a Rust crate with a target dir, a Python package nested inside
 * a monorepo repo, a linked worktree, symlink cycle + escape, and unrelated docs.
 */
async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "tp-ws-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "tp-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "outside");

  await initRepo(path.join(parent, "web"), {
    "package.json": '{"name":"web"}',
    "src/index.js": "console.log(1)\n",
    "build/app.js": "// SOURCE, not an artifact: node has no `build` rule\n",
    ".gitignore": "node_modules/\n",
  });
  await write(path.join(parent, "web"), { "node_modules/left-pad/index.js": "x".repeat(5000), "node_modules/left-pad/package.json": "{}" });

  await initRepo(path.join(parent, "crate"), { "Cargo.toml": "[package]\nname='crate'\n", "src/main.rs": "fn main(){}\n", ".gitignore": "target/\n" });
  await write(path.join(parent, "crate"), { "target/debug/crate": "\0".repeat(4000) });

  await initRepo(path.join(parent, "mono"), {
    "README.md": "mono\n",
    "services/api/pyproject.toml": "[project]\nname='api'\n",
    "services/api/api.py": "print(1)\n",
    "services/api/vendor/lib.py": "# tracked vendored file\n",
    "tools/native/CMakeLists.txt": "project(x)\n",
    "tools/native/main.c": "int main(){}\n",
  });
  await write(path.join(parent, "mono"), {
    "services/api/__pycache__/api.cpython-312.pyc": "\0".repeat(3000),
    "tools/native/build/CMakeCache.txt": "cache",
    "services/api/vendor/lib2.py": "# untracked vendored file\n",
  });
  // A committed artifact directory: must be flagged, not silently claimed excluded.
  git(["add", "-f", "services/api/__pycache__/api.cpython-312.pyc"], path.join(parent, "mono"));
  git(["commit", "-qm", "oops tracked cache"], path.join(parent, "mono"));

  git(["worktree", "add", "-q", path.join(parent, "crate-wt"), "-b", "wt"], path.join(parent, "crate"));

  await symlink(path.join(parent, "web"), path.join(parent, "loop-link"));
  await symlink(outside, path.join(parent, "escape-link"));
  await write(parent, { "notes/todo.md": "unrelated document\n", "brainstorm.txt": "loose file\n" });
  return parent;
}

test("catalog detects types by marker, suffix and precedence", () => {
  assert.deepEqual(detectTypes(["package.json", "ios"]).map((t) => t.id), ["node-react-native"]);
  assert.deepEqual(detectTypes(["package.json", "turbo.json"]).map((t) => t.id).sort(), ["node", "turborepo"]);
  assert.deepEqual(detectTypes(["App.csproj"]).map((t) => t.id), ["dotnet"]);
  assert.deepEqual(detectTypes(["project.godot", "Game.csproj"]).map((t) => t.id), ["godot"]);
  assert.deepEqual(detectTypes(["CMakeLists.txt"]).flatMap((t) => t.artifacts), ["build", "cmake-build-debug", "cmake-build-release"]);
  assert.ok(PROJECT_TYPES.length >= 24, "Kondo catalog ported");
});

test("path-anchored exclusions apply only under their project path", () => {
  assert.equal(isExcluded("tools/native/build/CMakeCache.txt", ["tools/native/build/"]), true);
  assert.equal(isExcluded("web/build/app.js", ["tools/native/build/"]), false);
  assert.equal(isExcluded("any/where/node_modules/x.js", ["node_modules/"]), true);
});

test("discovers repos, worktrees, nested projects, symlinks and unrelated files without following links", async () => {
  const parent = await fixture();
  const d = await discoverWorkspace(parent);
  assert.equal(d.kind, "folder");
  const byPath = Object.fromEntries(d.projects.map((p) => [p.relPath, p]));
  assert.deepEqual(byPath.web.types, ["node"]);
  assert.deepEqual(byPath.crate.types, ["cargo"]);
  assert.equal(byPath["crate-wt"].kind, "worktree");
  assert.equal(byPath.mono.kind, "repo");
  assert.deepEqual(byPath["mono/services/api"].types, ["python"]);
  assert.equal(byPath["mono/services/api"].repo, "mono");
  assert.deepEqual(byPath["mono/tools/native"].types, ["cmake"]);
  assert.ok(!Object.keys(byPath).some((p) => p.includes("node_modules")), "dependency trees are not projects");
  assert.deepEqual(d.repos.sort(), ["crate", "crate-wt", "mono", "web"]);
  const links = Object.fromEntries(d.symlinks.map((s) => [s.relPath, s.status]));
  assert.equal(links["loop-link"], "kept", "a link to a sibling project stays inside the workspace");
  assert.equal(links["escape-link"], "escapes-root");
  assert.deepEqual(d.unrelated, ["brainstorm.txt", "escape-link", "notes/"]);
});

test("plan applies rules per project type and path, keeps a source dir named build, flags tracked artifacts", async () => {
  const parent = await fixture();
  const plan = await planCapture(parent);
  const web = plan.repos.find((r) => r.relPath === "web");
  const nm = web.rules.find((r) => r.pattern === "node_modules/" && r.source === "catalog");
  assert.ok(nm && nm.bytes >= 5000, "node_modules attributed to the Node rule with bytes");
  assert.ok(!web.rules.some((r) => r.pattern.startsWith("build/")), "Node has no build rule: web/build stays");
  assert.ok(web.includedBytes > 0);

  const mono = plan.repos.find((r) => r.relPath === "mono");
  const cmakeBuild = mono.rules.find((r) => r.pattern === "tools/native/build/");
  assert.ok(cmakeBuild && cmakeBuild.bytes > 0, "CMake build excluded only under tools/native");
  assert.ok(mono.rules.some((r) => r.pattern === "services/api/__pycache__/"), "python rule scoped to the nested project");
  assert.ok(!mono.rules.some((r) => r.pattern === "services/api/vendor/"), "python does not treat vendor as disposable");
  assert.deepEqual(mono.trackedArtifacts, ["services/api/__pycache__"], "committed cache is flagged, not claimed excluded");
  const projectDirs = mono.projects.map((p) => p.relPath).sort();
  assert.deepEqual(projectDirs, [".", "services/api", "tools/native"]);

  assert.ok(plan.conflicts.some((c) => c.includes("escape-link")));
  assert.ok(!plan.conflicts.some((c) => c.includes("loop-link")), "an in-workspace link is not a conflict");
  assert.deepEqual(plan.unrelated, ["brainstorm.txt", "escape-link", "notes/"]);
  assert.ok(plan.totals.excludedBytes >= 5000 + 4000 + 3000 - 3000, "excluded bytes summed across repos");
});

test("per-repo excludes reach dirty-path capture: caches out, tracked-style files in", async () => {
  const parent = await fixture();
  const plan = await planCapture(parent);
  const mono = plan.repos.find((r) => r.relPath === "mono");
  const dirty = dirtyPaths(path.join(parent, "mono"), [], mono.excludes);
  assert.ok(dirty.includes("services/api/vendor/lib2.py"), "untracked vendored source is captured");
  assert.ok(!dirty.some((p) => p.includes("tools/native/build/")), "CMake build dir excluded by the scoped rule");
  assert.ok(!dirty.some((p) => p.includes("__pycache__")), "python cache excluded");
});

test(".ditto include/exclude overrides adjust the plan and record the config digest", async () => {
  const parent = await fixture();
  await write(path.join(parent, "web"), {
    ".ditto/config.toml": "version = 1\n[teleport]\nexclude = ['fixtures/big/']\ninclude = ['node_modules/']\n",
    "fixtures/big/blob.bin": "z".repeat(2000),
  });
  const plan = await planCapture(parent);
  const web = plan.repos.find((r) => r.relPath === "web");
  assert.ok(web.rules.some((r) => r.pattern === "fixtures/big/" && r.source === "config"));
  assert.ok(!web.excludes.includes("node_modules/"), "include forces node_modules back in");
  assert.deepEqual(web.includes, ["node_modules/"]);
  assert.equal(web.dittoConfig.version, 1);
  assert.match(web.dittoConfig.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(web.dittoConfig.layers, ["repo"]);
});

test("invalid .ditto is reported as a conflict, not silently ignored", async () => {
  const parent = await fixture();
  await write(path.join(parent, "web"), { ".ditto/config.toml": "version = 1\n[teleport]\nexclude = ['../etc/']\n" });
  const plan = await planCapture(parent);
  assert.ok(plan.conflicts.some((c) => c.startsWith("web:") && c.includes("must stay inside")));
});

test("offload blockers name unrelated files and escaping symlinks; a clean repo root has none", async () => {
  const parent = await fixture();
  const blockers = await offloadBlockers(await planCapture(parent));
  const paths = blockers.map((b) => b.path).sort();
  assert.deepEqual(paths, ["brainstorm.txt", "escape-link", "notes/"]);
  const solo = await planCapture(path.join(parent, "crate"));
  assert.equal(solo.kind, "repo");
  assert.deepEqual(await offloadBlockers(solo), []);
});
