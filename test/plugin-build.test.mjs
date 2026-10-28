import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { npmInstallInvocation, readGitProvenance } from "../scripts/remote-plugin-build-utils.mjs";

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

test("the bundle builder uses npm-cli.js and refuses unprovable source before writing output", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"ditto-plugin-builder-"));
  const source=new URL("../scripts/",import.meta.url);
  const {cp,access}=await import("node:fs/promises");
  try {
    await mkdir(path.join(root,"scripts"));
    for(const name of ["build-remote-plugin.mjs","remote-plugin-build-utils.mjs"]) await cp(new URL(name,source),path.join(root,"scripts",name));
    const pkg={name:"@heyditto/cli",version:"1.2.3",type:"module",engines:{node:">=22"}};
    await writeFile(path.join(root,"package.json"),JSON.stringify(pkg));
    await writeFile(path.join(root,"package-lock.json"),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{"":{name:pkg.name,version:pkg.version}}}));
    await writeFile(path.join(root,"LICENSE"),"MIT fixture");
    await writeFile(path.join(root,".gitignore"),".tmp/\n");
    await mkdir(path.join(root,"plugins","ditto-remote",".claude-plugin"),{recursive:true});
    await writeFile(path.join(root,"plugins","ditto-remote",".claude-plugin","plugin.json"),JSON.stringify({name:"ditto-remote",description:"fixture"}));
    await mkdir(path.join(root,"dist"));
    await writeFile(path.join(root,"dist","index.js"),"// compiled fixture");
    await mkdir(path.join(root,"npm folder with spaces"));
    const npmEntry=path.join(root,"npm folder with spaces","npm-cli.js");
    await writeFile(npmEntry,"import {writeFileSync} from 'node:fs'; writeFileSync(process.env.DITTO_PLUGIN_MARKER,JSON.stringify(process.argv.slice(2)));");
    const target=path.join(root,".tmp","bundle");
    const marker=path.join(root,".tmp","npm-args.json");
    const execute=()=>spawnSync(process.execPath,[path.join(root,"scripts","build-remote-plugin.mjs"),target],{cwd:root,encoding:"utf8",env:{...process.env,npm_execpath:npmEntry,DITTO_PLUGIN_MARKER:marker}});
    const missing=execute();
    assert.notEqual(missing.status,0);
    assert.match(missing.stderr,/Cannot establish plugin source provenance/);
    await assert.rejects(access(target));
    const git=(...args)=>{
      const result=spawnSync("git",args,{cwd:root,encoding:"utf8"});
      assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout.trim();
    };
    git("init","--initial-branch=main");git("add",".");
    git("-c","user.name=Plugin QA","-c","user.email=qa@example.invalid","commit","-m","fixture");
    const success=execute();
    assert.ifError(success.error);assert.equal(success.status,0,success.stderr);
    assert.deepEqual(JSON.parse(await readFile(marker,"utf8")),["ci","--omit=dev","--omit=optional","--ignore-scripts","--no-audit","--no-fund"]);
    const build=JSON.parse(await readFile(path.join(target,"BUILD.json"),"utf8"));
    assert.equal(build.sourceRevision,git("rev-parse","HEAD"));assert.equal(build.dirty,false);
  } finally {await rm(root,{recursive:true,force:true});}
});
