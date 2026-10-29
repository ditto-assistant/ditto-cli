import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { claudeProjectDir } from "../dist/agents/claude-transcripts.js";
import { ALPHA } from "./helpers/stub-api.mjs";

const native="33333333-3333-4333-8333-333333333333";
const cli=fileURLToPath(new URL("../dist/cli.js",import.meta.url));

test("wrapper title synchronization uses exact registration identity in Router and native modes and stays off for older backends", {skip:process.platform==="win32"}, async t=>{
  for(const [mode,capable,name] of [["router",true],["native",true],["router",false],["native",true,"  My chosen launch name  "]])await t.test(`${mode}, nativeTitleSync=${capable}${name?", explicitly named":""}`,async()=>{
    const titleEnabled=capable&&!name?.trim();
    const root=await mkdtemp(path.join(os.tmpdir(),"ditto-title-launch-"));
    const cwd=path.join(root,"repo");const home=path.join(root,"claude");const bin=path.join(root,"bin");
    await mkdir(cwd);await mkdir(bin);
    const originalHome=process.env.CLAUDE_CONFIG_DIR;process.env.CLAUDE_CONFIG_DIR=home;
    const project=claudeProjectDir(cwd);originalHome===undefined?delete process.env.CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR=originalHome;
    await mkdir(project,{recursive:true});
    await writeFile(path.join(project,`${native}.jsonl`),[{type:"user",sessionId:native,cwd,message:{content:"synthetic"}},{type:"ai-title",aiTitle:"Native metadata title",sessionId:native}].map(JSON.stringify).join("\n")+"\n");
    const rawSession=mode==="native"?"ditto-native-alias":native;
    if(rawSession!==native){
      await mkdir(path.join(root,"config","sessions"),{recursive:true});
      await writeFile(path.join(root,"config","sessions",`${rawSession}.json`),JSON.stringify({id:rawSession,harness:"claude",harnessSessionId:native,endpointId:ALPHA.id,endpointSlug:"alpha",cwd,createdAt:new Date().toISOString(),lastLaunchedAt:new Date().toISOString(),launches:1,mcpOnly:true,remoteTransport:"cli"}));
    }
    const marker=path.join(root,"title-reported");const observed=path.join(root,"claude-observed.json");
    await writeFile(path.join(bin,"claude"),`#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(process.env.TITLE_OBSERVED,JSON.stringify({args:process.argv.slice(2),routerBase:Boolean(process.env.ANTHROPIC_BASE_URL),routerToken:Boolean(process.env.ANTHROPIC_AUTH_TOKEN)})); const end=Date.now()+(${titleEnabled}?10000:2500);const timer=setInterval(()=>{if(fs.existsSync(process.env.TITLE_MARKER)||Date.now()>end){clearInterval(timer);}},20);`,{mode:0o755});
    const calls=[];
    const server=createServer((req,res)=>{
      let raw="";req.on("data",chunk=>raw+=chunk);req.on("end",()=>{
        const body=raw?JSON.parse(raw):undefined;calls.push({method:req.method,url:req.url,body});
        const json=(value,status=200)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
        if(req.url==="/api/v5/inference/endpoints")return json({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,endpoints:[ALPHA]});
        if(req.url==="/api/v5/companies")return json({companies:[]});
        if(req.url==="/v1/mcp")return json({endpoint:ALPHA.id,servers:[],clientApprovals:false,approvalMode:"confirm"});
        if(req.url.endsWith("/keys")&&req.method==="POST")return json({id:"title-key",key:"ditto_inf_synthetic",keyHint:"test"},201);
        if(req.url.endsWith("/keys/title-key")&&req.method==="DELETE"){res.writeHead(204);return res.end();}
        if(req.url==="/api/v5/sessions/register"){
          if(body.titleSource){writeFileSync(marker,"received");return json({threadId:"external:title-fixture",kgID:"",titleUpdated:true});}
          return json({threadId:"external:title-fixture",kgID:"",...(capable?{nativeTitleSync:true}:{})});
        }
        json({},404);
      });
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try{
      const result=await promisify(execFile)(process.execPath,[cli,"claude","--endpoint","alpha","--resume",rawSession,...(name?["--name",name]:[]),...(mode==="native"?["--mcp-only"]:["--no-mcp"])],{cwd,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,DITTO_CONFIG_DIR:path.join(root,"config"),CLAUDE_CONFIG_DIR:home,DITTO_API_BASE:`http://127.0.0.1:${server.address().port}`,DITTO_API_KEY:"ditto_mcp_synthetic",TITLE_MARKER:marker,TITLE_OBSERVED:observed},timeout:15000});
      const titles=calls.filter(c=>c.body?.titleSource);
      assert.equal(titles.length,titleEnabled?1:0,result.stderr);
      if(titleEnabled)assert.deepEqual(titles[0].body,{sessionId:rawSession,endpointId:ALPHA.id,threadId:"external:title-fixture",harness:"claude-code",inference:mode,transport:"cli",nativeSessionId:native,title:"Native metadata title",titleSource:"claude-ai-title"});
      const child=JSON.parse(await readFile(observed,"utf8"));
      assert.ok(child.args.includes(native));
      assert.equal(child.routerBase,mode==="router");assert.equal(child.routerToken,mode==="router");
      const registrations=calls.filter(c=>c.url==="/api/v5/sessions/register"&&!c.body?.titleSource);
      assert.equal(registrations.length,1);
      assert.equal(registrations[0].body.nativeSessionId,native);
      assert.equal(registrations[0].body.sessionId,rawSession);
      if(name){
        assert.equal(registrations[0].body.title,"My chosen launch name");
        const saved=JSON.parse(await readFile(path.join(root,"config","sessions",`${rawSession}.json`),"utf8"));
        assert.equal(saved.explicitLaunchTitle,"My chosen launch name");
        calls.length=0;
        // Resume the persisted record without repeating --name. It remains
        // user-named, and must send no automatic title traffic.
        await promisify(execFile)(process.execPath,[cli,"claude","--endpoint","alpha","--resume",rawSession,"--mcp-only"],{cwd,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,DITTO_CONFIG_DIR:path.join(root,"config"),CLAUDE_CONFIG_DIR:home,DITTO_API_BASE:`http://127.0.0.1:${server.address().port}`,DITTO_API_KEY:"ditto_mcp_synthetic",TITLE_MARKER:marker,TITLE_OBSERVED:observed},timeout:15000});
        assert.equal(calls.filter(c=>c.body?.titleSource).length,0,"saved explicit name must survive a plain resume");
        assert.equal(calls.find(c=>c.url==="/api/v5/sessions/register").body.title,"My chosen launch name");
        assert.equal(JSON.parse(await readFile(path.join(root,"config","sessions",`${rawSession}.json`),"utf8")).explicitLaunchTitle,"My chosen launch name");
      }
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
  });
});
