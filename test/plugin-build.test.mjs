import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { npmInstallInvocation, readGitProvenance, verifyRuntimeArchive } from "../scripts/remote-plugin-build-utils.mjs";

test("Windows npm installation launches JavaScript through Node, not npm.cmd or a shell", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const entry = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const invocation = npmInstallInvocation({node, platform:"win32", npmCLI:"C:\\unrelated\\npm.cmd", fileExists:file=>file===entry});
  assert.equal(invocation.command,node);
  assert.equal(invocation.args[0],entry);
  assert.deepEqual(invocation.args.slice(1),["ci","--omit=dev","--omit=optional","--ignore-scripts","--no-audit","--no-fund"]);
  assert.throws(()=>npmInstallInvocation({node,platform:"win32",npmCLI:undefined,fileExists:()=>false}),/npm run plugin:build/);
});

test("npm invocation executes with spaces and shell metacharacters in the path", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"ditto-plugin-npm-"));
  try {
    const folder=path.join(root,"npm with spaces & semicolon;");
    await mkdir(folder);
    const entry=path.join(folder,"npm-cli.js");
    await writeFile(entry,"process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const invocation=npmInstallInvocation({npmCLI:entry});
    const child=spawnSync(invocation.command,invocation.args,{cwd:root,encoding:"utf8"});
    assert.ifError(child.error);
    assert.equal(child.status,0,child.stderr);
    assert.deepEqual(JSON.parse(child.stdout),["ci","--omit=dev","--omit=optional","--ignore-scripts","--no-audit","--no-fund"]);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("provenance requires successful Git revision and status reads", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"ditto-plugin-git-"));
  const git=(...args)=>{
    const result=spawnSync("git",args,{cwd:root,encoding:"utf8"});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  try {
    assert.throws(()=>readGitProvenance(root),/git rev-parse failed/);
    git("init","--initial-branch=main");
    assert.throws(()=>readGitProvenance(root),/git rev-parse failed/);
    git("-c","user.name=Plugin QA","-c","user.email=qa@example.invalid","commit","--allow-empty","-m","fixture");
    assert.deepEqual(readGitProvenance(root),{sourceRevision:git("rev-parse","HEAD"),dirty:false});
    await writeFile(path.join(root,"untracked.txt"),"change");
    assert.equal(readGitProvenance(root).dirty,true);
    await writeFile(path.join(root,".git","index"),Buffer.of(0));
    assert.throws(()=>readGitProvenance(root),/git status failed/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("archive verification rejects modified bytes and either incorrect digest", () => {
  const bytes=Buffer.from("canonical fixture");
  const pin={sha256:createHash("sha256").update(bytes).digest("hex"),integrity:`sha512-${createHash("sha512").update(bytes).digest("base64")}`};
  verifyRuntimeArchive(bytes,pin);
  assert.throws(()=>verifyRuntimeArchive(Buffer.from("modified fixture"),pin),/pinned canonical/);
  assert.throws(()=>verifyRuntimeArchive(bytes,{...pin,sha256:"0".repeat(64)}),/pinned canonical/);
  assert.throws(()=>verifyRuntimeArchive(bytes,{...pin,integrity:"sha512-invalid"}),/pinned canonical/);
});

test("builder verifies the canonical archive and retains its runtime while overlaying pairing only", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"ditto-plugin-builder-"));
  const source=new URL("../",import.meta.url);
  const {cp,symlink,access}=await import("node:fs/promises");
  const git=(...args)=>{
    const r=spawnSync("git",args,{cwd:root,encoding:"utf8"});
    assert.ifError(r.error);assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  try {
    await mkdir(path.join(root,"scripts"));
    for(const name of ["build-remote-plugin.mjs","remote-plugin-build-utils.mjs"]) await cp(new URL(`scripts/${name}`,source),path.join(root,"scripts",name));
    await symlink(new URL("node_modules",source),path.join(root,"node_modules"),"dir");
    await writeFile(path.join(root,".gitignore"),".tmp/\nnode_modules/\n");
    await mkdir(path.join(root,".tmp","package","dist","remote"),{recursive:true});
    const pkg={name:"@heyditto/cli",version:"1.2.3",type:"module",engines:{node:">=22"}};
    const lock=JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{"":{name:pkg.name,version:pkg.version}}});
    await writeFile(path.join(root,"package-lock.json"),lock);
    await writeFile(path.join(root,".tmp","package","package.json"),JSON.stringify(pkg));
    await writeFile(path.join(root,".tmp","package","dist","channel-server.js"),"// canonical channel runtime");
    const archive=path.join(root,".tmp","runtime.tgz");
    const {c}=await import("tar");await c({gzip:true,file:archive,cwd:path.join(root,".tmp")},["package"]);
    const bytes=await readFile(archive);
    const template=path.join(root,"plugins","ditto-remote");
    await mkdir(path.join(template,".claude-plugin"),{recursive:true});
    await writeFile(path.join(template,".claude-plugin","plugin.json"),JSON.stringify({name:"ditto-remote",description:"fixture"}));
    const pin={version:pkg.version,sha256:createHash("sha256").update(bytes).digest("hex"),integrity:`sha512-${createHash("sha512").update(bytes).digest("base64")}`,dependencyLockSHA256:createHash("sha256").update(lock).digest("hex")};
    await writeFile(path.join(template,"runtime-release.json"),JSON.stringify(pin));
    await mkdir(path.join(root,"dist","remote"),{recursive:true});
    for(const name of ["plugin-server","session-link"]) for(const suffix of ["js","js.map","d.ts"]) await writeFile(path.join(root,"dist","remote",`${name}.${suffix}`),`// pairing ${name}.${suffix}`);
    const npmEntry=path.join(root,"scripts","npm-cli.js");
    await writeFile(npmEntry,"import {writeFileSync} from 'node:fs'; writeFileSync(process.env.DITTO_PLUGIN_MARKER,JSON.stringify(process.argv.slice(2)));");
    const marker=path.join(root,".tmp","npm-args.json");
    const execute=target=>spawnSync(process.execPath,[path.join(root,"scripts","build-remote-plugin.mjs"),target,archive],{cwd:root,encoding:"utf8",env:{...process.env,npm_execpath:npmEntry,DITTO_PLUGIN_MARKER:marker}});
    const target=path.join(root,".tmp","bundle");
    assert.match(execute(target).stderr,/Cannot establish plugin source provenance/);
    await assert.rejects(access(target));
    git("init","--initial-branch=main");git("add",".");git("-c","user.name=Plugin QA","-c","user.email=qa@example.invalid","commit","-m","fixture");
    const success=execute(target);assert.equal(success.status,0,success.stderr);
    assert.equal(await readFile(path.join(target,"runtime","dist","channel-server.js"),"utf8"),"// canonical channel runtime");
    assert.equal(await readFile(path.join(target,"runtime","dist","remote","plugin-server.js"),"utf8"),"// pairing plugin-server.js");
    const build=JSON.parse(await readFile(path.join(target,"BUILD.json"),"utf8"));assert.equal(build.sourceRevision,git("rev-parse","HEAD"));assert.equal(build.dirty,false);assert.equal(build.overlays.length,6);
    assert.deepEqual(JSON.parse(await readFile(marker,"utf8")),["ci","--omit=dev","--omit=optional","--ignore-scripts","--no-audit","--no-fund"]);
    assert.notEqual(execute(target).status,0,"existing bundles cannot be replaced");
    await writeFile(archive,Buffer.from("tampered"));
    const badTarget=path.join(root,".tmp","bad-bundle");assert.match(execute(badTarget).stderr,/pinned canonical/);await assert.rejects(access(badTarget));
  } finally {await rm(root,{recursive:true,force:true});}
});
