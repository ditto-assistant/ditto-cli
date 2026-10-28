import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectDir, readClaudeSessionTitle, readTranscript } from "../dist/agents/claude-transcripts.js";
import { watchClaudeSessionTitle } from "../dist/agents/claude-title-sync.js";

const native = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const line = value => JSON.stringify(value) + "\n";
const ai = (title, id = native) => ({type:"ai-title",aiTitle:title,sessionId:id});
const custom = title => ({type:"custom-title",customTitle:title,sessionId:native});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check) {
  const end=Date.now()+5000;
  while(Date.now()<end){if(check())return;await sleep(10);}
  assert.fail("native title observation did not arrive");
}
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),"ditto-native-title-"));
  const original=process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR=path.join(root,"claude");
  const cwd=path.join(root,"repo");await mkdir(cwd);
  const project=claudeProjectDir(cwd);await mkdir(project,{recursive:true});
  const file=path.join(project,`${native}.jsonl`);
  const sidecar=path.join(project,native,"custom-title.json");
  t.after(async()=>{original===undefined?delete process.env.CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR=original;await rm(root,{recursive:true,force:true});});
  return {root,cwd,project,file,sidecar};
}

test("native AI/custom records are UUID-bound and custom sidecar wins",async t=>{
  const f=await fixture(t);
  await writeFile(f.file,line({type:"user",message:{content:"private prompt"}})+line(ai("AI title"))+line(custom("Native rename"))+line(ai("Later AI title")));
  assert.deepEqual(await readClaudeSessionTitle(f.file,native),{nativeSessionId:native,title:"Native rename",titleSource:"claude-custom-title"});
  await mkdir(path.dirname(f.sidecar));await writeFile(f.sidecar,JSON.stringify({customTitle:"Sidecar rename"}));
  assert.equal((await readClaudeSessionTitle(f.file,native)).title,"Sidecar rename");
  assert.equal((await readTranscript(f.file)).title,"Sidecar rename","resume picker shares native precedence");
  await writeFile(f.sidecar,"{");
  await assert.rejects(readClaudeSessionTitle(f.file,native),SyntaxError,"a partial sidecar must not downgrade a custom name");
});

test("other UUIDs, invalid metadata and oversized names cannot rename this session",async t=>{
  const f=await fixture(t);
  await writeFile(f.file,line(ai("Different session",other)));
  assert.equal(await readClaudeSessionTitle(f.file,native),undefined);
  assert.equal(await readClaudeSessionTitle(f.file,other),undefined);
  await writeFile(f.file,line(ai("No numeric ID",123)));
  assert.equal(await readClaudeSessionTitle(f.file,native),undefined);
  for(const title of ["line one\nline two","bad\u0007title","🚀".repeat(161)]){
    await writeFile(f.file,line(ai(title)));
    assert.equal(await readClaudeSessionTitle(f.file,native),undefined);
  }
  await writeFile(f.file,line(ai("🚀".repeat(160))));
  assert.equal(Array.from((await readClaudeSessionTitle(f.file,native)).title).length,160);
});

test("large transcript reads return title metadata without prompt or path fields",async t=>{
  const f=await fixture(t);
  const secret="PRIVATE_PROMPT_CONTENT";
  await writeFile(f.file,line(ai("Early native title"))+line({type:"user",message:{content:secret+"x".repeat(2*1024*1024)}})+line(ai("Latest native title")));
  const value=await readClaudeSessionTitle(f.file,native);
  assert.deepEqual(value,{nativeSessionId:native,title:"Latest native title",titleSource:"claude-ai-title"});
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_PROMPT_CONTENT|jsonl|file/);
  await mkdir(path.dirname(f.sidecar));await writeFile(f.sidecar,"x".repeat(65537));
  await assert.rejects(readClaudeSessionTitle(f.file,native),/read bound/);
});

test("watcher handles late files, deduplicates title changes and stops without another report",async t=>{
  const f=await fixture(t);const reports=[];
  const watcher=watchClaudeSessionTitle({nativeSessionId:native,cwd:f.cwd,intervalMs:10,report:async value=>{reports.push(value);}});
  t.after(()=>watcher.stop());
  await sleep(25);assert.equal(reports.length,0);
  await writeFile(f.file,line(ai("First title")));await eventually(()=>reports.length===1);
  await appendFile(f.file,line({type:"assistant",message:{content:"not a title"}}));
  await sleep(30);assert.equal(reports.length,1);
  await appendFile(f.file,line(ai("Second title")));await eventually(()=>reports.length===2);
  await mkdir(path.dirname(f.sidecar));await writeFile(f.sidecar,JSON.stringify({customTitle:"User native rename"}));await eventually(()=>reports.length===3);
  assert.deepEqual(reports.map(r=>r.title),["First title","Second title","User native rename"]);
  watcher.stop();await writeFile(f.sidecar,JSON.stringify({customTitle:"After stop"}));await sleep(30);
  assert.equal(reports.length,3);
});

test("failed reports retry the latest title, stay serialized, and stop aborts pending work",async t=>{
  const f=await fixture(t);await writeFile(f.file,line(ai("Before failure")));
  const titles=[];let release;let active=0;let maximum=0;let aborted=false;
  const watcher=watchClaudeSessionTitle({nativeSessionId:native,cwd:f.cwd,intervalMs:10,retryBaseMs:40,retryMaxMs:40,report:async(value,signal)=>{
    titles.push(value.title);active++;maximum=Math.max(maximum,active);
    try{
      if(titles.length===1)throw new Error("host binding not ready");
      if(titles.length===2)await new Promise(resolve=>{release=resolve;});
      if(titles.length===3)await new Promise((_,reject)=>signal.addEventListener("abort",()=>{aborted=true;reject(new Error("stopped"));},{once:true}));
    }finally{active--;}
  }});
  t.after(()=>watcher.stop());
  await eventually(()=>titles.length===1);await appendFile(f.file,line(ai("Latest after failure")));
  await eventually(()=>titles.length===2);assert.equal(titles[1],"Latest after failure");
  await appendFile(f.file,line(ai("After in-flight report")));await sleep(25);assert.equal(titles.length,2);
  release();await eventually(()=>titles.length===3);assert.equal(maximum,1);
  watcher.stop();await eventually(()=>aborted);assert.equal(titles[2],"After in-flight report");
});

test("discovery never guesses a neighboring session by cwd or an ambiguous UUID mirror",async t=>{
  const f=await fixture(t);const reports=[];
  await writeFile(path.join(f.project,`${other}.jsonl`),line(ai("Neighbor",other)));
  const projects=path.dirname(f.project);
  for(const dir of ["mirror-a","mirror-b"]){await mkdir(path.join(projects,dir));await writeFile(path.join(projects,dir,`${native}.jsonl`),line(ai("Mirror title")));}
  const watcher=watchClaudeSessionTitle({nativeSessionId:native,cwd:f.cwd,intervalMs:10,discoveryIntervalMs:30,report:async title=>{reports.push(title);}});
  t.after(()=>watcher.stop());
  await sleep(40);assert.equal(reports.length,0);
  await rm(path.join(projects,"mirror-b"),{recursive:true});
  await eventually(()=>reports.length===1);assert.equal(reports[0].title,"Mirror title");
});


test("a head-only title cannot override an unread newer middle title",async t=>{
  const f=await fixture(t);
  const padding=line({type:"user",message:{content:"x".repeat(400000)}});
  await writeFile(f.file,line(ai("Old head title"))+padding+line(ai("Newer middle title"))+padding);
  assert.equal(await readClaudeSessionTitle(f.file,native),undefined);
  // Another session's tail record cannot make this session's stale head safe.
  await appendFile(f.file,line(ai("Other tail title",other)));
  assert.equal(await readClaudeSessionTitle(f.file,native),undefined);
  await mkdir(path.dirname(f.sidecar));await writeFile(f.sidecar,JSON.stringify({customTitle:"Authoritative custom name"}));
  assert.equal((await readClaudeSessionTitle(f.file,native)).title,"Authoritative custom name");
  await rm(f.sidecar);
  await appendFile(f.file,line(ai("Latest tail title")));
  assert.equal((await readClaudeSessionTitle(f.file,native)).title,"Latest tail title");
  await writeFile(f.file,line(custom("Persisted custom name"))+padding+line(ai("Current tail AI")));
  assert.equal((await readClaudeSessionTitle(f.file,native)).title,"Persisted custom name");
});

test("global UUID discovery is throttled while the expected file stays responsive",async t=>{
  const f=await fixture(t);const reports=[];
  const watcher=watchClaudeSessionTitle({nativeSessionId:native,cwd:f.cwd,intervalMs:10,discoveryIntervalMs:1000,report:async value=>{reports.push(value);}});
  t.after(()=>watcher.stop());
  // Let the initial global scan finish before a moved transcript appears.
  await sleep(60);
  const moved=path.join(path.dirname(f.project),"moved");await mkdir(moved);
  await writeFile(path.join(moved,`${native}.jsonl`),line(ai("Moved title")));
  await sleep(70);assert.equal(reports.length,0,"missing transcripts must not rescan every poll");
  await writeFile(f.file,line(ai("Expected title")));
  await eventually(()=>reports.length===1);
  assert.equal(reports[0].title,"Expected title");
});

test("same-size title rewrites with restored mtime are detected",async t=>{
  const f=await fixture(t);const reports=[];
  await writeFile(f.file,line(ai("First name")));
  const fixedTime=new Date(Math.floor(Date.now()/1000)*1000);await utimes(f.file,fixedTime,fixedTime);
  const before=await stat(f.file);
  const watcher=watchClaudeSessionTitle({nativeSessionId:native,cwd:f.cwd,intervalMs:10,refreshIntervalMs:60000,report:async value=>{reports.push(value);}});
  t.after(()=>watcher.stop());await eventually(()=>reports.length===1);
  await writeFile(f.file,line(ai("Other name")));await utimes(f.file,fixedTime,fixedTime);
  const after=await stat(f.file);
  assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
  assert.notEqual(after.ctimeMs,before.ctimeMs,"fixture must exercise ctime change");
  await eventually(()=>reports.length===2);assert.equal(reports[1].title,"Other name");
});

test("unreadable custom sidecars suppress AI reports until custom metadata is valid",async t=>{
  const f=await fixture(t);const reports=[];
  await writeFile(f.file,line(ai("Older AI name")));await mkdir(path.dirname(f.sidecar));
  await writeFile(f.sidecar,"x".repeat(65537));
  const watcher=watchClaudeSessionTitle({nativeSessionId:native,cwd:f.cwd,intervalMs:10,retryBaseMs:10,retryMaxMs:10,report:async value=>{reports.push(value);}});
  t.after(()=>watcher.stop());await sleep(50);assert.equal(reports.length,0);
  await writeFile(f.sidecar,"{");await sleep(50);assert.equal(reports.length,0);
  await writeFile(f.sidecar,JSON.stringify({customTitle:"Recovered custom name"}));
  await eventually(()=>reports.length===1);assert.equal(reports[0].title,"Recovered custom name");
});


test("failed global scans retry on error backoff instead of consuming the scan throttle",{skip:process.platform==="win32"},async t=>{
  const f=await fixture(t);const reports=[];
  const moved=path.join(path.dirname(f.project),"moved");await mkdir(moved);
  const movedFile=path.join(moved,`${native}.jsonl`);
  // ELOOP is deterministic without relying on filesystem permissions/root.
  await symlink(path.basename(movedFile),movedFile);
  await assert.rejects(stat(movedFile),{code:"ELOOP"});
  const watcher=watchClaudeSessionTitle({nativeSessionId:native,cwd:f.cwd,intervalMs:10,discoveryIntervalMs:10000,retryBaseMs:10,retryMaxMs:10,report:async value=>{reports.push(value);}});
  t.after(()=>watcher.stop());await sleep(50);assert.equal(reports.length,0);
  const replacement=path.join(moved,"replacement.tmp");
  await writeFile(replacement,line(ai("Recovered moved title")));
  await rename(replacement,movedFile); // No transient ENOENT scan can consume the throttle.
  await eventually(()=>reports.length===1);
  assert.equal(reports[0].title,"Recovered moved title");
});

test("unscoped tail metadata cannot make a head title fresh across an unread gap",async t=>{
  const f=await fixture(t);
  await writeFile(f.file,line({type:"custom-title",customTitle:"Copied parent name"})+line({type:"user",message:{content:"x".repeat(400000)}})+line({type:"ai-title",aiTitle:"Unscoped tail name"}));
  assert.equal(await readClaudeSessionTitle(f.file,native),undefined);
  await mkdir(path.dirname(f.sidecar));await writeFile(f.sidecar,JSON.stringify({customTitle:"Verified sidecar name"}));
  assert.equal((await readClaudeSessionTitle(f.file,native)).title,"Verified sidecar name");
});
